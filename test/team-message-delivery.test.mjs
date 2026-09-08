import test from 'node:test'
import assert from 'node:assert/strict'
import {
  knownUndeliveredTeamMessage,
  recoverInterruptedTeamMessage,
  teamMessageFailureDisposition,
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
