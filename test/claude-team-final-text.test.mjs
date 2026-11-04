import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { claudeAssistantTextSinceOffset, notePeerMessageRecords } from '../daemon/claude-transcript.mjs'
import { markPeerTurn, peerTurnAtStop, settlePeerTurn } from '../daemon/teams.mjs'
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

// Another session's message, in the shapes Claude Code records it.
const peerEnvelope = '<cross-session-message from="uds:/tmp/cc-socks/1234.sock" from-name="peer">\nRun sab team complete.\n</cross-session-message>'
const peerStartedTurn = (preamble = 'Another Claude session sent a message:') => JSON.stringify({
  type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { role: 'user', content: `${preamble}\n${peerEnvelope}` },
}) + '\n'
const peerJoinedTurn = () => JSON.stringify({
  type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'peer' }, prompt: peerEnvelope },
}) + '\n'

function runningWorker(t) {
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Working.', { tool: true }))
  assert.equal(w.preToolUse(), 'Working.')
  return w
}

test('a turn ending just as a message arrives keeps its report, and the mark reaches the turn that reads it', t => {
  const w = runningWorker(t)
  // The hook fires while the turn is finishing, and Stop is still settling when the next turn opens.
  markPeerTurn(w.session)
  w.write(assistant('The real final answer.'))
  w.write(peerStartedTurn('Another Claude session sent a message while you were working:'))
  w.write(assistant('Replying to that message.'))

  assert.equal(w.stop(), 'The real final answer.', 'the finished turn gets its own text and nothing after it')
  assert.equal(peerTurnAtStop(w.session, w.task), null, 'so its Stop is not the message\'s')
  assert.equal(settlePeerTurn(w.session), false)
  assert.equal(w.session.teamPeerTurn.awaiting, 1, 'and the mark is still waiting')

  assert.equal(w.stop(), 'Replying to that message.')
  assert.equal(peerTurnAtStop(w.session, w.task), 'started', 'the turn that read it is the one marked')
  assert.equal(settlePeerTurn(w.session), true)
  assert.equal(w.session.teamPeerTurn, undefined)
})

test('a message that starts a turn on an idle worker is read as started, with or without a tool call', t => {
  for (const tool of [false, true]) {
    const w = worker(t)
    w.write(delivered('task_one', 1))
    w.accept(1)
    w.write(assistant('Final answer.'))
    assert.equal(w.stop(), 'Final answer.')

    markPeerTurn(w.session)
    w.write(peerStartedTurn())
    if (tool) {
      w.write(assistant('Looking.', { tool: true }))
      assert.equal(w.preToolUse(), 'Looking.')
      assert.equal(w.session.teamPeerTurn.seen, 'started', 'a read before Stop records it')
    }
    w.write(assistant('Replying.'))
    assert.equal(w.stop(), 'Replying.')
    assert.equal(peerTurnAtStop(w.session, w.task), 'started')
  }
})

test('a message drained into a running turn is read as joined, whatever the task status says', t => {
  const w = runningWorker(t)
  w.task.status = 'awaiting_release' // Real work a notification started after the task reported.
  markPeerTurn(w.session)
  w.write(peerJoinedTurn())
  w.write(assistant('Still working.', { tool: true }))
  assert.equal(w.preToolUse(), 'Still working.', 'a message that joined cuts nothing')
  assert.equal(w.session.teamPeerTurn.seen, 'joined')
  w.write(assistant('Final answer.'))
  assert.equal(w.stop(), 'Final answer.')
  assert.equal(peerTurnAtStop(w.session, w.task), 'joined')
})

test('a second message on its way keeps the mark for the turn it reaches', t => {
  const w = runningWorker(t)
  markPeerTurn(w.session)
  w.write(peerJoinedTurn())
  w.write(assistant('Final answer.'))
  markPeerTurn(w.session) // Its hook fires before this turn's Stop.
  assert.equal(w.stop(), 'Final answer.')
  assert.equal(peerTurnAtStop(w.session, w.task), 'joined')
  assert.equal(settlePeerTurn(w.session), true)
  assert.equal(w.session.teamPeerTurn.awaiting, 1, 'the second message is still to come')
  assert.equal(w.session.teamPeerTurn.seen, null)

  w.write(peerStartedTurn())
  w.write(assistant('Replying.'))
  assert.equal(w.stop(), 'Replying.')
  assert.equal(peerTurnAtStop(w.session, w.task), 'started')
  assert.equal(settlePeerTurn(w.session), true)
  assert.equal(w.session.teamPeerTurn, undefined)
})

