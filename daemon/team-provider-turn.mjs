const HISTORY_LIMIT = 8

function normalizedTurn(value, startedAt = Date.now(), providerTurnId = null) {
  const taskId = String(value?.taskId || '')
  const providerWorkGeneration = Number(value?.providerWorkGeneration)
  if (!taskId || !Number.isSafeInteger(providerWorkGeneration) || providerWorkGeneration < 1) return null
  const start = Number(startedAt)
  return {
    taskId,
    providerWorkGeneration,
    startedAt: Number.isSafeInteger(start) && start > 0 ? start : Date.now(),
    providerTurnId: providerTurnId ? String(providerTurnId) : null,
    inheritProviderTurnId: value?.inheritProviderTurnId === true,
  }
}

function publicTurn(value) {
  return value ? {
    taskId: value.taskId,
    providerWorkGeneration: value.providerWorkGeneration,
  } : null
}

// A tmux poller observation spans asynchronous pane, process, and Slack checks.
// Keep the task generation it began with immutable, and invalidate it whenever
// accepted coordinator input advances the poller's generation. An old idle
// pane must never be re-labelled as proof for work accepted while the tick was
// awaiting I/O.
export function beginTeamProviderPollerObservation(poller) {
  if (!poller) return null
  const turn = publicTurn(poller.teamTaskTurn)
  return Object.freeze({
    revision: Number(poller.teamTaskRevision) || 0,
    teamTaskTurn: turn ? Object.freeze(turn) : null,
  })
}

export function refreshTeamProviderPollerTurn(poller, turn) {
  const snapshot = publicTurn(turn)
  if (!poller || !snapshot) return null
  poller.teamTaskTurn = Object.freeze(snapshot)
  poller.teamTaskRevision = (Number(poller.teamTaskRevision) || 0) + 1
  return poller.teamTaskTurn
}

export function teamProviderPollerObservationCurrent(poller, observation) {
  return Boolean(poller && observation && !poller.stopped &&
    (Number(poller.teamTaskRevision) || 0) === observation.revision)
}

function sameLogicalTurn(left, right) {
  return left?.taskId === right?.taskId &&
    left?.providerWorkGeneration === right?.providerWorkGeneration &&
    (!left.providerTurnId || !right.providerTurnId || left.providerTurnId === right.providerTurnId)
}

function rememberPrevious(session, value) {
  if (!value) return
  const history = Array.isArray(session.teamProviderTurnHistory)
    ? session.teamProviderTurnHistory.filter(item => item?.taskId && Number(item?.providerWorkGeneration) > 0)
    : []
  const duplicate = history.findIndex(item => item.providerTurnId &&
    item.providerTurnId === value.providerTurnId)
  if (duplicate >= 0) history.splice(duplicate, 1)
  history.push(value)
  session.teamProviderTurnHistory = history.slice(-HISTORY_LIMIT)
}

export function hasTeamProviderTurnTracking(session) {
  return Boolean(session?.teamProviderTurn || session?.teamProviderTurnPending ||
    session?.teamProviderTurnHistory?.length)
}

export function stageTeamProviderTurn(session, turn, { now = Date.now() } = {}) {
  const staged = normalizedTurn(turn, now)
  if (!session || !staged) return null
  session.teamProviderTurnPending = {
    taskId: staged.taskId,
    providerWorkGeneration: staged.providerWorkGeneration,
    stagedAt: staged.startedAt,
    inheritProviderTurnId: staged.inheritProviderTurnId,
  }
  return publicTurn(staged)
}

export function discardPendingTeamProviderTurn(session, expected = null) {
  const pending = session?.teamProviderTurnPending
  if (!pending) return false
  if (expected && (pending.taskId !== expected.taskId ||
      pending.providerWorkGeneration !== expected.providerWorkGeneration)) return false
  delete session.teamProviderTurnPending
  return true
}

export function pendingTeamProviderTurn(session, expected = null) {
  const pending = normalizedTurn(session?.teamProviderTurnPending,
    session?.teamProviderTurnPending?.stagedAt)
  if (!pending) return null
  if (expected?.taskId && pending.taskId !== expected.taskId) return null
  if (expected?.providerWorkGeneration != null &&
      pending.providerWorkGeneration !== Number(expected.providerWorkGeneration)) return null
  return publicTurn(pending)
}

