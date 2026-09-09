import test from 'node:test'
import assert from 'node:assert/strict'

import { staleTeamTurnTranscriptPrefixBytes } from '../daemon/claude-transcript.mjs'

const record = (type, text) => JSON.stringify({
  type,
  message: { content: [{ type: 'text', text }] },
}) + '\n'

test('a discarded Claude final advances only to the next team generation boundary', () => {
  const oldFinal = record('assistant', 'Generation one final.')
  const nextPrompt = record('user', [
    '<sab-team-message task="task_one" generation="2" source="coordinator">',
    'Continue with the runtime proof.',
    '</sab-team-message>',
  ].join('\n'))
  const nextFinal = record('assistant', 'Generation two final.')
  const transcript = oldFinal + nextPrompt + nextFinal

  assert.equal(staleTeamTurnTranscriptPrefixBytes(transcript, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }), Buffer.byteLength(oldFinal))
})

test('a discarded Claude final consumes every complete line when no newer generation exists', () => {
  const transcript = record('assistant', 'Generation one final.') + '{"partial":'
  assert.equal(staleTeamTurnTranscriptPrefixBytes(transcript, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }), Buffer.byteLength(record('assistant', 'Generation one final.')))
})