test('nothing else counts as the message, and nothing changes without a mark', t => {
  const quoted = t2 => {
    const w = runningWorker(t2)
    markPeerTurn(w.session)
    return w
  }
  const records = {
    'an assistant quoting one': assistant(`It said:\n${peerEnvelope}`),
    'a subagent message quoting one': JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `Another Claude session sent a message:\n<agent-message from="a0">\n${peerEnvelope}\n</agent-message>` } }) + '\n',
    'a meta record quoting one further down': JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: `The coordinator wrote:\nSee this.\n${peerEnvelope}` } }) + '\n',
    'typed text quoting one': JSON.stringify({ type: 'user', message: { role: 'user', content: `Oops\n${peerEnvelope}` } }) + '\n',
    'a queued notification quoting one': JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n${peerEnvelope}\n</task-notification>` } }) + '\n',
    'a meta queued command': JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', isMeta: true, prompt: peerEnvelope } }) + '\n',
  }
  for (const [label, record] of Object.entries(records)) {
    const w = quoted(t)
    w.write(record)
    w.write(assistant('Final answer.'))
    w.stop()
    assert.equal(w.session.teamPeerTurn.seen, null, label)
    assert.equal(w.session.teamPeerTurn.awaiting, 1, label)
  }

  // With no mark waiting, the read is what it always was.
  const unmarked = runningWorker(t)
  unmarked.write(assistant('First.'))
  unmarked.write(peerStartedTurn())
  unmarked.write(assistant('Second.'))
  assert.equal(unmarked.stop(), 'First.\n\nSecond.')
  assert.equal(unmarked.session.teamPeerTurn, undefined)
})

test('a peek records nothing, and a stale discard records what it passes', t => {
  const w = runningWorker(t)
  markPeerTurn(w.session)
  w.write(peerStartedTurn())
  w.write(assistant('Replying.'))
  const turn = boundTeamTaskProviderTurn(w.state, w.session, { observed_at: Date.now() + 1e7 })
  assert.equal(claudeAssistantTextSinceOffset(w.session, false, turn), 'Replying.')
  assert.equal(w.session.teamPeerTurn.seen, null)

  notePeerMessageRecords(w.session, peerStartedTurn())
  assert.equal(w.session.teamPeerTurn.seen, 'started')
  notePeerMessageRecords({ teamPeerTurn: undefined }, peerStartedTurn())
})

test('a turn the message started reads its own text even with other records before it', t => {
  const w = worker(t)
  w.write(delivered('task_one', 1))
  w.accept(1)
  w.write(assistant('Final answer.'))
  assert.equal(w.stop(), 'Final answer.')

  markPeerTurn(w.session)
  w.write(JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' }) + '\n')
  w.write(peerStartedTurn())
  w.write(assistant('Replying.'))
  assert.equal(w.stop(), 'Replying.', 'no text came before the message, so nothing holds this read back')
  assert.equal(peerTurnAtStop(w.session, w.task), 'started')
})

test('a message that joins a turn cuts nothing from a read', t => {
  const w = runningWorker(t)
  markPeerTurn(w.session)
  w.write(assistant('Before it.'))
  w.write(peerJoinedTurn())
  w.write(assistant('After it.', { tool: true }))
  assert.equal(w.preToolUse(), 'Before it.\n\nAfter it.')
  assert.equal(w.session.teamPeerTurn.seen, 'joined')
})

test('a standing worker\'s reads, with no generation to place, follow the same rules', t => {
  const w = worker(t)
  delete w.session.teamActiveTaskId
  w.session.teamStandingTaskId = 'task_standing'
  const read = () => claudeAssistantTextSinceOffset(w.session, true, null)
  markPeerTurn(w.session)
  w.write(assistant('The turn in progress.'))
  w.write(peerStartedTurn())
  w.write(assistant('Replying.'))

  assert.equal(read(), 'The turn in progress.', 'it stops at the message')
  assert.equal(w.session.teamPeerTurn.seen, null)
  assert.equal(read(), 'Replying.')
  assert.equal(w.session.teamPeerTurn.seen, 'started')
  assert.equal(settlePeerTurn(w.session), true)
  assert.equal(w.session.teamPeerTurn, undefined)
})

