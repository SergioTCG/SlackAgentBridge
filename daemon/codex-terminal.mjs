// Codex can reject a turn in the TUI before emitting its normal Stop hook.
// Keep this grammar deliberately narrow and confined to the current visible
// tail: model output may legitimately quote provider errors, and an old
// capacity banner may remain in scrollback while a later turn is healthy.

export const CODEX_FAILURE_CONFIRMATIONS = 2
export const CODEX_FAILURE_TAIL_LINES = 12

const stripTerminalControls = value => String(value || '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\r/g, '')

const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
const capacityPattern = /^⚠(?:️)?\s*Selected model is at capacity\. Please try a different model\.$/i

export function codexTerminalFailure(pane) {
  const rendered = stripTerminalControls(pane).split('\n')
  while (rendered.length && !rendered.at(-1).trim()) rendered.pop()
  const lines = rendered.slice(-CODEX_FAILURE_TAIL_LINES)

  // Codex may wrap the fixed banner at narrow terminal widths. Match at most
  // three complete adjacent rendered lines and require the warning glyph plus
  // the exact provider sentence; never accept a conversational substring.
  for (let start = 0; start < lines.length; start++) {
    for (let length = 1; length <= 3 && start + length <= lines.length; length++) {
      const text = compact(lines.slice(start, start + length).join(' '))
      if (capacityPattern.test(text)) {
        return {
          key: 'model_capacity',
          text: 'Selected model is at capacity. Please try a different model.',
        }
      }
    }
  }
  return null
}

export function codexTerminalFailureDecision({
  pane = '',
  ready = false,
  previousKey = null,
  confirmations = 0,
} = {}) {
  if (!ready) return { action: 'none', key: null, confirmations: 0, failure: null }
  const failure = codexTerminalFailure(pane)
  if (!failure) return { action: 'none', key: null, confirmations: 0, failure: null }

  const nextConfirmations = previousKey === failure.key ? confirmations + 1 : 1
  if (nextConfirmations < CODEX_FAILURE_CONFIRMATIONS) {
    return { action: 'wait', key: failure.key, confirmations: nextConfirmations, failure: null }
  }
  return {
    action: 'failure', key: failure.key, confirmations: nextConfirmations, failure,
  }
}

// A coordinator follow-up may reuse the same native Codex process and poller,
// but terminal failure and idle observations belong to one exact work
// generation. Never let the preceding generation finalize the next one.
export function resetCodexPollerEvidence(poller) {
  if (!poller) return null
  poller.failureKey = null
  poller.failureConfirmations = 0
  poller.idleObservation = null
  return poller
}

const normalizedTurnStart = value => {
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : Date.now()
}

// Transport acceptance precedes Codex's prompt hook. Keep that earlier boundary
// only until the first matching native prompt can identify the same turn.
export function recordCodexTransportTurnStart(session, startedAt = Date.now()) {
  if (!session || session.codexTurnStartedAt) return false
  session.codexTurnStartedAt = normalizedTurnStart(startedAt)
  session.codexTurnAwaitingPromptHook = true
  delete session.codexTurnId
  return true
}

// A prompt hook for another, newer native turn must replace the old lifecycle
// timestamp. Otherwise a delayed final observed before this prompt could still
// appear current. Duplicate hooks and the first hook after transport acceptance
// retain the earlier boundary; an older delayed hook cannot roll time backward.
export function recordCodexPromptTurnStart(session, { startedAt = Date.now(), turnId = null } = {}) {
  if (!session) return false
  const nextStart = normalizedTurnStart(startedAt)
  const previousStart = Number(session.codexTurnStartedAt)
  const hasPrevious = Number.isSafeInteger(previousStart) && previousStart > 0
  const nativeTurnId = typeof turnId === 'string' && turnId ? turnId : null
  const awaitingHook = session.codexTurnAwaitingPromptHook === true
  const duplicateHook = Boolean(nativeTurnId && session.codexTurnId === nativeTurnId)

  if (hasPrevious && !duplicateHook && nextStart < previousStart) return false

  const resolvedStart = hasPrevious && (awaitingHook || duplicateHook)
    ? Math.min(previousStart, nextStart)
    : nextStart
  const changed = session.codexTurnStartedAt !== resolvedStart ||
    session.codexTurnAwaitingPromptHook === true ||
    (session.codexTurnId || null) !== nativeTurnId
  session.codexTurnStartedAt = resolvedStart
  if (nativeTurnId) session.codexTurnId = nativeTurnId
  else delete session.codexTurnId
  delete session.codexTurnAwaitingPromptHook
  return changed
}
