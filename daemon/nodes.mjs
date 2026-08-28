// Execution-node identity is separate from a mutable machine display name.
// `local` is the implicit compatibility route for every pre-multi-node record.
export const LOCAL_NODE_ID = 'local'
const NODE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function validateNodeId(value) {
  const nodeId = String(value || '')
  if (!NODE_ID_RE.test(nodeId)) throw new Error(`invalid execution node ID: ${nodeId || '(empty)'}`)
  return nodeId
}

export function nodeIdForSession(session) {
  if (!session || typeof session !== 'object') throw new Error('a session is required to resolve its execution node')
  if (session.nodeId == null || session.nodeId === '') return LOCAL_NODE_ID
  return validateNodeId(session.nodeId)
}

// Resolve only an exact authoritative channel/session/node triangle. Legacy
// channels have no explicit node route and inherit the session's implicit local
// route. Once a remote route exists, disagreement fails closed.
export function channelNodeId(state, channel) {
  const sessionId = state?.channels?.[channel]
  const session = sessionId ? state?.sessions?.[sessionId] : null
  if (!session || session.channel !== channel) return null
  let sessionNode
  try { sessionNode = nodeIdForSession(session) } catch { return null }
  const explicit = state?.channelNodes?.[channel]
  if (explicit == null || explicit === '') return sessionNode === LOCAL_NODE_ID ? LOCAL_NODE_ID : null
  try { return validateNodeId(explicit) === sessionNode ? sessionNode : null } catch { return null }
}

// Remote routes are explicit on both sides of the binding. Rebinding to the
// compatibility-local node removes metadata instead of bulk-migrating old state.
export function bindSessionNode(state, session, requestedNodeId) {
  if (!state || typeof state !== 'object' || !session || typeof session !== 'object') {
    throw new Error('state and session are required to bind an execution node')
  }
  const nodeId = validateNodeId(requestedNodeId)
  if (nodeId === LOCAL_NODE_ID) delete session.nodeId
  else session.nodeId = nodeId

  if (session.channel) {
    if (nodeId === LOCAL_NODE_ID) {
      if (state.channelNodes) {
        delete state.channelNodes[session.channel]
        if (!Object.keys(state.channelNodes).length) delete state.channelNodes
      }
    } else {
      if (!state.channelNodes) state.channelNodes = {}
      state.channelNodes[session.channel] = nodeId
    }
  }
  return nodeId
}

export function localSessionByChannel(state, channel) {
  if (channelNodeId(state, channel) !== LOCAL_NODE_ID) return null
  return state?.sessions?.[state?.channels?.[channel]] || null
}

export function localSessionByPid(state, pid) {
  for (const session of Object.values(state?.sessions || {})) {
    if (session.pid !== pid) continue
    try { if (nodeIdForSession(session) === LOCAL_NODE_ID) return session } catch {}
  }
  return null
}
