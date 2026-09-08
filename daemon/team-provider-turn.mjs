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
  }
}

function publicTurn(value) {
  return value ? {
    taskId: value.taskId,
    providerWorkGeneration: value.providerWorkGeneration,
  } : null
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

export function activateTeamProviderTurn(session, {
  turn = null,
  providerTurnId = null,
  startedAt = Date.now(),
} = {}) {
  if (!session) return null
  const source = turn || session.teamProviderTurnPending
  const next = normalizedTurn(source, startedAt, providerTurnId)
  if (!next) return null
  const current = normalizedTurn(session.teamProviderTurn,
    session.teamProviderTurn?.startedAt, session.teamProviderTurn?.providerTurnId)
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
  const nativeId = providerTurnId ? String(providerTurnId) : null
  if (nativeId) {
    const exact = candidates.find(item => item.providerTurnId === nativeId)
    if (exact) return publicTurn(exact)
    // Once the current turn has a different native identity, an unknown final
    // is not allowed to borrow it merely because it arrived later.
    if (current?.providerTurnId) return null
  }
  const observed = Number(observedAt)
  if (Number.isSafeInteger(observed) && observed > 0) {
    const temporal = candidates
      .filter(item => item.startedAt <= observed)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    return publicTurn(temporal)
  }
  return publicTurn(current)
}
