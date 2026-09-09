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
  // Coordinator follow-ups can deliberately steer one native provider turn,
  // so several work generations may share its native ID. Collapse only the
  // same logical task generation; dropping an older generation would make a
  // delayed final impossible to fence by its observation boundary.
  const duplicate = history.findIndex(item => item.taskId === value.taskId &&
    Number(item.providerWorkGeneration) === value.providerWorkGeneration)
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

export function discardPendingTeamProviderTurn(session, expected = null, { preserveDeferred = false } = {}) {
  const pending = session?.teamProviderTurnPending
  if (!pending) return false
  if (expected && (pending.taskId !== expected.taskId ||
      pending.providerWorkGeneration !== expected.providerWorkGeneration)) return false
  if (!preserveDeferred) clearDeferredTeamProviderFinal(session, pending)
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

function clonedJsonObject(value) {
  if (!value || typeof value !== 'object') return null
  try { return JSON.parse(JSON.stringify(value)) }
  catch { return null }
}

// A Stop/final can overtake the callback that settles a multi-step provider
// input write. Preserve that final behind the exact staged generation instead
// of borrowing the preceding generation or dropping it. The daemon releases
// this journal only after the submission is promoted or provably rejected.
export function deferPendingTeamProviderFinal(session, {
  provider,
  providerTurnId = null,
  observedAt = null,
  lastAssistantMessage = '',
  usage = null,
  contextUsage = null,
} = {}) {
  const pending = normalizedTurn(session?.teamProviderTurnPending,
    session?.teamProviderTurnPending?.stagedAt)
  if (!session || !pending || !['claude', 'codex', 'pi'].includes(provider)) return null
  const observed = Number(observedAt)
  if (Number.isSafeInteger(observed) && observed > 0 && observed < pending.startedAt) return null
  const existing = session.teamProviderTurnDeferredFinal
  if (existing && (existing.taskId !== pending.taskId ||
      Number(existing.providerWorkGeneration) !== pending.providerWorkGeneration)) return null
  session.teamProviderTurnDeferredFinal = {
    taskId: pending.taskId,
    providerWorkGeneration: pending.providerWorkGeneration,
    provider,
    providerTurnId: providerTurnId ? String(providerTurnId) : null,
    observedAt: Number.isSafeInteger(observed) && observed > 0 ? observed : null,
    lastAssistantMessage: String(lastAssistantMessage || existing?.lastAssistantMessage || ''),
    usage: clonedJsonObject(usage) || existing?.usage || null,
    contextUsage: clonedJsonObject(contextUsage) || existing?.contextUsage || null,
  }
  return publicTurn(pending)
}

export function deferredTeamProviderFinal(session, expected = null) {
  const record = session?.teamProviderTurnDeferredFinal
  const turn = normalizedTurn(record, record?.observedAt || Date.now(), record?.providerTurnId)
  if (!record || !turn || !['claude', 'codex', 'pi'].includes(record.provider)) return null
  if (expected && (turn.taskId !== expected.taskId ||
      turn.providerWorkGeneration !== Number(expected.providerWorkGeneration))) return null
  return {
    ...publicTurn(turn),
    provider: record.provider,
    providerTurnId: record.providerTurnId ? String(record.providerTurnId) : null,
    observedAt: Number.isSafeInteger(Number(record.observedAt)) && Number(record.observedAt) > 0
      ? Number(record.observedAt) : null,
    lastAssistantMessage: String(record.lastAssistantMessage || ''),
    usage: clonedJsonObject(record.usage),
    contextUsage: clonedJsonObject(record.contextUsage),
  }
}

export function clearDeferredTeamProviderFinal(session, expected = null) {
  const record = deferredTeamProviderFinal(session, expected)
  if (!record) return false
  delete session.teamProviderTurnDeferredFinal
  return true
}

// Promote only the exact durable generation staged before provider delivery.
// Calling activateTeamProviderTurn without an explicit turn preserves pending
// metadata such as inheritProviderTurnId across a daemon restart.
export function activatePendingTeamProviderTurn(session, expected, {
  providerTurnId = null,
  startedAt = null,
} = {}) {
  const pending = normalizedTurn(session?.teamProviderTurnPending,
    session?.teamProviderTurnPending?.stagedAt)
  if (!pending || !pendingTeamProviderTurn(session, expected)) return null
  // The transport can return after the provider has already emitted its Stop
  // event. Keep the boundary journaled before submission so event ordering does
  // not depend on when this promotion callback happened to run.
  const boundary = startedAt == null ? pending.startedAt : startedAt
  return activateTeamProviderTurn(session, { providerTurnId, startedAt: boundary })
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

export function providerPromptAcknowledgesTask(session, {
  taskId,
  currentGeneration,
  promptTurn,
  submittedTurn,
  injected = false,
  pending = false,
} = {}) {
  const generation = Number(currentGeneration)
  if (!taskId || promptTurn?.taskId !== taskId || !Number.isSafeInteger(generation) || generation < 1) return false
  const exactGeneration = promptTurn.providerWorkGeneration === generation
  const legacyGeneration = promptTurn.providerWorkGeneration == null && generation === 1 &&
    !hasTeamProviderTurnTracking(session)
  const durableTurn = submittedTurn?.taskId === taskId &&
    submittedTurn.providerWorkGeneration === promptTurn.providerWorkGeneration
  return (exactGeneration || legacyGeneration) &&
    (injected || pending || durableTurn || legacyGeneration)
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
    discardPendingTeamProviderTurn(session, next, { preserveDeferred: true })
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
  discardPendingTeamProviderTurn(session, next, { preserveDeferred: true })
  return publicTurn(session.teamProviderTurn)
}

export function retireTeamProviderTurn(session) {
  if (!session) return false
  const current = normalizedTurn(session.teamProviderTurn,
    session.teamProviderTurn?.startedAt, session.teamProviderTurn?.providerTurnId)
  const changed = Boolean(current || session.teamProviderTurnPending || session.teamProviderTurnDeferredFinal)
  rememberPrevious(session, current)
  delete session.teamProviderTurn
  delete session.teamProviderTurnPending
  delete session.teamProviderTurnDeferredFinal
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

// Resolve the provider generation represented by a final while an exact task
// is currently bound to the session. A delayed final may legitimately resolve
// to a historical task: callers must retain that identity so they can reject
// its lifecycle mutation and discard only its stale transcript prefix.
export function providerTurnForTaskLifecycle(session, {
  taskId,
  providerWorkGeneration,
  providerTurnId = null,
  observedAt = null,
} = {}) {
  const activeTaskId = String(taskId || '')
  const generation = Number(providerWorkGeneration)
  if (!activeTaskId || !Number.isSafeInteger(generation) || generation < 1) return null
  const tracked = providerTurnForCompletion(session, { providerTurnId, observedAt })
  if (tracked) return publicTurn(tracked)
  if (hasTeamProviderTurnTracking(session)) return null
  return { taskId: activeTaskId, providerWorkGeneration: generation }
}
