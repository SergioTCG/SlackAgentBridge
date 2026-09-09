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

test('a newly assigned task is also a stale transcript boundary', () => {
  const oldFinal = record('assistant', 'First task final.')
  const nextPrompt = record('user', [
    '<sab-team-task id="task_two" generation="1" source="coordinator">',
    'Start the next assignment.',
    '</sab-team-task>',
  ].join('\n'))
  const transcript = oldFinal + nextPrompt + record('assistant', 'Second task final.')

  assert.equal(staleTeamTurnTranscriptPrefixBytes(transcript, {
    taskId: 'task_one', providerWorkGeneration: 3,
  }), Buffer.byteLength(oldFinal))
})
