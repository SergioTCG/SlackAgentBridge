import crypto from 'node:crypto'
import path from 'node:path'
import { channelNodeId, nodeIdForSession, LOCAL_NODE_ID } from './nodes.mjs'
import { teamReplyDeliverySettled } from './team-delivery-state.mjs'

const fail = code => { throw new Error(code) }
const digest = task => crypto.createHash('sha256').update(JSON.stringify(task)).digest('hex')

// This is a maintenance checkpoint, never a completion declaration. The entire
// task journal must remain unchanged across the native account restart.
export function captureTaskMaintenance(state, session, taskId) {
  const task = state.teamTasks?.[taskId], team = state.teams?.[task?.teamId]
  if (!session || (session.provider || 'claude') !== 'claude' || !taskId || session.teamActiveTaskId !== taskId ||
      state.sessions?.[session.id] !== session || state.channels?.[session.channel] !== session.id ||
      channelNodeId(state, session.channel) !== LOCAL_NODE_ID || nodeIdForSession(session) !== LOCAL_NODE_ID ||
      !team || team.closedAt || team.members?.[session.channel]?.role !== 'worker' ||
      task.sourceChannel !== team.coordinatorChannel || task.targetNodeId && task.targetNodeId !== LOCAL_NODE_ID ||
      task.targetSessionId !== session.id || task.targetChannel !== session.channel || task.targetProvider !== 'claude' ||
      task.status !== 'awaiting_release' || task.completionPolicy !== 'coordinator-release' || session.teamInputReservation ||
      !Number.isSafeInteger(task.workGeneration) || task.workGeneration < 1 || task.workGeneration !== task.providerWorkGeneration ||
      !task.reports?.some(report => report.workGeneration === task.workGeneration && report.deliveryStatus === 'delivered') ||
      task.reports.some(report => report.deliveryStatus !== 'delivered') ||
      task.replies?.some(reply => !teamReplyDeliverySettled(reply)) ||
      task.messages?.some(message => message.deliveryStatus !== 'delivered' || message.providerDeliveryStatus !== 'delivered')) {
    fail('account_task_maintenance_blocked')
  }
  return { taskId, sessionId: session.id, channelId: session.channel, teamId: task.teamId, digest: digest(task) }
}

// A usage limit ends the very turn a held task is waiting on, so this checkpoint
// also admits a standing task and a running delegated task. It is still never a
// lifecycle change: the whole journal must stay unchanged across the restart.
// Coordinator messages that have not reached the provider stay queued for after
// it; anything already being delivered, reported or replied blocks this attempt.
export function captureUsageLimitTaskMaintenance(state, session) {
  const activeId = session?.teamActiveTaskId || null, standingId = session?.teamStandingTaskId || null
  const taskId = activeId || standingId, task = state.teamTasks?.[taskId], team = state.teams?.[task?.teamId]
  const standing = !activeId && task?.reservation === 'standing'
  if (!session || (session.provider || 'claude') !== 'claude' || !taskId || (activeId && standingId) ||
      state.sessions?.[session.id] !== session || state.channels?.[session.channel] !== session.id ||
      channelNodeId(state, session.channel) !== LOCAL_NODE_ID || nodeIdForSession(session) !== LOCAL_NODE_ID ||
      !team || team.closedAt || team.members?.[session.channel]?.role !== 'worker' ||
      task.sourceChannel !== team.coordinatorChannel || task.targetNodeId && task.targetNodeId !== LOCAL_NODE_ID ||
      task.targetSessionId !== session.id || task.targetChannel !== session.channel || task.targetProvider !== 'claude' ||
      (activeId ? task.reservation === 'standing' || !['running', 'awaiting_release'].includes(task.status) : !standing || task.status !== 'running') ||
      task.completionPolicy !== 'coordinator-release' || session.teamProviderTurnPending || session.teamProviderTurnDeferredFinal ||
      !Number.isSafeInteger(task.workGeneration) || !Number.isSafeInteger(task.providerWorkGeneration) ||
      task.providerWorkGeneration < 1 || task.providerWorkGeneration > task.workGeneration ||
      task.reports?.some(report => report.deliveryStatus !== 'delivered') ||
      task.replies?.some(reply => !teamReplyDeliverySettled(reply)) ||
      task.messages?.some(message => message.deliveryStatus !== 'delivered' &&
        (message.deliveryStatus !== 'pending' || message.providerDeliveryStatus))) {
    fail('account_task_maintenance_blocked')
  }
  return { kind: 'usage-limit', taskId, sessionId: session.id, channelId: session.channel, teamId: task.teamId, digest: digest(task) }
}

