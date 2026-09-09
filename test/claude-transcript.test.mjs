import test from 'node:test'
import assert from 'node:assert/strict'

import {
  staleTeamTurnTranscriptPrefixBytes, teamTurnAssistantTranscript,
} from '../daemon/claude-transcript.mjs'

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

test('a current generation reads only its own assistant text when an older final is still pending', () => {
  const firstPrompt = record('user', [
    '<sab-team-task id="task_one" generation="1" source="coordinator">',
    'First instruction.',
    '</sab-team-task>',
  ].join('\n'))
  const secondPrompt = record('user', [
    '<sab-team-message task="task_one" generation="2" source="coordinator">',
    'Follow-up instruction.',
    '</sab-team-message>',
  ].join('\n'))
  const transcript = firstPrompt + record('assistant', 'Generation one final.') +
    secondPrompt + record('assistant', 'Generation two final.')

  assert.deepEqual(teamTurnAssistantTranscript(transcript, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), {
    text: 'Generation two final.',
    consumedBytes: Buffer.byteLength(transcript),
  })
})

test('generation-bound transcript reads stop before a later task marker', () => {
  const firstPrompt = record('user', [
    '<sab-team-task id="task_one" generation="1" source="coordinator">',
    'First instruction.',
    '</sab-team-task>',
  ].join('\n'))
  const secondPrompt = record('user', [
    '<sab-team-message task="task_one" generation="2" source="coordinator">',
    'Follow-up instruction.',
    '</sab-team-message>',
  ].join('\n'))
  const firstSegment = firstPrompt + record('assistant', 'Generation one final.')
  const transcript = firstSegment + secondPrompt + record('assistant', 'Generation two final.')

  assert.deepEqual(teamTurnAssistantTranscript(transcript, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }), {
    text: 'Generation one final.',
    consumedBytes: Buffer.byteLength(firstSegment),
  })
})
