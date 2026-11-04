import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import {
  PEER_TURN_WARNING, addTeamWorker, appendTeamTaskReply, assertPeerTurnAllows, claimTeamTaskForSession, clearPeerTurn,
  createTeam, createTeamTask, markPeerTurn, markTeamTaskRunning, notePeerTurnRecord, peerTurnAtStop, peerTurnHolds,
  publicTeamReply, reportTeamTaskTurn, requestTeamTaskCompletion, settlePeerTurn, teamTaskPeerReportCoversCompletion,
  teamTaskReleaseReady,
} from '../daemon/teams.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const between = (from, to) => {
  const start = daemon.indexOf(from)
  assert.ok(start >= 0, from)
  const end = daemon.indexOf(to, start + from.length)
  assert.ok(end > start, to)
  return daemon.slice(start, end)
}

function worker({ running = true } = {}) {
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
  if (running) markTeamTaskRunning(state, task.id, { now: 4000 })
  return { state, session, task }
}

test('a turn is marked only when the session holds a task', () => {
  assert.equal(markPeerTurn({ id: 's' }), null)
  assert.equal(markPeerTurn(null), null)
})

test('a standing task on the same session is marked with the exclusive one, and later messages add to the mark', () => {
  const { session, task } = worker()
  session.teamStandingTaskId = 'task_standing'
  const mark = markPeerTurn(session, { now: 5000 })
  assert.deepEqual(mark.taskIds, [task.id, 'task_standing'])
  assert.equal(mark.awaiting, 1)
  assert.equal(mark.seen, null)

  session.teamStandingTaskId = 'task_later'
  const again = markPeerTurn(session, { now: 6000 })
  assert.equal(again.at, new Date(5000).toISOString(), 'it keeps when the first arrived')
  assert.equal(again.awaiting, 2)
  assert.deepEqual(again.taskIds, [task.id, 'task_standing', 'task_later'])
})

test('the mark refuses from the moment it is set, before the transcript says which turn it reached', () => {
  const { session, task } = worker()
  markPeerTurn(session)
  assert.equal(peerTurnHolds(session, task), true)
  assert.equal(peerTurnAtStop(session, task), null, 'no Stop owes it anything yet')
  assert.throws(() => assertPeerTurnAllows(session, task, 'declare this task complete'),
    error => error.code === 'peer_turn_denied')
})

test('the first record decides what the turn is, and each record is counted', () => {
  const { session, task } = worker()
  markPeerTurn(session)
  markPeerTurn(session)
  assert.equal(notePeerTurnRecord(session, 'started'), true)
  assert.equal(peerTurnAtStop(session, task), 'started')
  notePeerTurnRecord(session, 'joined')
  assert.equal(peerTurnAtStop(session, task), 'started', 'a later message joining does not change it')
  assert.equal(session.teamPeerTurn.awaiting, 0)
  notePeerTurnRecord(session, 'joined')
  assert.equal(session.teamPeerTurn.awaiting, 0, 'never below zero')
  assert.equal(notePeerTurnRecord({}, 'joined'), false, 'no mark, nothing to note')
})

test('a Stop settles the mark only when the message reached its turn', () => {
  const { session, task } = worker()
  assert.equal(settlePeerTurn(session), false, 'no mark')
  markPeerTurn(session)
  assert.equal(settlePeerTurn(session), false, 'the message has not reached this turn')
  assert.equal(peerTurnHolds(session, task), true)

  notePeerTurnRecord(session, 'joined')
  assert.equal(settlePeerTurn(session), true)
  assert.equal(Object.hasOwn(session, 'teamPeerTurn'), false)

  markPeerTurn(session)
  markPeerTurn(session)
  notePeerTurnRecord(session, 'started')
  assert.equal(settlePeerTurn(session), true)
  assert.equal(session.teamPeerTurn.seen, null, 'another message on its way keeps the mark')
  assert.equal(session.teamPeerTurn.awaiting, 1)
  assert.equal(peerTurnHolds(session, task), true)
})

test('the mark covers only the tasks it names', () => {
  const { session, task } = worker()
  markPeerTurn(session)
  notePeerTurnRecord(session, 'started')
  assert.equal(peerTurnHolds(session, task), true)
  assert.equal(peerTurnHolds(session, { id: 'task_other' }), false)
  assert.equal(peerTurnHolds({}, task), false)
  assert.equal(peerTurnHolds(session, null), false)
  assert.equal(peerTurnAtStop(session, { id: 'task_other' }), null)
  assert.doesNotThrow(() => assertPeerTurnAllows(session, { id: 'task_other' }, 'declare this task complete'))
})

