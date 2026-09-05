import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clearContinuationWaiting, coalesceContinuations, continuationFor, noteContinuationWaiting,
  observeIdleCodexCoordinator, setContinuationMode, queueContinuation, claimContinuation, settleContinuation,
  shouldWakeForTeamReply,
} from '../daemon/team-continuation.mjs'

test('continuations remain disabled by default and duplicate events are idempotent', () => {
  const team = { id: 'team_1' }
  assert.equal(queueContinuation(team, { taskId: 'task_1' }).created, false)
  setContinuationMode(team, 'auto-until-blocked')
  const first = queueContinuation(team, { taskId: 'task_1', kind: 'completed' })
  const duplicate = queueContinuation(team, { taskId: 'task_1', kind: 'completed' })
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(continuationFor(team).pending.length, 1)
})

test('automatic coordination wakes for ordinary and dispatch-healing worker replies', () => {
  const automatic = { continuation: { mode: 'auto-until-blocked' } }
  const manual = { continuation: { mode: 'manual' } }
  assert.equal(shouldWakeForTeamReply(automatic, { created: true, accepted: true }), true)
  assert.equal(shouldWakeForTeamReply(automatic, { created: false, accepted: true }), true)
  assert.equal(shouldWakeForTeamReply(automatic, { created: true, accepted: false }), true)
  assert.equal(shouldWakeForTeamReply(automatic, { created: false, accepted: false }), false)
  assert.equal(shouldWakeForTeamReply(manual, { created: true, accepted: true }), false)
})

test('continuation claim and settlement survive one event at a time', () => {
  const team = { id: 'team_1' }
  setContinuationMode(team, 'auto-until-blocked')
  const { event } = queueContinuation(team, { taskId: 'task_1', kind: 'blocked' })
  const claimed = claimContinuation(team)
  assert.equal(claimed.id, event.id)
  assert.equal(claimContinuation(team), null)
  const settled = settleContinuation(team, event.id, { status: 'succeeded' })
  assert.equal(settled.status, 'succeeded')
  assert.equal(continuationFor(team).active, null)
})

test('invalid continuation mode is rejected', () => {
  assert.throws(() => setContinuationMode({}, 'always'), /Unknown team continuation mode/)
})

test('one continuation wake durably subsumes the current event backlog', () => {
  const team = { id: 'team_1' }
  setContinuationMode(team, 'auto-until-blocked')
  const first = queueContinuation(team, { taskId: 'task_1', kind: 'reply', replyId: 'reply_1', now: 1000 }).event
  queueContinuation(team, { taskId: 'task_1', kind: 'completed', now: 2000 })
  const latest = queueContinuation(team, { taskId: 'task_2', kind: 'completed', now: 3000 }).event

  const result = coalesceContinuations(team, { now: 4000 })
  assert.equal(result.changed, true)
  assert.equal(result.count, 3)
  assert.equal(result.event.id, latest.id)
  assert.equal(result.event.firstCreatedAt, first.createdAt)
  assert.deepEqual(result.event.coalescedTaskIds, ['task_1', 'task_2'])
  assert.equal(continuationFor(team).pending.length, 1)
  assert.equal(queueContinuation(team, {
    taskId: 'task_1', kind: 'reply', replyId: 'reply_1', now: 5000,
  }).created, false)
  queueContinuation(team, { taskId: 'task_3', kind: 'failed', now: 6000 })
  assert.equal(coalesceContinuations(team, { now: 7000 }).count, 4)
  assert.deepEqual(continuationFor(team).pending[0].coalescedTaskIds, ['task_1', 'task_2', 'task_3'])
})

test('idle Codex coordinator release requires aged fences and two identical ready observations', () => {
  const session = {
    id: 'sid-master', pid: 123, tmux: 'sab-master',
    teamTurn: { actor: 'owner', startedAt: new Date(1000).toISOString() },
    teamInputReservation: { source: 'slack', acceptedAt: new Date(2000).toISOString() },
  }
  const early = observeIdleCodexCoordinator(session, { ready: true, now: 10_000 })
  assert.equal(early.action, 'wait')
  const first = observeIdleCodexCoordinator(session, { ready: true, now: 20_000 })
  assert.equal(first.action, 'confirm')
  const second = observeIdleCodexCoordinator(session, {
    ready: true, now: 25_000, previous: first.observation,
  })
  assert.equal(second.action, 'release')

  session.pid = 456
  assert.equal(observeIdleCodexCoordinator(session, {
    ready: true, now: 25_000, previous: first.observation,
  }).action, 'confirm')
  session.pid = 123

  session.teamTurn.startedAt = new Date(24_000).toISOString()
  assert.equal(observeIdleCodexCoordinator(session, {
    ready: true, now: 25_000, previous: first.observation,
  }).action, 'wait')
  session.teamActiveTaskId = 'task_running'
  assert.equal(observeIdleCodexCoordinator(session, { ready: true, now: 50_000 }).action, 'reset')
  delete session.teamActiveTaskId
  assert.equal(observeIdleCodexCoordinator(session, { ready: false, now: 50_000 }).action, 'reset')
  assert.equal(observeIdleCodexCoordinator({ teamTurn: {} }, { ready: true, now: 50_000 }).action, 'blocked')
})

test('coordinator wait notices are delayed, deduplicated, and clearable', () => {
  const team = { id: 'team_1' }
  setContinuationMode(team, 'auto-until-blocked', { now: 1000 })
  assert.deepEqual(noteContinuationWaiting(team, 'owner turn', { now: 2000, noticeAfterMs: 5000 }), {
    changed: true, notify: false, waiting: team.continuation.waiting,
  })
  assert.equal(noteContinuationWaiting(team, 'owner turn', { now: 6000, noticeAfterMs: 5000 }).notify, false)
  assert.equal(noteContinuationWaiting(team, 'owner turn', { now: 7000, noticeAfterMs: 5000 }).notify, true)
  assert.equal(noteContinuationWaiting(team, 'owner turn', { now: 8000, noticeAfterMs: 5000 }).notify, false)
  assert.equal(clearContinuationWaiting(team), true)
  assert.equal(clearContinuationWaiting(team), false)
})
