import path from 'node:path'
import { providerOf } from './providers.mjs'
import { createExecutionNodeRouter, createLocalExecutionNode } from './execution-nodes.mjs'
import { nodeIdForSession } from './nodes.mjs'

export function activeTerminalSessions(state, { pidAlive }) {
  const sessions = []
  const seen = new Set()
  for (const [channel, sessionId] of Object.entries(state.channels || {})) {
    const session = state.sessions?.[sessionId]
    if (!session || seen.has(session.id) || session.channel !== channel) continue
    if (!session.tmux || !(session.pid && pidAlive(session.pid))) continue
    seen.add(session.id)
    sessions.push(session)
  }
  return sessions.sort((a, b) => String(a.cwd || '').localeCompare(String(b.cwd || '')) || a.id.localeCompare(b.id))
}

export function resolveTerminalSession(sessions, selector) {
  const value = String(selector || '')
  if (!value || value === 'here') return { error: 'a session selector is required outside a bridged terminal' }
  const exact = sessions.filter(session => session.id === value || session.tmux === value || session.cwd === value)
  if (exact.length === 1) return { session: exact[0] }
  const prefix = sessions.filter(session => session.id.startsWith(value))
  if (prefix.length === 1) return { session: prefix[0] }
  if (exact.length > 1 || prefix.length > 1) return { error: `session selector is ambiguous: ${value}` }
  return { error: `no active session matches: ${value}` }
}

export async function terminalRows(sessions, { tmuxClientPids, executionNodes }) {
  return Promise.all(sessions.map(async session => ({
    session: session.id.slice(0, 8),
    sessionId: session.id,
    tmux: session.tmux,
    provider: providerOf(session),
    cwd: session.cwd,
    name: path.basename(session.cwd || ''),
    channel: session.channel,
    nodeId: nodeIdForSession(session),
    attached: (await (executionNodes
      ? executionNodes.terminalClientPids(session)
      : tmuxClientPids(session.tmux))).length > 0,
  })))
}

export function createTerminalControl({
  state, executionNodes, pidAlive, tmuxAlive, tmuxClientPids, openTmuxTerminal, closeTmuxTerminal,
}) {
  const nodes = executionNodes || createExecutionNodeRouter({ nodes: [createLocalExecutionNode({
    spawnSession: async () => { throw new Error('terminal control cannot spawn sessions') },
    pidAlive, tmuxAlive, tmuxClientPids, openTmuxTerminal, closeTmuxTerminal,
  })] })
  const locks = new Map()
  async function sessions() {
    const candidates = activeTerminalSessions(state, { pidAlive: executionNodes ? () => true : pidAlive })
    const alive = await Promise.all(candidates.map(session => nodes.sessionAlive(session).catch(() => false)))
    return candidates.filter((_, index) => alive[index])
  }

  async function locked(tmux, operation) {
    const prior = locks.get(tmux) || Promise.resolve()
    const current = prior.catch(() => {}).then(operation)
    locks.set(tmux, current)
    try { return await current } finally { if (locks.get(tmux) === current) locks.delete(tmux) }
  }

  async function one(session, action) {
    return locked(session.tmux, async () => {
      if (!(await nodes.sessionAlive(session))) {
        throw new Error(`session ${session.id.slice(0, 8)} is no longer active`)
      }
      return action === 'open' ? nodes.openTerminal(session) : nodes.closeTerminal(session)
    })
  }

  async function list() {
    return terminalRows(await sessions(), { executionNodes: nodes })
  }

  async function act(action, { selector = '', all = false, channel = null } = {}) {
    if (action !== 'open' && action !== 'close') throw new Error('unknown terminal action')
    const active = await sessions()
    let targets
    if (all) targets = active
    else if (channel) {
      const sessionId = state.channels?.[channel]
      const session = active.find(candidate => candidate.id === sessionId && candidate.channel === channel)
      if (!session) throw new Error('this channel has no active session')
      targets = [session]
    } else {
      const resolved = resolveTerminalSession(active, selector)
      if (!resolved.session) throw new Error(resolved.error)
      targets = [resolved.session]
    }

    const results = []
    for (const session of targets) {
      try { results.push({ session, result: await one(session, action) }) }
      catch (error) { results.push({ session, error: String(error?.message || error) }) }
    }
    const failures = results.filter(item => item.error)
    const changed = results.filter(item => item.result?.action === (action === 'open' ? 'opened' : 'closed')).length
    const focused = results.filter(item => item.result?.action === 'focused').length
    const unchanged = results.length - changed - focused - failures.length
    const summary = action === 'open'
      ? `Opened ${changed}, focused ${focused}, already open ${unchanged}`
      : `Closed ${changed}, already closed ${unchanged}`
    return {
      action, total: results.length, changed, focused, unchanged,
      failures: failures.map(item => ({ session: item.session.id.slice(0, 8), error: item.error })),
      message: `${summary}${failures.length ? `; ${failures.length} failed` : ''}.`,
    }
  }

  return { list, act }
}
