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

test('a streamed newer generation boundary protects its later output from an older Stop', () => {
  const unread = record('assistant', 'Generation two post-tool final.')
  const older = { taskId: 'task_one', providerWorkGeneration: 1 }
  const streamed = { taskId: 'task_one', providerWorkGeneration: 2 }

  assert.equal(staleTeamTurnTranscriptPrefixBytes(unread, older, streamed), 0)
  assert.deepEqual(teamTurnAssistantTranscript(unread, streamed, streamed), {
    text: 'Generation two post-tool final.',
    consumedBytes: Buffer.byteLength(unread),
  })
})

test('generation selection exposes the native transcript prompt timestamp', () => {
  const timestamp = '2026-09-09T11:30:00.000Z'
  const prompt = JSON.stringify({
    type: 'user', timestamp,
    message: { content: [{
      type: 'text',
      text: '<sab-team-message task="task_one" generation="2" source="coordinator">',
    }] },
  }) + '\n'
  const final = record('assistant', 'Finished after the prompt.')

  assert.deepEqual(teamTurnAssistantTranscript(prompt + final, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), {
    text: 'Finished after the prompt.',
    consumedBytes: Buffer.byteLength(prompt + final),
    promptObservedAt: Date.parse(timestamp),
  })
})

test('a new Claude generation does not inherit an earlier terminal failure', () => {
  const oldFailure = record('assistant', 'Login expired · Please run /login')
  const nextPrompt = record('user', [
    '<sab-team-message task="task_one" generation="2" source="coordinator">',
    'Retry the task after authentication recovers.',
    '</sab-team-message>',
  ].join('\n'))

  assert.deepEqual(teamTurnAssistantTranscript(oldFailure + nextPrompt, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), {
    text: '',
    consumedBytes: Buffer.byteLength(oldFailure + nextPrompt),
  })
})