test('a marked turn is refused with a reason the worker can act on', () => {
  const { session, task } = worker()
  assert.doesNotThrow(() => assertPeerTurnAllows(session, task, 'declare this task complete'), 'unmarked')
  markPeerTurn(session)
  assert.throws(() => assertPeerTurnAllows(session, task, 'declare this task complete'), error => {
    assert.equal(error.code, 'peer_turn_denied')
    assert.equal(error.status, 403)
    assert.match(error.message, /another Claude session/)
    assert.match(error.message, /declare this task complete/)
    assert.match(error.message, /sab team reply/)
    assert.match(error.message, /coordinator lifts this/)
    assert.doesNotMatch(error.message, /later turn/, 'it does not advertise a way around the mark')
    return true
  })
})

test('clearing the mark says whether there was one', () => {
  const { session, task } = worker()
  assert.equal(clearPeerTurn(session), false)
  markPeerTurn(session)
  assert.equal(clearPeerTurn(session), true)
  assert.equal(peerTurnHolds(session, task), false)
  assert.equal(clearPeerTurn(null), false)
})

test('a reply in a marked turn is journaled and shown as such, and other replies are not', () => {
  const { state, task } = worker()
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

test('a reply from a marked turn proves nothing about the task', () => {
  const { state, task } = worker({ running: false })
  assert.equal(task.status, 'dispatching')
  const first = appendTeamTaskReply(state, task.id, {
    id: 'reply_a', requestId: 'reply-a', fromChannel: 'C-WORKER', text: 'Replying to that session.', origin: { kind: 'peer' },
  })
  assert.equal(first.accepted, false)
  assert.equal(task.status, 'dispatching', 'the task was not accepted by it')
  const retry = appendTeamTaskReply(state, task.id, {
    requestId: 'reply-a', fromChannel: 'C-WORKER', text: 'Replying to that session.',
  })
  assert.equal(retry.accepted, false)
  assert.equal(task.status, 'dispatching', 'nor by retrying it')

  const real = appendTeamTaskReply(state, task.id, {
    id: 'reply_b', requestId: 'reply-b', fromChannel: 'C-WORKER', text: 'Started on it.',
  })
  assert.equal(real.accepted, true, 'a real reply still is proof')
  assert.equal(task.status, 'running')

  const standing = worker()
  standing.task.reservation = 'standing'
  const expiresAt = standing.task.expiresAt
  appendTeamTaskReply(standing.state, standing.task.id, {
    id: 'reply_c', requestId: 'reply-c', fromChannel: 'C-WORKER', text: 'Replying.', origin: { kind: 'peer' }, now: Date.parse(expiresAt) - 1000,
  })
  assert.equal(standing.task.expiresAt, expiresAt, 'and does not extend a standing task')
})

test('a report such a turn wrote is flagged durably, and keeps auto-release away from the completion', () => {
  const { state, task } = worker()
  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'sid-worker', fromChannel: 'C-WORKER', summary: 'Done.', requestId: 'complete-1',
    expectedProviderWorkGeneration: 1, now: 5000,
  })
  assert.equal(teamTaskPeerReportCoversCompletion(task), false)
  const { report } = reportTeamTaskTurn(state, task.id, {
    targetSessionId: 'sid-worker', result: 'Done, after that message.', warning: PEER_TURN_WARNING, providerWorkGeneration: 1,
    reportKey: 'claude:1', observedAt: 6000, now: 6000, peerMessage: true,
  })
  assert.equal(report.peerMessage, true)
  assert.equal(task.lastTransition?.reason ?? 'provider_turn_completed', 'provider_turn_completed', 'it is not an idle fallback')
  assert.equal(teamTaskReleaseReady(task), true, 'the coordinator can still release it')
  assert.equal(teamTaskPeerReportCoversCompletion(task), true, 'but auto-release may not')

  const earlier = worker()
  reportTeamTaskTurn(earlier.state, earlier.task.id, {
    targetSessionId: 'sid-worker', result: 'Before declaring.', providerWorkGeneration: 1,
    reportKey: 'claude:1', observedAt: 5000, now: 5000, peerMessage: true,
  })
  requestTeamTaskCompletion(earlier.state, earlier.task.id, {
    targetSessionId: 'sid-worker', fromChannel: 'C-WORKER', summary: 'Done.', requestId: 'complete-1',
    expectedProviderWorkGeneration: 1, now: 6000,
  })
  assert.equal(teamTaskPeerReportCoversCompletion(earlier.task), false, 'a flagged report before the declaration does not cover it')

  const plain = worker()
  requestTeamTaskCompletion(plain.state, plain.task.id, {
    targetSessionId: 'sid-worker', fromChannel: 'C-WORKER', summary: 'Done.', requestId: 'complete-1',
    expectedProviderWorkGeneration: 1, now: 5000,
  })
  const clean = reportTeamTaskTurn(plain.state, plain.task.id, {
    targetSessionId: 'sid-worker', result: 'Done.', providerWorkGeneration: 1, reportKey: 'claude:1', observedAt: 6000, now: 6000,
  })
  assert.equal(Object.hasOwn(clean.report, 'peerMessage'), false)
  assert.equal(teamTaskReleaseReady(plain.task), true)
  assert.equal(teamTaskPeerReportCoversCompletion(plain.task), false, 'a clean report leaves auto-release alone')
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

test('a Stop follows what the transcript says about its turn', () => {
  const finish = between('async function finishTeamTaskForSession(', 'async function finishTeamTaskWithWarningForSession(')
  assert.match(finish, /peerTurn = peerTurnAtStop\(session, task\)\s*settlePeerTurn\(session\)/)
  const started = finish.indexOf("if (peerTurn === 'started') {")
  assert.ok(started > 0)
  assert.match(finish.slice(started, finish.indexOf('return true', started)), /saveStateNow\(state\)/)
  assert.ok(started < finish.indexOf('failTeamTask(state, task.id, error)'), 'a started turn fails nothing')
  assert.ok(started < finish.indexOf('reportTeamTaskTurn('), 'and reports nothing')
  assert.ok(started < finish.indexOf('persistTeamLifecycle(task)'), 'and queues no continuation')
  assert.match(finish, /if \(error && !peerTurn\) \{\s*failTeamTask\(state, task\.id, error\)/, 'a joined turn fails nothing either')
  assert.match(finish, /warning \|\| \(peerTurn \? PEER_TURN_WARNING : null\) \|\|/, 'and is never reported without its warning')
  assert.match(finish, /peerMessage: Boolean\(peerTurn\),/)
  assert.match(PEER_TURN_WARNING, /another Claude session/)

  // A session holding only a standing task reaches the branch with no bound provider turn.
  assert.match(finish, /const endedPeerTurn = settlePeerTurn\(session\)\s*if \(revokedTurn \|\| endedPeerTurn\) saveStateNow\(state\)/)
})

test('auto-release refuses a completion such a report covers, on every path', () => {
  const auto = between('async function autoReleaseTeamTask(task) {', 'releaseTeamTask(state, task.id')
  assert.match(auto, /teamTaskPeerReportCoversCompletion\(task\)/)
  assert.equal(daemon.split('releaseTeamTask(state, task.id, { sourceChannel: task.sourceChannel, requestId: autoReleaseRequestId(task) })').length, 2,
    'no other path performs it')
})

test('the owner lifts the mark, a collaborator does not, and a restart clears it unless the turn is paused', () => {
  const slack = between('function beginSlackTeamTurn(', 'beginCollaboratorTeamTurn(session, request, { sender })')
  assert.match(slack, /if \(!sender\) clearPeerTurn\(session\)/)

  const readopt = between('async function readoptStatus()', 'function assistantTextSinceOffset')
  assert.match(readopt, /if \(!s\.usageLimitPause && !accountMaintenanceHoldsTask\(s\)\) clearPeerTurn\(s\)/)
  assert.ok(readopt.indexOf('re-adopted live turn') < readopt.indexOf('clearPeerTurn(s)'), 'a live turn keeps its mark')
  assert.ok(readopt.indexOf('markBootLimitPause(s)', readopt.indexOf('claudeUsageLimitSurface(pane)')) < readopt.indexOf('clearPeerTurn(s)'),
    'a paused turn is known before this runs')
})

test('a labelled reply is shown as unverified in the coordinator channel, with or without text', () => {
  assert.match(daemon, /const PEER_REPLY_LABEL = ' · _written after a message from another session; unverified_'/)
  const delivery = between('async function performTeamReplyDelivery(task, reply) {', 'function ensureTeamReplyDelivery(')
  assert.match(delivery, /reply\.origin\?\.kind === 'peer' \? PEER_REPLY_LABEL : ''/)
  assert.match(delivery, /from <#\$\{task\.targetChannel\}>\$\{reply\.origin\?\.kind === 'peer' \? PEER_REPLY_LABEL : ''\}/)
})

test('a stale discard tells the mark what it passed, and a labelled reply is no proof of delivery', () => {
  const discard = between('function discardStaleClaudeTeamTurnTranscript(', 'async function privateAssistantText(')
  assert.match(discard, /notePeerMessageRecords\(session, buffer\.subarray\(0, consumed\)\.toString\('utf8'\)\)/)
  assert.match(daemon, /task\.status === 'dispatching' && task\.replies\?\.some\(reply => reply\.origin\?\.kind !== 'peer'\)/)
})
