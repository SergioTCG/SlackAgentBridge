import { providerOf } from './providers.mjs'
import { LOCAL_NODE_ID, nodeIdForSession } from './nodes.mjs'

// Process ancestry and the tmux descendant check are resolved by the caller;
// this final pure gate keeps every durable identity in the authority triangle
// exact and makes stale-leg/forgery behavior regression-testable.
export function validTeamCallerBinding(state, session, {
  pid,
  tmux,
  provider,
  live,
  tmuxClaimed,
  localNodeId = LOCAL_NODE_ID,
} = {}) {
  if (!session || !session.channel || !pid || session.pid !== pid) return false
  if (state?.channels?.[session.channel] !== session.id) return false
  if (session.tmux !== tmux || providerOf(session) !== provider) return false
  try {
    if (nodeIdForSession(session) !== localNodeId) return false
  } catch { return false }
  return Boolean(live && tmuxClaimed)
}
