import fs from 'node:fs'
import { isPeerMessagePrompt, isProviderInternalPrompt } from './providers.mjs'
import { providerPromptTurnMarker } from './team-provider-turn.mjs'

function transcriptMessageText(record) {
  const content = record?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(item => {
    if (typeof item === 'string') return item
    if (item?.type === 'text') return String(item.text || '')
    return ''
  }).filter(Boolean).join('\n')
}

// A task envelope marks a delivery only in a prompt the bridge submitted. Claude Code's
// own records can quote one without being one: a meta record holds a subagent's or another
// session's message in full, a notification can quote team output, and a compact summary
// can quote the conversation. This refuses what the prompt hook refuses and leaves the rest
// alone, so a new delivery wrapper can't hide a real boundary. A prompt that reaches a busy
// session is recorded when Claude Code drains it, as a queued command, not as a user record.
function submittedPromptText(record) {
  if (record?.type === 'user') {
    return record.isMeta === true || record.isCompactSummary === true ? '' : transcriptMessageText(record)
  }
  const attachment = record?.type === 'attachment' ? record.attachment : null
  if (attachment?.type !== 'queued_command' || attachment.isMeta === true) return ''
  return transcriptMessageText({ message: { content: attachment.prompt } })
}

function deliveredTeamTurnMarker(record) {
  const text = submittedPromptText(record)
  if (!text || isProviderInternalPrompt('claude', text) || isPeerMessagePrompt('claude', text)) return null
  return providerPromptTurnMarker(text)
}

function sameTeamTurn(marker, expected) {
  const taskId = String(expected?.taskId || '')
  const generation = Number(expected?.providerWorkGeneration)
  if (!marker || !taskId || !Number.isSafeInteger(generation) || generation < 1) return false
  return marker.taskId === taskId &&
    (marker.providerWorkGeneration === generation ||
      (marker.providerWorkGeneration == null && generation === 1))
}

// Select assistant text from one exact task generation. The returned byte count
// includes any stale complete-line prefix before that generation, but stops at
// the next task marker. This lets the current finalizer retire older output
// without ever attributing it to the current task report.
export function teamTurnAssistantTranscript(text, expected, offsetTurn = null) {
  const input = String(text || '')
  let cursor = 0
  let collecting = sameTeamTurn(offsetTurn, expected)
  let matched = collecting
  let promptObservedAt = Number.isSafeInteger(Number(offsetTurn?.observedAt))
    ? Number(offsetTurn.observedAt) : null
  const output = []
  while (cursor < input.length) {
    const newline = input.indexOf('\n', cursor)
    if (newline < 0) break
    const completeLine = input.slice(cursor, newline)
    let record = null
    try { record = JSON.parse(completeLine) } catch {}
    const marker = deliveredTeamTurnMarker(record)
    if (marker) {
      if (collecting && !sameTeamTurn(marker, expected)) {
        return {
          text: output.join('\n\n'),
          consumedBytes: Buffer.byteLength(input.slice(0, cursor), 'utf8'),
          ...(promptObservedAt ? { promptObservedAt } : {}),
        }
      }
      collecting = sameTeamTurn(marker, expected)
      matched ||= collecting
      if (collecting) {
        const timestamp = Date.parse(String(record.timestamp || ''))
        if (Number.isFinite(timestamp)) promptObservedAt = timestamp
      }
    } else if (collecting && record?.type === 'assistant') {
      const assistant = transcriptMessageText(record).trim()
      if (assistant) output.push(assistant)
    }
    cursor = newline + 1
  }
  if (!matched) return null
  return {
    text: output.join('\n\n'),
    consumedBytes: Buffer.byteLength(input.slice(0, cursor), 'utf8'),
    ...(promptObservedAt ? { promptObservedAt } : {}),
  }
}

// Return the complete-line byte prefix belonging to an older Claude team turn.
// A newer coordinator generation is an immutable boundary: its prompt and all
// subsequent assistant records must remain available to that generation's
// finalizer even when the older Stop hook finishes settling later.
export function staleTeamTurnTranscriptPrefixBytes(text, expected, offsetTurn = null) {
  const input = String(text || '')
  const taskId = String(expected?.taskId || '')
  const generation = Number(expected?.providerWorkGeneration)
  if (!taskId || !Number.isSafeInteger(generation) || generation < 1) return 0
  // A generation-bound streaming read may already have consumed the newer
  // prompt marker. The durable offset fingerprint is then stronger than the
  // marker-less unread suffix: an older Stop must leave those bytes untouched.
  if (offsetTurn && !sameTeamTurn(offsetTurn, expected)) return 0
  let cursor = 0
  while (cursor < input.length) {
    const newline = input.indexOf('\n', cursor)
    if (newline < 0) break
    const completeLine = input.slice(cursor, newline)
    let record = null
    try { record = JSON.parse(completeLine) } catch {}
    const marker = deliveredTeamTurnMarker(record)
    if (marker && (marker.taskId !== taskId ||
        (Number.isSafeInteger(marker.providerWorkGeneration) &&
          marker.providerWorkGeneration > generation))) {
      return Buffer.byteLength(input.slice(0, cursor), 'utf8')
    }
    cursor = newline + 1
  }
  return Buffer.byteLength(input.slice(0, cursor), 'utf8')
}

// Reads assistant text written since session.offset. Only COMPLETE lines are
// parsed, so a record being flushed is never cut in half. Poller failure
// detection peeks without advancing; final delivery advances atomically.
export function claudeAssistantTextSinceOffset(session, advance = false, expectedTeamTurn = null) {
  const f = session.transcript
  if (!f || !fs.existsSync(f)) return ''
  const size = fs.statSync(f).size
  const from = session.offset || 0
  if (size <= from) return ''
  const fd = fs.openSync(f, 'r')
  const buf = Buffer.alloc(size - from)
  fs.readSync(fd, buf, 0, buf.length, from)
  fs.closeSync(fd)
  const str = buf.toString('utf8')
  const lastNl = str.lastIndexOf('\n')
  if (lastNl < 0) return '' // no complete line yet; wait for more
  const complete = str.slice(0, lastNl + 1)
  if (expectedTeamTurn) {
    const selected = teamTurnAssistantTranscript(
      complete, expectedTeamTurn, session.claudeTranscriptOffsetTurn,
    )
    if (selected) {
      if (advance) {
        session.offset = from + selected.consumedBytes
        session.claudeTranscriptOffsetTurn = {
          taskId: expectedTeamTurn.taskId,
          providerWorkGeneration: expectedTeamTurn.providerWorkGeneration,
        }
      }
      return selected.text
    }
    // A persisted different-generation boundary means the exact marker for
    // this final has not entered the unread suffix yet. Do not fall back to an
    // unbounded read which could attribute another generation's output.
    if (session.claudeTranscriptOffsetTurn) return ''
  }
  if (advance) session.offset = from + Buffer.byteLength(str.slice(0, lastNl + 1), 'utf8')
  const out = []
  for (const line of str.slice(0, lastNl).split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type !== 'assistant' || !rec.message?.content) continue
    for (const c of rec.message.content) {
      if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim())
    }
  }
  return out.join('\n\n')
}
