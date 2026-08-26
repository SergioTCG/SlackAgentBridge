export const CODEX_COMMENTARY_HISTORY_LIMIT = 128
export const CODEX_COMMENTARY_MAX_CHARS = 6000

const validIdentity = value => typeof value === 'string' &&
  value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)

// App Server carries command output, diffs, plans, reasoning, and assistant
// messages over the same connection. Select only completed, explicitly
// user-facing commentary; final_answer remains owned by Codex's Stop hook.
export function commentaryFromAppServerMessage(message) {
  if (message?.method !== 'item/completed') return null
  const { threadId, turnId, item } = message.params || {}
  if (!validIdentity(threadId) || !validIdentity(turnId) || !validIdentity(item?.id)) return null
  if (item.type !== 'agentMessage' || item.phase !== 'commentary' || typeof item.text !== 'string') return null
  const text = item.text.trim()
  if (!text) return null
  let bounded = text
  if (bounded.length > CODEX_COMMENTARY_MAX_CHARS) {
    bounded = bounded.slice(0, CODEX_COMMENTARY_MAX_CHARS - 1)
    if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1)
    bounded = `${bounded.trimEnd()}…`
  }
  return {
    threadId,
    turnId,
    itemId: item.id,
    text: bounded,
  }
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
  if (privateTurn || targetClaim || session?.lastMirroredTurn === commentary?.turnId) return 'ignore'
  if (!session) return 'not_ready'
  if (session.provider !== 'codex' || Number(session.pid) !== Number(pid) ||
      !tmux || session.tmux !== tmux || !tmuxClaimValid) return 'forbidden'
  if (!session.channel || activeSessionId !== session.id) return 'not_ready'
  return 'accept'
}
