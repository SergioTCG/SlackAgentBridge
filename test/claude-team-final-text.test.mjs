import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { claudeAssistantTextSinceOffset } from '../daemon/claude-transcript.mjs'
import {
  activateTeamProviderTurn, boundTeamTaskProviderTurn, interimTeamTaskProviderTurn,
} from '../daemon/team-provider-turn.mjs'

// These drive the reader on a real file, in the order Claude Code writes and the daemon
// reads: a delivery, then a tool call (PreToolUse streams), then a final answer (Stop reads).

const assistant = (text, { tool = false } = {}) => JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...(tool ? [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] : []),
    ],
  },
}) + '\n'
const pasted = (taskId, generation) => [
  '<pasted_content id="ca89">',
  generation === 1
    ? `<sab-team-task id="${taskId}" generation="1" source="coordinator">`
    : `<sab-team-message task="${taskId}" generation="${generation}" source="coordinator">`,
  'Instruction.',
  generation === 1 ? '</sab-team-task>' : '</sab-team-message>',
  '</pasted_content id="ca89">',
].join('\n')
const delivered = (taskId, generation) => JSON.stringify({
  type: 'user', message: { role: 'user', content: pasted(taskId, generation) },
}) + '\n'
const queued = (taskId, generation) => JSON.stringify({
  type: 'attachment',
  attachment: { type: 'queued_command', commandMode: 'prompt', prompt: pasted(taskId, generation) },
}) + '\n'

function worker(t, { taskId = 'task_one', history = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-final-text-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const transcript = path.join(dir, 'session.jsonl')
  fs.writeFileSync(transcript, '')
  const session = {
    id: 'sid-worker', channel: 'C-WORKER', transcript, offset: 0, teamActiveTaskId: taskId,
    ...(history.length ? { teamProviderTurnHistory: history } : {}),
  }
  const task = { id: taskId, targetSessionId: 'sid-worker', targetChannel: 'C-WORKER', providerWorkGeneration: 1 }
  const state = { teamTasks: { [taskId]: task } }
  let clock = 1_000_000
  const tick = () => (clock += 1000)
  return {
    session, task, state,
    write: line => fs.appendFileSync(transcript, line),
    // The prompt hook accepts this generation.
    accept(generation) {
      task.providerWorkGeneration = generation
      const at = tick()
      activateTeamProviderTurn(session, {
        turn: { taskId, providerWorkGeneration: generation }, startedAt: at, acceptedAt: at,
      })
    },
    // Older text a read passed, which the daemon posts to the channel but never reports.
    older: [],
    // What the PreToolUse handler does, without a hook timestamp.
    preToolUse() {
      const turn = interimTeamTaskProviderTurn(state, session, {}, tick())
      return session.teamActiveTaskId && !turn ? '' : claudeAssistantTextSinceOffset(session, true, turn, text => this.older.push(text))
    },
    // What the Stop handler does, with the timestamp the hook stamps.
    stop() {
      return claudeAssistantTextSinceOffset(session, true, boundTeamTaskProviderTurn(state, session, { observed_at: tick() }), text => this.older.push(text))
    },
  }
}

test('a final answer after a tool call reaches Stop in every generation', t => {
  const w = worker(t)
  for (const generation of [1, 2, 3, 4]) {
    w.write(delivered('task_one', generation))
    w.accept(generation)
    w.write(assistant(`Looking into ${generation}.`, { tool: true }))
    assert.equal(w.preToolUse(), `Looking into ${generation}.`, `generation ${generation}: the prose streams`)
    w.write(assistant('', { tool: true }))
    assert.equal(w.preToolUse(), '', `generation ${generation}: nothing new to stream`)
    w.write(assistant(`Final answer ${generation}.`))
    assert.equal(w.stop(), `Final answer ${generation}.`, `generation ${generation}: the final reaches Stop`)
    assert.equal(w.session.claudeTranscriptOffsetTurn.providerWorkGeneration, generation)
  }
})

test('a first generation is read too when the worker held an earlier task', t => {
  const w = worker(t, {
    history: [{ taskId: 'task_before', providerWorkGeneration: 3, startedAt: 10, acceptedAt: 10 }],
  })
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Looking.', { tool: true }))
  assert.equal(w.preToolUse(), 'Looking.')
  w.write(assistant('Final answer.'))
  assert.equal(w.stop(), 'Final answer.')
})

test('a follow-up delivered mid-turn owns the text after it, and the final reaches Stop', t => {
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Working on the first ask.', { tool: true }))
  assert.equal(w.preToolUse(), 'Working on the first ask.')

  // Claude Code records it as a queued command when it drains it, between tool rounds.
  w.write(queued('task_one', 2))
  w.accept(2)
  w.write(assistant('Now the follow-up.', { tool: true }))
  assert.equal(w.preToolUse(), 'Now the follow-up.')
  w.write(assistant('Final answer to both.'))
  assert.equal(w.stop(), 'Final answer to both.')
  assert.equal(w.session.claudeTranscriptOffsetTurn.providerWorkGeneration, 2)

  // Another native turn in the same generation still reads.
  w.write(assistant('A later answer.'))
  assert.equal(w.stop(), 'A later answer.')
})

test('a turn without a tool call still reads, with several generations tracked', t => {
  const w = worker(t)
  for (const generation of [1, 2]) {
    w.write(delivered('task_one', generation))
    w.accept(generation)
    w.write(assistant(`Answer ${generation}.`))
    assert.equal(w.stop(), `Answer ${generation}.`)
  }
})

test('without a timestamp a tracked generation cannot be placed, which is what PreToolUse supplies', t => {
  const w = worker(t)
  w.accept(1)
  w.accept(2)
  assert.equal(boundTeamTaskProviderTurn(w.state, w.session, {}), null, 'no native id and no time to place it by')
  assert.deepEqual(interimTeamTaskProviderTurn(w.state, w.session, {}, Date.now() + 1000),
    { taskId: 'task_one', providerWorkGeneration: 2 })

  // A hook that does carry a time keeps it: the time it fired, not the time it arrived.
  const firstStarted = w.session.teamProviderTurnHistory[0].startedAt
  assert.deepEqual(interimTeamTaskProviderTurn(w.state, w.session, { observed_at: firstStarted }, Date.now() + 1000),
    { taskId: 'task_one', providerWorkGeneration: 1 })
})

test('an unbounded read passes the delivery marker, and the final can no longer be found', t => {
  // The reason PreToolUse must not read a bound task it couldn't place.
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('First.'))
  assert.equal(w.stop(), 'First.')

  w.write(delivered('task_one', 2))
  w.accept(2)
  w.write(assistant('Looking.', { tool: true }))
  assert.equal(claudeAssistantTextSinceOffset(w.session, true, null), 'Looking.', 'the unbounded read')
  w.write(assistant('Final answer.'))
  assert.equal(w.stop(), '', 'the marker is behind the offset, so Stop reads nothing')
})

