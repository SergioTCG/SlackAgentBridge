export const CODEX_COMMENTARY_HISTORY_LIMIT = 128
export const CODEX_COMMENTARY_MAX_CHARS = 6000
export const CODEX_FINAL_HISTORY_LIMIT = 128
export const CODEX_FINAL_MAX_CHARS = 256 << 10

const validIdentity = value => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)

function boundedText(value, maxChars) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (text.length <= maxChars) return text
  let bounded = text.slice(0, maxChars - 1)
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1)
  return `${bounded.trimEnd()}…`
}

function finalAnswer(threadId, turnId, item) {
  if (!validIdentity(threadId) || !validIdentity(turnId) || !validIdentity(item?.id)) return null
  if (item.type !== 'agentMessage' || item.phase !== 'final_answer') return null
  const text = boundedText(item.text, CODEX_FINAL_MAX_CHARS)
  return text ? { threadId, turnId, itemId: item.id, text } : null
}

// App Server carries command output, diffs, plans, reasoning, and assistant
// messages over the same connection. Select only completed, explicitly
// user-facing commentary here; the final selector below additionally requires
// the exact successful turn completion.
export function commentaryFromAppServerMessage(message) {
  if (message?.method !== 'item/completed') return null
  const { threadId, turnId, item } = message.params || {}
  if (!validIdentity(threadId) || !validIdentity(turnId) || !validIdentity(item?.id)) return null
  if (item.type !== 'agentMessage' || item.phase !== 'commentary') return null
  const bounded = boundedText(item.text, CODEX_COMMENTARY_MAX_CHARS)
  if (!bounded) return null
  return {
    threadId,
    turnId,
    itemId: item.id,
    text: bounded,
  }
}

// Codex can complete an App Server turn without dispatching its configured
// Stop hook (openai/codex#38213). The protocol's completed final_answer item is
// the supported fallback source; terminal rendering and rollout JSONL remain
// deliberately out of scope.
export function finalAnswerItemFromAppServerMessage(message) {
  if (message?.method !== 'item/completed') return null
  const { threadId, turnId, item } = message.params || {}
  return finalAnswer(threadId, turnId, item)
}

export function codexFinalFromAppServerMessage(message) {
  if (message?.method !== 'turn/completed') return null
  const { threadId, turn } = message.params || {}
  if (!validIdentity(threadId) || !validIdentity(turn?.id) || turn.status !== 'completed' || !Array.isArray(turn.items)) return null
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const final = finalAnswer(threadId, turn.id, turn.items[index])
    if (final) return final
  }
  return null
}

export function claimCodexCommentary(session, itemId, limit = CODEX_COMMENTARY_HISTORY_LIMIT) {
  if (!session || typeof session !== 'object' || !validIdentity(itemId)) return false
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || 1))
  const history = Array.isArray(session?.codexCommentaryItems)
    ? session.codexCommentaryItems.filter(validIdentity)
    : []
  if (history.includes(itemId)) {
    session.codexCommentaryItems = history.slice(-boundedLimit)
    return false
  }
  history.push(itemId)
  session.codexCommentaryItems = history.slice(-boundedLimit)
  return true
}

export function releaseCodexCommentary(session, itemId) {
  if (!Array.isArray(session?.codexCommentaryItems)) return
  session.codexCommentaryItems = session.codexCommentaryItems.filter(id => id !== itemId)
  if (!session.codexCommentaryItems.length) delete session.codexCommentaryItems
}

export function claimCodexFinal(session, turnId, limit = CODEX_FINAL_HISTORY_LIMIT) {
  if (!session || typeof session !== 'object' || !validIdentity(turnId)) return false
  const boundedLimit = Math.max(1, Math.floor(Number(limit) || 1))
  const history = Array.isArray(session.codexFinalTurns)
    ? session.codexFinalTurns.filter(validIdentity)
    : []
  if (validIdentity(session.lastMirroredTurn) && !history.includes(session.lastMirroredTurn)) {
    history.push(session.lastMirroredTurn)
  }
  if (session.lastMirroredTurn === turnId || history.includes(turnId)) {
    if (history.length) session.codexFinalTurns = history.slice(-boundedLimit)
    return false
  }
  history.push(turnId)
  session.codexFinalTurns = history.slice(-boundedLimit)
  session.lastMirroredTurn = turnId
  return true
}

export function releaseCodexFinal(session, turnId) {
  if (!session || !validIdentity(turnId)) return
  const history = Array.isArray(session.codexFinalTurns)
    ? session.codexFinalTurns.filter(id => validIdentity(id) && id !== turnId)
    : []
  if (history.length) session.codexFinalTurns = history
  else delete session.codexFinalTurns
  if (session.lastMirroredTurn === turnId) {
    if (history.length) session.lastMirroredTurn = history.at(-1)
    else delete session.lastMirroredTurn
  }
}

export function codexFinalLifecycleFingerprint(session, { observedAt = null } = {}) {
  return {
    taskId: session?.teamActiveTaskId || null,
    inputAt: session?.teamInputReservation?.acceptedAt || null,
    teamTurnAt: session?.teamTurn?.startedAt || null,
    turnStartedAt: session?.codexTurnStartedAt || null,
    observedAt: Number.isSafeInteger(observedAt) && observedAt > 0 ? observedAt : null,
  }
}

export function codexFinalLifecycleStillCurrent(session, expected, { beforeStop = false } = {}) {
  if (!session || !expected) return false
  const lifecycleMatches = (session.teamActiveTaskId || null) === expected.taskId &&
    (session.teamInputReservation?.acceptedAt || null) === expected.inputAt &&
    (session.teamTurn?.startedAt || null) === expected.teamTurnAt
  if (!lifecycleMatches) return false
  if (!beforeStop) return !session.codexTurnStartedAt
  const trackedStart = session.codexTurnStartedAt || null
  if (trackedStart !== expected.turnStartedAt) return false
  return !(expected.observedAt && trackedStart && trackedStart > expected.observedAt)
}

export function codexCommentaryDisposition({
  session,
  commentary,
  pid,
  tmux,
  tmuxClaimValid,
  activeSessionId,
  privateTurn = false,
  targetClaim = false,
} = {}) {
  if (privateTurn || targetClaim || session?.lastMirroredTurn === commentary?.turnId ||
      (Array.isArray(session?.codexFinalTurns) && session.codexFinalTurns.includes(commentary?.turnId))) return 'ignore'
  if (!session) return 'not_ready'
  if (session.provider !== 'codex' || Number(session.pid) !== Number(pid) ||
      !tmux || session.tmux !== tmux || !tmuxClaimValid) return 'forbidden'
  if (!session.channel || activeSessionId !== session.id) return 'not_ready'
  return 'accept'
}

export function codexFinalDisposition({
  session,
  final,
  pid,
  tmux,
  tmuxClaimValid,
  activeSessionId,
  privateTurn = false,
  targetClaim = false,
} = {}) {
  if (!session) return 'not_ready'
  if (session.id !== final?.threadId || session.provider !== 'codex' || Number(session.pid) !== Number(pid) ||
      !tmux || session.tmux !== tmux || !tmuxClaimValid) return 'forbidden'
  if (privateTurn || targetClaim) return 'private'
  if (session.lastMirroredTurn === final?.turnId ||
      (Array.isArray(session.codexFinalTurns) && session.codexFinalTurns.includes(final?.turnId))) return 'ignore'
  if (!session.channel || activeSessionId !== session.id) return 'not_ready'
  return 'accept'
}
