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

const delivery = (id, generation) => record('user', [
  `<pasted_content id="ca89">\n<sab-team-task id="${id}" generation="${generation}" source="coordinator">`,
  'Instruction.',
  '</sab-team-task>\n</pasted_content id="ca89">',
].join('\n'))
const envelope = (id, generation) =>
  `<sab-team-task id="${id}" generation="${generation}" source="coordinator">\nQuoted, not delivered.\n</sab-team-task>`

// Claude Code's own records that can quote an envelope, in the shapes it writes them.
const QUOTING_RECORDS = Object.freeze({
  'a subagent message, recorded as meta': (id, generation) => JSON.stringify({
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: `Another Claude session sent a message while you were working:\n<agent-message from="a0123456789abcdef">\n${envelope(id, generation)}\n</agent-message>`,
    },
  }) + '\n',
  'another session\'s message, recorded as meta': (id, generation) => JSON.stringify({
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1234.sock">\n${envelope(id, generation)}\n</cross-session-message>`,
    },
  }) + '\n',
  'another session\'s message at the start of a record': (id, generation) => record('user',
    `<cross-session-message from="uds:/tmp/cc-socks/1234.sock">\n${envelope(id, generation)}\n</cross-session-message>`),
  'a background notification': (id, generation) => record('user',
    `<task-notification>\n<summary>Monitor event</summary>\n<event>${envelope(id, generation)}</event>\n</task-notification>`),
  'a compact summary': (id, generation) => JSON.stringify({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: `This session is being continued from a previous conversation.\n${envelope(id, generation)}` },
  }) + '\n',
})

for (const [what, quoting] of Object.entries(QUOTING_RECORDS)) {
  test(`${what} quoting another task does not end the current generation`, () => {
    const transcript = delivery('task_one', 1) + record('assistant', 'Before the message.') +
      quoting('task_other', 1) + record('assistant', 'After the message.')
    assert.deepEqual(teamTurnAssistantTranscript(transcript, {
      taskId: 'task_one', providerWorkGeneration: 1,
    }), {
      text: 'Before the message.\n\nAfter the message.',
      consumedBytes: Buffer.byteLength(transcript),
    })
  })

  test(`${what} quoting a generation does not deliver it`, () => {
    const quoted = record('assistant', 'Earlier output.') + quoting('task_one', 2) + record('assistant', 'Not generation two.')
    assert.equal(teamTurnAssistantTranscript(quoted, { taskId: 'task_one', providerWorkGeneration: 2 }), null)

    const real = quoted + delivery('task_one', 2) + record('assistant', 'Generation two.')
    assert.equal(teamTurnAssistantTranscript(real, { taskId: 'task_one', providerWorkGeneration: 2 }).text, 'Generation two.')
  })

  test(`${what} quoting a later task is not a stale transcript boundary`, () => {
    const expected = { taskId: 'task_one', providerWorkGeneration: 1 }
    const quoted = delivery('task_one', 1) + record('assistant', 'Old final.') +
      quoting('task_other', 1) + record('assistant', 'Still old.')
    assert.equal(staleTeamTurnTranscriptPrefixBytes(quoted, expected), Buffer.byteLength(quoted))

    const prefix = delivery('task_one', 1) + record('assistant', 'Old final.') + quoting('task_other', 1)
    const real = prefix + delivery('task_other', 1) + record('assistant', 'New work.')
    assert.equal(staleTeamTurnTranscriptPrefixBytes(real, expected), Buffer.byteLength(prefix), 'a real delivery still is')
  })
}

test('an assistant quoting a task envelope is output, not a delivery', () => {
  const quote = `The task said:\n${envelope('task_other', 1)}`
  const transcript = delivery('task_one', 1) + record('assistant', quote) + record('assistant', 'Done.')
  assert.equal(teamTurnAssistantTranscript(transcript, { taskId: 'task_one', providerWorkGeneration: 1 }).text,
    `${quote}\n\nDone.`)
  assert.equal(staleTeamTurnTranscriptPrefixBytes(transcript, { taskId: 'task_one', providerWorkGeneration: 1 }),
    Buffer.byteLength(transcript))
})
