// Visible Slack cards for a team task's delegated instruction. The instruction
// is posted in full with chat.postMessage when the task is created. A queued
// replacement must update both cards before the task may be dispatched.

// Slack rejects chat.update text above roughly 4,000 characters with
// `msg_too_long`, although chat.postMessage accepts the same card. A longer
// revision is therefore posted as its own card, and the original card points
// to it.
export const SLACK_UPDATE_TEXT_MAX = 3500
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 30 * 60_000

export function teamTaskPayloadText(task, destination) {
  const direction = destination === 'source'
    ? `➡️ Delegated to <#${task.targetChannel}> (\`${task.targetAlias}\`)`
    : `⬅️ Delegated by <#${task.sourceChannel}>`
  const files = task.files?.length
    ? `\n\n*Files*\n${task.files.map(file => `• \`${String(file.filename).replace(/`/g, "'")}\` · ${file.size} bytes`).join('\n')}`
    : ''
  return `📋 *Team task* \`${task.id}\`\n${direction}\n\n${task.instruction || task.text || '_File-only task._'}${files}`
}

function revisedCardText(task, instructionVersion) {
  return `📋 *Team task* \`${task.id}\`\nThe instruction was revised (revision ${instructionVersion}). ` +
    'It is too long to edit here, so the full revision is posted as a new card below.'
}

// `update(channel, ts, text)` edits a card, `post(channel, payload)` posts one,
// and `persist()` saves state. A failing task backs off exponentially so that
// a permanent Slack error is retried rarely instead of on every sweep.
export function createPayloadAuditUpdater({ update, post, clientId, persist, log = () => {}, now = Date.now }) {
  const retry = new Map()
  return async function updatePayloadAudit(task) {
    // Record exactly the revision rendered below. A newer replacement remains
    // unaudited until its own serialized update completes, so dispatch cannot
    // cross a mixed-card intermediate state.
    const instructionVersion = Math.max(1, Number(task.instructionVersion) || 1)
    // A new revision is attempted at once; the same failing one waits.
    const backoff = retry.get(task.id)?.version === instructionVersion ? retry.get(task.id) : null
    if (backoff && now() < backoff.nextAt) return false
    let failure = null
    for (const side of ['source', 'target']) {
      const channel = side === 'source' ? task.sourceChannel : task.targetChannel
      const ts = side === 'source' ? task.sourcePayloadSlackTs : task.targetPayloadSlackTs
      if (!ts) {
        failure ||= new Error(`The ${side} task instruction card does not exist yet.`)
        continue
      }
      const text = teamTaskPayloadText(task, side)
      try {
        if (text.length <= SLACK_UPDATE_TEXT_MAX) {
          try {
            await update(channel, ts, text)
            continue
          } catch (error) {
            if (error?.data?.error !== 'msg_too_long') throw error
          }
        }
        // Post each oversized revision once per card, even when the pointer
        // edit below has to be retried.
        const revisions = task.payloadRevisionCards ||= {}
        if (revisions[side]?.version !== instructionVersion || !revisions[side]?.ts) {
          const posted = await post(channel, {
            text, unfurl_links: false, client_msg_id: clientId(task, `${side}-payload-v${instructionVersion}`),
          })
          revisions[side] = { version: instructionVersion, ts: posted?.ts || null }
          persist()
        }
        await update(channel, ts, revisedCardText(task, instructionVersion))
      } catch (error) {
        failure ||= error
        log('team payload audit update failed', task.id, channel, error?.data?.error || String(error))
      }
    }
    if (failure) {
      const failures = (backoff?.failures || 0) + 1
      retry.set(task.id, {
        version: instructionVersion, failures,
        nextAt: now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS),
      })
      return false
    }
    retry.delete(task.id)
    task.payloadAuditInstructionVersion = instructionVersion
    persist()
    return true
  }
}
