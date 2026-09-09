import test from 'node:test'
import assert from 'node:assert/strict'
import {
  knownUndeliveredTeamMessage,
  recoverInterruptedTeamMessage,
  teamReportLifecycleNotice,
  teamMessageFailureDisposition,
  undeliveredTeamMessagePredecessor,
} from '../daemon/team-message-delivery.mjs'

test('a disconnected Pi stream remains retryable when no provider write occurred', () => {
  const error = knownUndeliveredTeamMessage('Pi input stream is disconnected')
  assert.deepEqual(teamMessageFailureDisposition({ providerAttempted: true, error }), {
    providerDeliveryStatus: null,
    deliveryStatus: 'pending',
    retryable: true,
  })
})

test('a possibly completed provider write remains uncertain and is never replayed', () => {
  assert.deepEqual(teamMessageFailureDisposition({
    providerAttempted: true,
    error: new Error('tmux write outcome unknown'),
  }), {
    providerDeliveryStatus: 'uncertain',
    deliveryStatus: 'failed',
    retryable: false,
  })
})

test('restart recovery makes an interrupted provider write durably uncertain exactly once', () => {
  const message = {
    providerDeliveryStatus: 'delivering',
    deliveryStatus: 'pending',
    deliveryError: null,
  }
  assert.equal(recoverInterruptedTeamMessage(message), true)
  assert.deepEqual(message, {
    providerDeliveryStatus: 'uncertain',
    deliveryStatus: 'failed',
    deliveryError: 'Provider delivery outcome became uncertain during daemon restart; SAB did not replay this task message.',
  })
  assert.equal(recoverInterruptedTeamMessage(message), false)
})

test('coordinator messages remain ordered behind every unsettled predecessor', () => {
  const first = { id: 'message-1', deliveryStatus: 'pending', providerDeliveryStatus: null }
  const second = { id: 'message-2', deliveryStatus: 'pending', providerDeliveryStatus: null }
  const task = { messages: [first, second] }
  assert.equal(undeliveredTeamMessagePredecessor(task, first), null)
  assert.equal(undeliveredTeamMessagePredecessor(task, second), first)
  first.deliveryStatus = 'delivered'
  first.providerDeliveryStatus = 'delivered'
  assert.equal(undeliveredTeamMessagePredecessor(task, second), null)
})

test('delayed worker reports require a post-declaration report before release advice', () => {
  assert.match(teamReportLifecycleNotice({
    status: 'awaiting_release', completionRequest: {
      requestId: 'ready', workGeneration: 1, lifecycleVersion: 5,
      requestedAt: new Date(5000).toISOString(),
    },
    pendingGates: [], workGeneration: 1, providerWorkGeneration: 1,
    reports: [{
      workGeneration: 1, lifecycleVersion: 6, observedAt: new Date(6000).toISOString(),
    }], messages: [],
  }), /may release/)
  assert.doesNotMatch(teamReportLifecycleNotice({
    status: 'awaiting_release', completionRequest: {
      requestId: 'ready', workGeneration: 1, lifecycleVersion: 5,
      requestedAt: new Date(5000).toISOString(),
    },
    pendingGates: [], workGeneration: 1, providerWorkGeneration: 1,
    reports: [{
      workGeneration: 1, lifecycleVersion: 7, observedAt: new Date(4000).toISOString(),
    }], messages: [],
  }), /may release/)
  assert.match(teamReportLifecycleNotice({
    status: 'awaiting_release', completionRequest: null, pendingGates: [],
  }), /remains reserved/)
  assert.match(teamReportLifecycleNotice({
    status: 'running', completionRequest: { requestId: 'stale' }, pendingGates: [],
  }), /currently `running`/)
  assert.doesNotMatch(teamReportLifecycleNotice({
    status: 'running', completionRequest: { requestId: 'stale' }, pendingGates: [],
  }), /may release/)
  for (const status of ['completed', 'completed_with_warning', 'failed', 'cancelled']) {
    const notice = teamReportLifecycleNotice({
      status, completionRequest: { requestId: 'stale' }, pendingGates: [],
    })
    assert.match(notice, /no release action is pending/)
    assert.doesNotMatch(notice, /remains reserved|may release/)
  }
})