test('text no generation owns is not attributed to the next one, but reaches the channel', t => {
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Final answer 1.'))
  assert.equal(w.stop(), 'Final answer 1.')
  w.write(assistant('Written after the final.'))
  w.write(delivered('task_one', 2))
  w.accept(2)
  w.write(assistant('Final answer 2.'))
  assert.equal(w.stop(), 'Final answer 2.')
  assert.deepEqual(w.older, ['Written after the final.'])
})

test('a follow-up accepted before its marker lands holds the read, and the text before it is not lost', t => {
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Working.', { tool: true }))
  assert.equal(w.preToolUse(), 'Working.')

  // The paste returned, so generation 2 is accepted, while the worker is still writing.
  w.accept(2)
  w.write(assistant('Prose before the follow-up lands.', { tool: true }))
  assert.equal(w.preToolUse(), '', 'nothing can be placed in generation 2 yet')
  assert.deepEqual(w.older, [])

  w.write(queued('task_one', 2))
  w.write(assistant('Now the follow-up.', { tool: true }))
  assert.equal(w.preToolUse(), 'Now the follow-up.')
  assert.deepEqual(w.older, ['Prose before the follow-up lands.'], 'it reaches the channel, not generation 2')
})

test('a peek leaves older text to the read that consumes it', t => {
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Final answer 1.'))
  assert.equal(w.stop(), 'Final answer 1.')
  w.write(assistant('Older.'))
  w.write(delivered('task_one', 2))
  w.accept(2)
  w.write(assistant('Newer.'))
  const seen = []
  const turn = boundTeamTaskProviderTurn(w.state, w.session, { observed_at: Date.now() + 1000 })
  assert.equal(claudeAssistantTextSinceOffset(w.session, false, turn, text => seen.push(text)), 'Newer.')
  assert.deepEqual(seen, [])
  assert.equal(w.stop(), 'Newer.')
  assert.deepEqual(w.older, ['Older.'])
})
