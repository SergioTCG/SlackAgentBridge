import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  PEER_TURN_WARNING, addTeamWorker, appendTeamTaskReply, assertPeerTurnAllows,
  claimTeamTaskForSession, clearPeerTurn, createTeam, createTeamTask, markPeerTurn, markTeamTaskRunning,
  peerTurnAtStop, peerTurnHolds, publicTeamReply,
} from '../daemon/teams.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const between = (from, to) => {
  const start = daemon.indexOf(from)
  assert.ok(start >= 0, from)
  const end = daemon.indexOf(to, start + from.length)
  assert.ok(end > start, to)
  return daemon.slice(start, end)
}

function runningWorker() {
  const state = { sessions: {}, channels: {} }
  const team = createTeam(state, {
    id: 'team_lanes', name: 'Lanes', coordinatorChannel: 'C-COORD', createdBy: 'U-OWNER', now: 1000,
  })
  addTeamWorker(state, team.id, { channel: 'C-WORKER', alias: 'executor-1', now: 1100 })
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-COORD', sourceSessionId: 'sid-coord', sourceProvider: 'claude',
    target: 'executor-1', text: 'Fix issue 101.', requestId: 'request-1', id: 'task_lane', now: 2000,
  })
  const session = { id: 'sid-worker', channel: 'C-WORKER' }
  claimTeamTaskForSession(state, task.id, session, { targetProvider: 'claude', now: 3000 })
  return { state, session, task }
}

test('a turn is marked only when the session holds a task', () => {
  assert.equal(markPeerTurn({}, { id: 's' }), null)
  assert.equal(markPeerTurn({}, null), null)
})

test('joining a running task differs from starting a turn on any other', () => {
  const dispatching = runningWorker()
  assert.equal(dispatching.task.status, 'dispatching')
  assert.equal(markPeerTurn(dispatching.state, dispatching.session).joinedRunningTurn, false)
  assert.equal(peerTurnAtStop(dispatching.session, dispatching.task), 'started')

  const running = runningWorker()
  markTeamTaskRunning(running.state, running.task.id, { now: 4000 })
  assert.equal(markPeerTurn(running.state, running.session).joinedRunningTurn, true)
  assert.equal(peerTurnAtStop(running.session, running.task), 'joined')

  const reported = runningWorker()
  markTeamTaskRunning(reported.state, reported.task.id, { now: 4000 })
  reported.task.status = 'awaiting_release'
  assert.equal(markPeerTurn(reported.state, reported.session).joinedRunningTurn, false)
  assert.equal(peerTurnAtStop(reported.session, reported.task), 'started')
})

test('a standing task on the same session is marked with the exclusive one, and later messages add to the mark', () => {
  const { state, session, task } = runningWorker()
  markTeamTaskRunning(state, task.id, { now: 4000 })
  session.teamStandingTaskId = 'task_standing'
  const mark = markPeerTurn(state, session, { now: 5000 })
  assert.deepEqual(mark.taskIds, [task.id, 'task_standing'])

  task.status = 'awaiting_release'
  delete session.teamStandingTaskId
  session.teamStandingTaskId = 'task_later'
  const again = markPeerTurn(state, session, { now: 6000 })
  assert.equal(again.joinedRunningTurn, true, 'the second message changes nothing the first found')
  assert.equal(again.at, new Date(5000).toISOString())
  assert.deepEqual(again.taskIds, [task.id, 'task_standing', 'task_later'])
})

test('the mark covers only the tasks it names', () => {
  const { state, session, task } = runningWorker()
  markPeerTurn(state, session)
  assert.equal(peerTurnHolds(session, task), true)
  assert.equal(peerTurnHolds(session, { id: 'task_other' }), false)
  assert.equal(peerTurnHolds({}, task), false)
  assert.equal(peerTurnHolds(session, null), false)
  assert.equal(peerTurnAtStop(session, { id: 'task_other' }), null)
  assert.doesNotThrow(() => assertPeerTurnAllows(session, { id: 'task_other' }, 'declare this task complete'))
})

test('a marked turn is refused with a reason the worker can act on', () => {
  const { state, session, task } = runningWorker()
  assert.doesNotThrow(() => assertPeerTurnAllows(session, task, 'declare this task complete'), 'unmarked')
  markPeerTurn(state, session)
  assert.throws(() => assertPeerTurnAllows(session, task, 'declare this task complete'), error => {
    assert.equal(error.code, 'peer_turn_denied')
    assert.equal(error.status, 403)
    assert.match(error.message, /another Claude session/)
    assert.match(error.message, /declare this task complete/)
    assert.match(error.message, /final answer/)
    return true
  })
})

test('clearing the mark says whether there was one', () => {
  const { state, session, task } = runningWorker()
  assert.equal(clearPeerTurn(session), false)
  markPeerTurn(state, session)
  assert.equal(clearPeerTurn(session), true)
  assert.equal(peerTurnHolds(session, task), false)
  assert.equal(Object.hasOwn(session, 'teamPeerTurn'), false)
  assert.equal(clearPeerTurn(null), false)
})

