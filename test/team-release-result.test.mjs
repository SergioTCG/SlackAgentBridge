import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TEAM_MAX_REPORTS, addTeamWorker, claimTeamTaskForSession, createTeam, createTeamTask, markTeamTaskRunning,
  releaseTeamTask, reportTeamTaskTurn, requestTeamTaskCompletion,
} from '../daemon/teams.mjs'

const NOW = Date.parse('2026-11-04T10:00:00.000Z')

function runningTask() {
  const state = { sessions: {}, channels: {} }
  const team = createTeam(state, {
    id: 'team_lanes', name: 'Lanes', coordinatorChannel: 'C-COORD', createdBy: 'U-OWNER', now: NOW,
  })
  addTeamWorker(state, team.id, { channel: 'C-WORKER', alias: 'executor-1', now: NOW + 1 })
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-COORD', sourceSessionId: 'sid-coord', sourceProvider: 'claude',
    target: 'executor-1', text: 'Fix issue 101.', requestId: 'request-1', id: 'task_lane', now: NOW + 2,
  })
  const session = { id: 'sid-worker', channel: 'C-WORKER' }
  claimTeamTaskForSession(state, task.id, session, { targetProvider: 'claude', now: NOW + 3 })
  markTeamTaskRunning(state, task.id, { now: NOW + 4 })
  const clock = { at: NOW + 1000 }
  const tick = () => (clock.at += 1000)
  const report = (result, { warning = null, key } = {}) => {
    const at = tick()
    return reportTeamTaskTurn(state, task.id, {
      targetSessionId: 'sid-worker', result, warning, providerWorkGeneration: 1,
      reportKey: key || `claude:${at}`, observedAt: at, now: at,
    })
  }
  const declare = (summary = 'The summary it declared.') => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'sid-worker', fromChannel: 'C-WORKER', summary, requestId: 'complete-1',
    expectedProviderWorkGeneration: 1, now: tick(),
  })
  const release = () => releaseTeamTask(state, task.id, { sourceChannel: 'C-COORD', requestId: 'release-1', now: tick() })
  return { state, task, report, declare, release, tick }
}

test('a release delivers the first report after the declaration, not a later turn', () => {
  const t = runningTask()
  t.report('Progress before declaring.')
  t.declare()
  t.report('The real answer.')
  t.report('Noted.')
  t.report('Noted again.')
  assert.equal(t.task.result, 'Noted again.', 'until release, the latest reply is the latest result')

  t.release()
  assert.equal(t.task.status, 'completed')
  assert.equal(t.task.result, 'The real answer.')
})

test('a later turn with no text does not turn a clean task into a warning', () => {
  const t = runningTask()
  t.declare()
  t.report('The real answer.')
  t.report('', { warning: 'The provider turn ended without a stable final response.' })
  assert.ok(t.task.warning, 'precondition: the later turn left a warning')

  t.release()
  assert.equal(t.task.status, 'completed')
  assert.equal(t.task.warning, null)
  assert.equal(t.task.result, 'The real answer.')
})

test('a warning on the answer itself is kept', () => {
  const t = runningTask()
  t.declare()
  t.report('', { warning: 'The provider turn ended without a stable final response.' })
  t.report('Noted.')
  t.release()
  assert.equal(t.task.status, 'completed_with_warning')
  assert.equal(t.task.result, 'The summary it declared.', 'an answer with no text falls back to the declared summary')
})

test('provider event order decides, not journal order', () => {
  const t = runningTask()
  t.declare()
  const declaredAt = Date.parse(t.task.completionRequest.requestedAt)
  // A delayed Stop for the earlier turn is journaled after the later turn's.
  reportTeamTaskTurn(t.state, t.task.id, {
    targetSessionId: 'sid-worker', result: 'Noted.', providerWorkGeneration: 1,
    reportKey: 'claude:later', observedAt: declaredAt + 5000, now: declaredAt + 5000,
  })
  reportTeamTaskTurn(t.state, t.task.id, {
    targetSessionId: 'sid-worker', result: 'The real answer.', providerWorkGeneration: 1,
    reportKey: 'claude:earlier', observedAt: declaredAt + 1000, now: declaredAt + 6000,
  })
  t.release()
  assert.equal(t.task.result, 'The real answer.')
})

test('a report from before the declaration never becomes the answer', () => {
  const t = runningTask()
  t.report('Progress before declaring.')
  t.declare()
  assert.throws(() => t.release(), error => error.code === 'stale_task_report', 'nothing covers it yet')
  t.report('The real answer.')
  t.release()
  assert.equal(t.task.result, 'The real answer.')
})

test('the answer stays in the journal when delivered reports age out', () => {
  const t = runningTask()
  t.declare()
  const answer = t.report('The real answer.').report
  answer.deliveryStatus = 'delivered'
  for (let i = 0; i < TEAM_MAX_REPORTS + 8; i++) {
    const { report } = t.report(`Noted ${i}.`)
    report.deliveryStatus = 'delivered'
  }
  assert.ok(t.task.reports.length <= TEAM_MAX_REPORTS, 'the journal stays bounded')
  assert.ok(t.task.reports.includes(answer))
  t.release()
  assert.equal(t.task.result, 'The real answer.')
})

test('the answer stays in the journal when undelivered reports coalesce', () => {
  const t = runningTask()
  t.declare()
  const answer = t.report('The real answer.').report
  for (let i = 0; i < TEAM_MAX_REPORTS + 3; i++) t.report(`Noted ${i}.`)
  assert.equal(t.task.reports.length, TEAM_MAX_REPORTS)
  assert.ok(t.task.reports.includes(answer))
  assert.equal(t.task.reports.at(-1).result, `Noted ${TEAM_MAX_REPORTS + 2}.`, 'the newest report is last, for delivery')
  assert.equal(t.task.reports.at(-1).coalescedCount > 1, true)
  t.release()
  assert.equal(t.task.result, 'The real answer.')
})

test('the answer is kept even when it is the newest report at the cap', () => {
  const t = runningTask()
  for (let i = 0; i < TEAM_MAX_REPORTS - 1; i++) t.report(`Progress ${i}.`)
  t.declare()
  const answer = t.report('The real answer.').report
  assert.equal(t.task.reports.at(-1), answer)
  t.report('Noted.')
  assert.equal(t.task.reports.length, TEAM_MAX_REPORTS)
  assert.ok(t.task.reports.includes(answer))
  assert.equal(t.task.reports.at(-1).result, 'Noted.')
  t.release()
  assert.equal(t.task.result, 'The real answer.')
})
