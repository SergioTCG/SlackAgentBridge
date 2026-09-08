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

export function recoverInterruptedTeamMessage(message) {
  if (!message || message.providerDeliveryStatus !== 'delivering') return false
  message.providerDeliveryStatus = 'uncertain'
  message.deliveryStatus = 'failed'
  message.deliveryError = 'Provider delivery outcome became uncertain during daemon restart; SAB did not replay this task message.'
  return true
}

export function teamReportLifecycleNotice(task) {
  const status = String(task?.status || 'unknown')
  if (status === 'awaiting_release') {
    return task?.completionRequest && !task?.pendingGates?.length
      ? '\n\n✅ The worker declared this task ready; the coordinator may release it.'
      : '\n\nThe worker remains reserved. Send a follow-up or wait for an explicit readiness declaration.'
  }
  if (['completed', 'completed_with_warning', 'failed', 'cancelled'].includes(status)) {
    return `\n\nThis task is now \`${status}\`; no release action is pending.`
  }
  return `\n\nThe task is currently \`${status}\`; this report is historical and no release action is available yet.`
}