export function assertTaskMaintenance(state, session, snapshot) {
  const current = snapshot?.kind === 'usage-limit'
    ? captureUsageLimitTaskMaintenance(state, session)
    : captureTaskMaintenance(state, session, snapshot?.taskId)
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) fail('account_task_maintenance_changed')
}

export function taskMaintenancePending(state, task) {
  const journal = state.accountPools?.switches?.[task?.targetChannel]
  return Boolean(journal?.taskMaintenance && ['prepared', 'restarting', 'interrupted'].includes(journal.phase) &&
    journal.taskMaintenance.taskId === task.id && journal.taskMaintenance.sessionId === task.targetSessionId)
}

export function taskMaintenanceClaimAllowed(state, { sessionId, tmux, provider }) {
  if (!tmux) return true
  const reserved = Object.values(state.sessions || {}).find(session => session.tmux === tmux &&
    [session.teamActiveTaskId, session.teamStandingTaskId].some(id => id && taskMaintenancePending(state, state.teamTasks?.[id])))
  return !reserved || reserved.id === sessionId && (reserved.provider || 'claude') === provider
}

// The whole tmux pane is terminated on restart, not only Claude. Admit only
// its proven ancestor chain and SAB's exact channel server. Unknown processes,
// user tools, nested agents and extra windows/panes fail closed; no argv is logged.
export async function proveIdleTaskProcessTree(session, { execFile, bridge }) {
  const tmux = process.env.CCS_TMUX_BIN || 'tmux'
  const panes = (await execFile(tmux, ['list-panes', '-s', '-t', session.tmux, '-F', '#{pane_id}'], { timeout: 5000 })).stdout.trim().split('\n')
  if (panes.length !== 1 || !panes[0]) fail('account_background_panes')
  const panePid = Number((await execFile(tmux, ['display-message', '-pt', session.tmux, '#{pane_pid}'], { timeout: 5000 })).stdout.trim())
  const output = (await execFile('ps', ['-axo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 2 << 20 })).stdout
  const rows = output.split('\n').filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) fail('account_background_process_unproven')
    return { pid: Number(match[1]), ppid: Number(match[2]) }
  })
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const ancestors = new Set()
  let pid = session.pid
  for (let hop = 0; hop < 32 && pid > 1; hop++) {
    if (ancestors.has(pid)) fail('account_background_process_unproven')
    ancestors.add(pid)
    if (pid === panePid) break
    pid = byPid.get(pid)?.ppid
  }
  if (!ancestors.has(panePid)) fail('account_background_process_unproven')
  const descendants = new Set([panePid])
  for (let hop = 0; hop < 32; hop++) {
    const next = rows.filter(row => descendants.has(row.ppid) && !descendants.has(row.pid))
    if (!next.length) break
    for (const row of next) descendants.add(row.pid)
    if (descendants.size > 64 || hop === 31) fail('account_background_process_unproven')
  }
  const server = path.join(bridge, 'channel/server.mjs')
  for (const child of descendants) {
    if (ancestors.has(child)) continue
    const command = (await execFile('ps', ['-o', 'command=', '-p', String(child)], { timeout: 5000, maxBuffer: 65536 })).stdout.trim().split(/\s+/)
    if (byPid.get(child)?.ppid !== session.pid || command.length !== 2 ||
        !['node', 'bun'].includes(path.basename(command[0])) || command[1] !== server) fail('account_background_jobs')
  }
  return [...descendants].sort((a, b) => a - b).join(':')
}
