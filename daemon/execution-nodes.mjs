import { LOCAL_NODE_ID, nodeIdForSession, validateNodeId } from './nodes.mjs'

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`execution node requires ${name}`)
  return value
}

function requireTmux(session) {
  if (!session?.tmux) throw new Error('session has no tmux identity')
  return session.tmux
}

// The first adapter deliberately wraps the existing in-process implementation.
// Remote nodes will implement this same capability surface over the authenticated
// node protocol; coordinator code must not reach around it for routed operations.
export function createLocalExecutionNode({
  id = LOCAL_NODE_ID,
  name = 'This Mac',
  spawnSession,
  pidAlive,
  tmuxAlive,
  tmuxClientPids,
  openTmuxTerminal,
  closeTmuxTerminal,
}) {
  const nodeId = validateNodeId(id)
  const spawn = requireFunction(spawnSession, 'spawnSession')
  const processIsAlive = requireFunction(pidAlive, 'pidAlive')
  const tmuxIsAlive = requireFunction(tmuxAlive, 'tmuxAlive')
  const clients = requireFunction(tmuxClientPids, 'tmuxClientPids')
  const open = requireFunction(openTmuxTerminal, 'openTmuxTerminal')
  const close = requireFunction(closeTmuxTerminal, 'closeTmuxTerminal')

  function assertSession(session) {
    const actual = nodeIdForSession(session)
    if (actual !== nodeId) throw new Error(`session is bound to execution node ${actual}, not ${nodeId}`)
  }

  return Object.freeze({
    id: nodeId,
    name: String(name || nodeId).slice(0, 80),
    mode: 'local',
    connected: () => true,
    spawn,
    tmuxAlive: tmuxIsAlive,
    async sessionAlive(session) {
      assertSession(session)
      return Boolean(session.pid && processIsAlive(session.pid) && session.tmux && await tmuxIsAlive(session.tmux))
    },
    async terminalClientPids(session) {
      assertSession(session)
      return clients(requireTmux(session))
    },
    async openTerminal(session) {
      assertSession(session)
      return open(requireTmux(session))
    },
    async closeTerminal(session) {
      assertSession(session)
      return close(requireTmux(session))
    },
  })
}

export function createExecutionNodeRouter({ nodes = [] } = {}) {
  const byId = new Map()
  for (const node of nodes) {
    const id = validateNodeId(node?.id)
    if (byId.has(id)) throw new Error(`duplicate execution node: ${id}`)
    byId.set(id, node)
  }

  function requireNode(requestedNodeId) {
    const nodeId = validateNodeId(requestedNodeId)
    const node = byId.get(nodeId)
    if (!node || node.connected?.() === false) throw new Error(`execution node ${nodeId} is not registered or is offline`)
    return node
  }

  function forSession(session) {
    return requireNode(nodeIdForSession(session))
  }

  return Object.freeze({
    list: () => [...byId.values()].map(node => ({
      id: node.id, name: node.name, mode: node.mode, connected: node.connected?.() !== false,
    })),
    spawn: async (nodeId, options) => requireNode(nodeId).spawn(options),
    tmuxAlive: async (nodeId, tmux) => requireNode(nodeId).tmuxAlive(tmux),
    sessionAlive: async session => forSession(session).sessionAlive(session),
    terminalClientPids: async session => forSession(session).terminalClientPids(session),
    openTerminal: async session => forSession(session).openTerminal(session),
    closeTerminal: async session => forSession(session).closeTerminal(session),
  })
}
