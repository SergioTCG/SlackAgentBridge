// Slack message timestamps are immutable, so editing a working-status message
// cannot move it below newer channel activity. This owner serializes all status
// mutations per session and can transactionally replace the message when it
// needs to become the newest item again.

const isNewerOrEqual = (left, right) => {
  const a = Number(left)
  const b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) && a >= b
}

const slackTimestampMs = value => {
  const milliseconds = Number(value) * 1000
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null
}

function codexStatusElapsedMs(text) {
  const match = String(text || '').match(
    /Codex is working(?:…|\.\.\.)\s*\(\s*(?:(\d+)h\s+)?(?:(\d+)m\s+)?(\d+)s\b/i,
  )
  if (!match) return null
  return ((Number(match[1] || 0) * 3600) + (Number(match[2] || 0) * 60) + Number(match[3])) * 1000
}

// Older bridge versions could lose the persisted turn timestamp while leaving
// a live Codex process untouched. Prefer the durable timestamp, then reconstruct
// it from the last edited Slack timer. If that timer belongs to an older turn,
// the latest accepted human prompt is the safest lower-bound fallback.
export function recoverCodexTurnStartedAt({
  persistedStartedAt = null,
  statusMessage = null,
  latestPromptTs = null,
  now = Date.now(),
} = {}) {
  const persisted = Number(persistedStartedAt)
  if (Number.isFinite(persisted) && persisted > 0) return persisted

  const promptAt = slackTimestampMs(latestPromptTs)
  const elapsed = codexStatusElapsedMs(statusMessage?.text)
  const statusObservedAt = slackTimestampMs(statusMessage?.edited?.ts || statusMessage?.ts)
  if (elapsed !== null && statusObservedAt && (!promptAt || statusObservedAt >= promptAt)) {
    const inferred = statusObservedAt - elapsed
    if (inferred > 0) return Math.min(inferred, now)
  }
  if (promptAt) return Math.min(promptAt, now)
  return now
}

export function createStatusMessages(web, {
  log = () => {},
  postMessage = (channel, text, { valid = null } = {}) =>
    valid && !valid() ? null : web.chat.postMessage({ channel, text }),
  // Slack rate limits chat.update across the workspace, not just per channel.
  // Keep one bounded FIFO for every status mutation while retaining the
  // per-session ordering below. Tests and callers may set this to zero.
  minIntervalMs = 0,
} = {}) {
  const entries = new Map()
  const apiQueues = { priority: [], normal: [] }
  let apiRunning = false
  let lastApiAt = 0
  const SKIPPED = Symbol('status mutation superseded')

  const scheduleApi = (action, { priority = false, valid = null } = {}) => new Promise((resolve, reject) => {
    apiQueues[priority ? 'priority' : 'normal'].push({ action, resolve, reject, valid })
    if (apiRunning) return
    apiRunning = true
    ;(async () => {
      try {
        while (apiQueues.priority.length || apiQueues.normal.length) {
          // Resolve invalidated edits across the whole normal queue before
          // choosing the next API call. Their per-session continuations may
          // enqueue a priority clear, which must win over unrelated updates.
          for (let index = apiQueues.normal.length - 1; index >= 0; index--) {
            const queued = apiQueues.normal[index]
            if (!queued.valid || queued.valid()) continue
            apiQueues.normal.splice(index, 1)
            queued.resolve(SKIPPED)
          }
          // Let the invalidated per-session promise chain finish. It may now
          // enqueue a priority clear; yielding one event-loop turn guarantees
          // that cleanup is visible before we select unrelated cosmetic work.
          await new Promise(resolve => setImmediate(resolve))
          const item = apiQueues.priority.shift() || apiQueues.normal.shift()
          if (!item) continue
          if (item.valid && !item.valid()) { item.resolve(SKIPPED); continue }
          const wait = Math.max(0, Number(minIntervalMs) || 0) - (Date.now() - lastApiAt)
          if (wait > 0) await new Promise(done => setTimeout(done, wait))
          // A clear may have invalidated a cosmetic edit while it waited for
          // the workspace budget. Drop it without consuming another API slot.
          if (item.valid && !item.valid()) { item.resolve(SKIPPED); continue }
          lastApiAt = Date.now()
          try { item.resolve(await item.action()) }
          catch (error) { item.reject(error) }
        }
      } finally {
        apiRunning = false
      }
    })()
  })

  const entryFor = sid => {
    let entry = entries.get(sid)
    if (!entry) {
      entry = { ts: null, text: '', desiredText: '', setRevision: 0, epoch: 0, queue: Promise.resolve() }
      entries.set(sid, entry)
    }
    return entry
  }

  const serialize = (sid, action) => {
    const entry = entryFor(sid)
    const queued = entry.queue.catch(() => {}).then(() => action(entry))
    entry.queue = queued
    return queued
  }

  async function set(session, text) {
    if (!session?.id || !session.channel) return false
    const desiredText = String(text || '')
    const entry = entryFor(session.id)
    entry.desiredText = desiredText
    const revision = ++entry.setRevision
    return serialize(session.id, async current => {
      // The poller can tick faster than Slack's workspace-wide API budget.
      // Drop superseded edits before they enter the API queue; only the newest
      // text for this session is ever sent.
      const valid = () => current.setRevision === revision && current.desiredText === desiredText
      if (!valid()) return true
      try {
        if (current.ts) {
          const result = await scheduleApi(
            () => web.chat.update({ channel: session.channel, ts: current.ts, text: desiredText }),
            { valid },
          )
          if (result === SKIPPED) return true
        } else {
          const posted = await scheduleApi(() => postMessage(session.channel, desiredText, { valid }), { valid })
          if (posted === SKIPPED) return true
          if (!posted?.ts && !valid()) return true
          if (!posted?.ts) throw new Error('Slack did not return a status timestamp')
          current.ts = posted.ts
        }
        current.text = desiredText
        return true
      } catch (error) {
        if (error?.data?.error === 'message_not_found') current.ts = null
        else log('setStatus error:', error?.data?.error || String(error))
        return false
      }
    })
  }

  async function bump(session, { afterTs = null } = {}) {
    if (!session?.id || !session.channel) return false
    const entry = entryFor(session.id)
    const epoch = entry.epoch
    return serialize(session.id, async current => {
      if (current.epoch !== epoch || !current.desiredText) return false
      const oldTs = current.ts
      if (!oldTs || !current.text) return false
      if (afterTs && isNewerOrEqual(oldTs, afterTs)) return false
      const valid = () => current.epoch === epoch && current.ts === oldTs && Boolean(current.desiredText)

      let replacement
      try {
        replacement = await scheduleApi(
          () => postMessage(session.channel, current.text, { valid }),
          { valid },
        )
        if (replacement === SKIPPED || (!replacement?.ts && !valid())) return false
        if (!replacement?.ts) throw new Error('Slack did not return a status timestamp')
        if (!valid()) {
          // The post crossed the API boundary just as the turn completed. It
          // never becomes authoritative; remove it before allowing the queued
          // clear to delete the original status message.
          try {
            await scheduleApi(() => web.chat.delete({ channel: session.channel, ts: replacement.ts }), { priority: true })
          } catch {}
          return false
        }
      } catch (error) {
        log('bumpStatus post error:', error?.data?.error || String(error))
        return false
      }

      try {
        await scheduleApi(() => web.chat.delete({ channel: session.channel, ts: oldTs }))
      } catch (error) {
        if (error?.data?.error !== 'message_not_found') {
          // Keep the old authoritative status if replacement could not be made
          // atomic. Best-effort cleanup avoids leaving two live status lines.
          try { await scheduleApi(() => web.chat.delete({ channel: session.channel, ts: replacement.ts })) } catch {}
          log('bumpStatus delete error:', error?.data?.error || String(error))
          return false
        }
      }
      current.ts = replacement.ts
      return true
    })
  }

  async function clear(session) {
    if (!session?.id) return false
    const entry = entryFor(session.id)
    // Invalidate queued edits immediately. Their global queue entries test the
    // revision again immediately before Slack I/O, so an ended turn cannot
    // continue consuming rate-limit budget while its delete waits behind it.
    entry.desiredText = ''
    entry.setRevision++
    entry.epoch++
    const previous = entry.queue.catch(() => {})
    // Do not put an action which awaits `previous` into the global queue:
    // `previous` may be a bump between its replacement post and old-message
    // delete, and that second operation needs the same queue. Enqueue the
    // priority clear only after this session's prior mutation has settled.
    const clearing = previous.then(() => scheduleApi(async () => {
      const ts = entry.ts
      entry.ts = null
      entry.text = ''
      if (!session.channel || !ts) return false
      try { await web.chat.delete({ channel: session.channel, ts }) } catch {}
      return true
    }, { priority: true }))
    entry.queue = clearing
    return clearing
  }

  function adopt(sid, ts) {
    if (!sid || !ts) return
    entryFor(sid).ts = ts
  }

  const snapshot = () => ({
    active: apiRunning,
    normal: apiQueues.normal.length,
    priority: apiQueues.priority.length,
    sessions: entries.size,
  })

  return { set, bump, clear, adopt, snapshot }
}