test('a reply in a marked turn is journaled and shown as such, and other replies are not', () => {
  const { state, task } = runningWorker()
  const marked = appendTeamTaskReply(state, task.id, {
    id: 'reply_a', requestId: 'reply-a', fromChannel: 'C-WORKER', text: 'It says CI is green.', origin: { kind: 'peer' },
  })
  assert.deepEqual(marked.reply.origin, { kind: 'peer' })
  assert.equal(publicTeamReply(task, marked.reply, 'C-COORD').origin, 'peer')

  const plain = appendTeamTaskReply(state, task.id, {
    id: 'reply_b', requestId: 'reply-b', fromChannel: 'C-WORKER', text: 'My own update.',
  })
  assert.equal(plain.reply.origin, undefined)
  assert.equal(publicTeamReply(task, plain.reply, 'C-COORD').origin, 'worker')

  const invented = appendTeamTaskReply(state, task.id, {
    id: 'reply_c', requestId: 'reply-c', fromChannel: 'C-WORKER', text: 'Invented.', origin: { kind: 'invented', name: 'x' },
  })
  assert.equal(invented.reply.origin, undefined, 'only known origins are kept')
})

test('the worker service refuses gates and completion in a marked turn, and labels its replies', () => {
  const reply = between('  async reply(caller, request) {', '  async checkpoint(caller, request) {')
  assert.match(reply, /if \(request\.pendingGates !== undefined\) assertPeerTurnAllows\(session, task, 'change task gates'\)/)
  assert.match(reply, /origin: origin \|\| \(peerTurnHolds\(session, task\) \? \{ kind: 'peer' \} : null\)/)
  assert.ok(reply.indexOf('assertPeerTurnAllows') > reply.indexOf('reply_not_allowed'), 'after ownership is checked')
  assert.ok(reply.indexOf('assertPeerTurnAllows') < reply.indexOf('stageTeamFiles'), 'before anything is staged')
  // A labelled reply never wakes the coordinator, as for a collaborator's.
  assert.match(reply, /const continuationTeamId = !reply\.origin && shouldWakeForTeamReply/)

  const complete = between('  async complete(caller, request) {', '  async release(caller, request) {')
  assert.match(complete, /if \(!priorRequest\) assertPeerTurnAllows\(session, task, 'declare this task complete'\)/)
  assert.ok(complete.indexOf('assertPeerTurnAllows') < complete.indexOf('requestTeamTaskCompletion('), 'before it is recorded')
})

test('a turn the message started ends with no report, and one it joined reports with a warning and no auto-release', () => {
  const finish = between('async function finishTeamTaskForSession(', 'async function finishTeamTaskWithWarningForSession(')
  assert.match(finish, /peerTurn = peerTurnAtStop\(session, task\)\s*clearPeerTurn\(session\)/)
  const started = finish.indexOf("if (peerTurn === 'started') {")
  assert.ok(started > 0)
  const branch = finish.slice(started, finish.indexOf('return true', started))
  assert.match(branch, /saveStateNow\(state\)/)
  assert.ok(started < finish.indexOf('failTeamTask(state, task.id, error)'), 'even a failed provider turn leaves the task alone')
  assert.ok(started < finish.indexOf('reportTeamTaskTurn('), 'no report')
  assert.ok(started < finish.indexOf('persistTeamLifecycle(task)'), 'no continuation event')
  assert.match(finish, /peerTurn === 'joined' \? PEER_TURN_WARNING : null/)
  assert.match(finish, /if \(!peerTurn\) await autoReleaseTeamTask\(task\)/)
  assert.equal(finish.split('autoReleaseTeamTask(task)').length, 2, 'no other path auto-releases here')

  // A session holding only a standing task reaches the branch with no bound provider turn.
  assert.match(finish, /const endedPeerTurn = clearPeerTurn\(session\)\s*if \(revokedTurn \|\| endedPeerTurn\) saveStateNow\(state\)/)
  assert.match(PEER_TURN_WARNING, /another Claude session/)
})

test('the owner lifts the mark, a collaborator does not, and a restart clears it on an idle session', () => {
  const slack = between('function beginSlackTeamTurn(', 'beginCollaboratorTeamTurn(session, request, { sender })')
  assert.match(slack, /if \(!sender\) clearPeerTurn\(session\)/)

  const readopt = between('async function readoptStatus()', 'function assistantTextSinceOffset')
  const idle = readopt.slice(readopt.indexOf('// Idle: nothing to mirror.'))
  assert.match(idle, /clearPeerTurn\(s\)/)
  assert.ok(readopt.indexOf('re-adopted live turn') < readopt.indexOf('clearPeerTurn(s)'), 'a live turn keeps its mark')
})

test('a labelled reply is shown as unverified in the coordinator channel', () => {
  assert.match(daemon, /reply\.origin\?\.kind === 'peer' \? ' · _written after a message from another session; unverified_'/)
})
