const KNOWN_NOT_DELIVERED = 'known_not_delivered'

export function knownUndeliveredTeamMessage(message) {
  const error = new Error(String(message || 'The provider input surface did not accept the message.'))
  error.teamMessageDeliveryOutcome = KNOWN_NOT_DELIVERED
  return error
}

export function teamMessageFailureDisposition({ providerAttempted = false, error = null } = {}) {
  const retryable = error?.teamMessageDeliveryOutcome === KNOWN_NOT_DELIVERED
  return {
    providerDeliveryStatus: retryable ? null : providerAttempted ? 'uncertain' : null,
    deliveryStatus: retryable ? 'pending' : 'failed',
    retryable,
  }
}
