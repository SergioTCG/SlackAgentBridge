import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claimContinuationDispatchAuthority, clearContinuationWaiting, coalesceContinuations, continuationFor, noteContinuationWaiting,
  observeIdleCodexCoordinator, setContinuationMode, queueContinuation, claimContinuation, settleContinuation,
  shouldWakeForTeamReply,
} from '../daemon/team-continuation.mjs'
import { assertCoordinatorDispatch, beginCollaboratorTeamTurn, beginOwnerTeamTurn } from '../daemon/teams.mjs'

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

test('an authenticated worker event renews one exhausted coordinator dispatch budget', () => {
  const team = { id: 'team_1' }
  setContinuationMode(team, 'auto-until-blocked', { now: 1000 })
  queueContinuation(team, { taskId: 'task_1', kind: 'reply', replyId: 'reply_1', now: 2000 })
  queueContinuation(team, { taskId: 'task_1', kind: 'completed', now: 3000 })
  const session = {}
  beginOwnerTeamTurn(session, { messageTs: '1.2' }, { now: 1500, budget: 1 })
  session.teamTurn.remaining = 0

  const claimed = claimContinuationDispatchAuthority(team, session, { now: 4000, budget: 20 })
  assert.equal(claimed.coalescedCount, 2)
  assert.equal(session.teamTurn.actor, 'continuation')
  assert.equal(session.teamTurn.teamId, team.id)
  assert.equal(session.teamTurn.eventId, claimed.event.id)
  assert.equal(session.teamTurn.remaining, 20)
  assert.equal(continuationFor(team).pending.length, 0)
  assert.equal(continuationFor(team).active, null)
  assert.doesNotThrow(() => assertCoordinatorDispatch(session, {
    now: 5000, teamId: team.id, allowContinuation: true,
  }))
  assert.equal(claimContinuationDispatchAuthority(team, session, { now: 6000 }), null)
})

test('continuation events cannot renew collaborator, unrelated-team, or manual authority', () => {
  const automatic = { id: 'team_1' }
  setContinuationMode(automatic, 'auto-until-blocked', { now: 1000 })
  queueContinuation(automatic, { taskId: 'task_1', now: 2000 })
  const collaborator = {}
  beginCollaboratorTeamTurn(collaborator, { messageTs: '1.3' }, { now: 1500 })
  assert.equal(claimContinuationDispatchAuthority(automatic, collaborator, { now: 3000 }), null)

  const unrelated = { teamTurn: {
    actor: 'continuation', teamId: 'team_other', eventId: 'team_event_old',
    startedAt: new Date(1000).toISOString(), expiresAt: new Date(2000).toISOString(), remaining: 0,
  } }
  assert.equal(claimContinuationDispatchAuthority(automatic, unrelated, { now: 3000 }), null)

  const manual = { id: 'team_manual', continuation: { mode: 'manual', pending: [{ id: 'team_event_queued' }] } }
  const owner = {}
  beginOwnerTeamTurn(owner, { messageTs: '1.4' }, { now: 1000, budget: 1 })
  owner.teamTurn.remaining = 0
  assert.equal(claimContinuationDispatchAuthority(manual, owner, { now: 3000 }), null)
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
