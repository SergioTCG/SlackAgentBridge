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

// Return the complete-line byte prefix belonging to an older Claude team turn.
// A newer coordinator generation is an immutable boundary: its prompt and all
// subsequent assistant records must remain available to that generation's
// finalizer even when the older Stop hook finishes settling later.
export function staleTeamTurnTranscriptPrefixBytes(text, expected) {
  const input = String(text || '')
  const taskId = String(expected?.taskId || '')
  const generation = Number(expected?.providerWorkGeneration)
  if (!taskId || !Number.isSafeInteger(generation) || generation < 1) return 0
  let cursor = 0
  while (cursor < input.length) {
    const newline = input.indexOf('\n', cursor)
    if (newline < 0) break
    const completeLine = input.slice(cursor, newline)
    let record = null
    try { record = JSON.parse(completeLine) } catch {}
    if (record?.type === 'user') {
      const marker = providerPromptTurnMarker(transcriptMessageText(record))
      if (marker && (marker.taskId !== taskId ||
          (Number.isSafeInteger(marker.providerWorkGeneration) &&
            marker.providerWorkGeneration > generation))) {
        return Buffer.byteLength(input.slice(0, cursor), 'utf8')
      }
    }
    cursor = newline + 1
  }
  return Buffer.byteLength(input.slice(0, cursor), 'utf8')
}