// Both delegated-task envelopes and coordinator follow-ups carry a private,
// provider-visible task identity. A prompt hook can use this marker to promote
// a staged generation after a tmux write whose return status was uncertain.
export function providerPromptTurnMarker(prompt) {
  const tag = /<sab-team-(?:task|message)\b([^>]*)>/.exec(String(prompt || ''))
  if (!tag) return null
  const taskId = /\b(?:id|task)="(task_[A-Za-z0-9_-]+)"/.exec(tag[1])?.[1]
  if (!taskId) return null
  const rawGeneration = /\bgeneration="([1-9][0-9]*)"/.exec(tag[1])?.[1]
  const providerWorkGeneration = rawGeneration ? Number(rawGeneration) : null
  if (providerWorkGeneration !== null && !Number.isSafeInteger(providerWorkGeneration)) return null
  return { taskId, providerWorkGeneration }
}

export function activateTeamProviderTurn(session, {
  turn = null,
  providerTurnId = null,
  startedAt = Date.now(),
} = {}) {
  if (!session) return null
  const source = turn || session.teamProviderTurnPending
  let next = normalizedTurn(source, startedAt, providerTurnId)
  if (!next) return null
  const current = normalizedTurn(session.teamProviderTurn,
    session.teamProviderTurn?.startedAt, session.teamProviderTurn?.providerTurnId)
  if (current && next.inheritProviderTurnId && !next.providerTurnId &&
      current.taskId === next.taskId) {
    next = { ...next, providerTurnId: current.providerTurnId }
  }
  // A delayed UserPromptSubmit hook may resume after a coordinator follow-up
  // has already advanced this task. Preserve the observed older native turn in
  // history, but never let it replace the newer accepted work generation.
  if (current && current.taskId === next.taskId &&
      current.providerWorkGeneration > next.providerWorkGeneration) {
    if (current.inheritProviderTurnId && !current.providerTurnId && next.providerTurnId) {
      session.teamProviderTurn = { ...current, providerTurnId: next.providerTurnId }
    }
    rememberPrevious(session, next)
    discardPendingTeamProviderTurn(session, next)
    return publicTurn(session.teamProviderTurn || current)
  }
  if (current && sameLogicalTurn(current, next)) {
    session.teamProviderTurn = {
      ...current,
      providerTurnId: current.providerTurnId || next.providerTurnId,
      startedAt: Math.min(current.startedAt, next.startedAt),
    }
  } else {
    rememberPrevious(session, current)
    session.teamProviderTurn = next
  }
  discardPendingTeamProviderTurn(session, next)
  return publicTurn(session.teamProviderTurn)
}

export function retireTeamProviderTurn(session) {
  if (!session) return false
  const current = normalizedTurn(session.teamProviderTurn,
    session.teamProviderTurn?.startedAt, session.teamProviderTurn?.providerTurnId)
  const changed = Boolean(current || session.teamProviderTurnPending)
  rememberPrevious(session, current)
  delete session.teamProviderTurn
  delete session.teamProviderTurnPending
  return changed
}

export function providerTurnForCompletion(session, {
  providerTurnId = null,
  observedAt = null,
} = {}) {
  if (!session) return null
  const current = normalizedTurn(session.teamProviderTurn,
    session.teamProviderTurn?.startedAt, session.teamProviderTurn?.providerTurnId)
  const history = (Array.isArray(session.teamProviderTurnHistory) ? session.teamProviderTurnHistory : [])
    .map(item => normalizedTurn(item, item?.startedAt, item?.providerTurnId))
    .filter(Boolean)
  const candidates = [...history, current].filter(Boolean)
  const observed = Number(observedAt)
  const hasObservedAt = Number.isSafeInteger(observed) && observed > 0
  const latest = values => values
    .filter(item => !hasObservedAt || item.startedAt <= observed)
    .sort((left, right) => right.startedAt - left.startedAt ||
      right.providerWorkGeneration - left.providerWorkGeneration)[0]
  const nativeId = providerTurnId ? String(providerTurnId) : null
  if (nativeId) {
    // A coordinator follow-up can steer an already-running native turn, so the
    // old and new work generations may deliberately share one native id. Use
    // the hook observation time (or the newest generation when absent) rather
    // than the history array's insertion order.
    const exactCandidates = candidates.filter(item => item.providerTurnId === nativeId)
    const exact = latest(exactCandidates)
    if (exact) return publicTurn(exact)
    if (exactCandidates.length) return null
    // Once the current turn has a different native identity, an unknown final
    // is not allowed to borrow it merely because it arrived later.
    // An inherited identity means the follow-up may have steered the existing
    // native turn, but it may also have started a distinct turn after the old
    // final ended. Until a prompt hook replaces it, use the event boundary to
    // resolve a different native id instead of treating the copied id as final.
    if (current?.providerTurnId && !current.inheritProviderTurnId) return null
  }
  if (hasObservedAt) return publicTurn(latest(candidates))
  return publicTurn(current)
}
