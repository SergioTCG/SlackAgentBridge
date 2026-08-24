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
  postMessage = (channel, text) => web.chat.postMessage({ channel, text }),
} = {}) {
  const entries = new Map()

  const entryFor = sid => {
    let entry = entries.get(sid)
    if (!entry) {
      entry = { ts: null, text: '', queue: Promise.resolve() }
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
    return serialize(session.id, async current => {
      current.text = desiredText
      try {
        if (current.ts) {
          await web.chat.update({ channel: session.channel, ts: current.ts, text: current.text })
        } else {
          const posted = await postMessage(session.channel, current.text)
          current.ts = posted.ts
        }
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
    return serialize(session.id, async current => {
      const oldTs = current.ts
      if (!oldTs || !current.text) return false
      if (afterTs && isNewerOrEqual(oldTs, afterTs)) return false

      let replacement
      try {
        replacement = await postMessage(session.channel, current.text)
        if (!replacement?.ts) throw new Error('Slack did not return a status timestamp')
      } catch (error) {
        log('bumpStatus post error:', error?.data?.error || String(error))
        return false
      }

      try {
        await web.chat.delete({ channel: session.channel, ts: oldTs })
      } catch (error) {
        if (error?.data?.error !== 'message_not_found') {
          // Keep the old authoritative status if replacement could not be made
          // atomic. Best-effort cleanup avoids leaving two live status lines.
          try { await web.chat.delete({ channel: session.channel, ts: replacement.ts }) } catch {}
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
    return serialize(session.id, async current => {
      const ts = current.ts
      current.ts = null
      current.text = ''
      if (!session.channel || !ts) return false
      try { await web.chat.delete({ channel: session.channel, ts }) } catch {}
      return true
    })
  }

  function adopt(sid, ts) {
    if (!sid || !ts) return
    entryFor(sid).ts = ts
  }

  return { set, bump, clear, adopt }
}
