import test from 'node:test'
import assert from 'node:assert/strict'
import {
  continuationFor, setContinuationMode, queueContinuation, claimContinuation, settleContinuation,
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
