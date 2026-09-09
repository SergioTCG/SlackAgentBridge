import crypto from 'node:crypto'

// Keep a full delegated text envelope below Slack's single-message limit so
// both linked channels retain a visible audit copy without hidden history reads.
export const TEAM_MESSAGE_MAX_BYTES = 24 * 1024
export const TEAM_MAX_MEMBERS = 20
export const TEAM_MAX_TASKS = 500
export const TEAM_MAX_REPLIES = 32
export const TEAM_MAX_REPORTS = 32
export const TEAM_MAX_ACTIVE_TASKS = 64
export const TEAM_MAX_QUEUED_PER_WORKER = 8
export const TEAM_MAX_PENDING_GATES = 16
export const TEAM_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TEAM_TURN_TTL_MS = 12 * 60 * 60 * 1000

const TEAM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const TEAM_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TASK_GATE_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/
const TASK_STATES = new Set(['queued', 'dispatching', 'running', 'awaiting_release', 'completed', 'completed_with_warning', 'failed', 'cancelled'])
const ACTIVE_TASK_STATES = new Set(['queued', 'dispatching', 'running', 'awaiting_release'])
const WORKER_BOUND_TASK_STATES = new Set(['dispatching', 'running', 'awaiting_release'])
const TERMINAL_TASK_STATES = new Set(['completed', 'completed_with_warning', 'failed', 'cancelled'])
const TASK_CONTROL_MAX = 32
const DEFAULT_COMPLETION_POLICY = 'coordinator-release'
export const LEGACY_COMPLETION_POLICY = 'provider-final'

export class TeamError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'TeamError'
    this.code = code
    this.status = status
  }
}

const nowIso = now => new Date(now).toISOString()
const randomId = prefix => `${prefix}_${crypto.randomBytes(12).toString('base64url')}`
const textBytes = text => Buffer.byteLength(String(text || ''), 'utf8')
const hash = text => crypto.createHash('sha256').update(String(text || '')).digest('hex')
const bumpTask = (task, now) => {
  task.lifecycleVersion = Math.max(1, Number(task.lifecycleVersion) || 1) + 1
  task.updatedAt = nowIso(now)
  return task
}

function transitionTask(task, status, reason, { now = Date.now(), requestId = null } = {}) {
  const from = String(task.status || '') || null
  task.status = status
  task.lastTransition = {
    from,
    to: status,
    reason: String(reason || 'unspecified').slice(0, 200),
    at: nowIso(now),
    ...(requestId ? { requestId: String(requestId) } : {}),
  }
  return bumpTask(task, now)
}

export const isActiveTeamTask = task => ACTIVE_TASK_STATES.has(task?.status)
export const isWorkerBoundTeamTask = task => WORKER_BOUND_TASK_STATES.has(task?.status)
export const isTerminalTeamTask = task => TERMINAL_TASK_STATES.has(task?.status)

// Tasks created before two-phase completion intentionally keep their original
// provider-final behavior. New tasks opt in explicitly; no bulk state migration
// may reinterpret an already-running worker turn during an upgrade.
export function teamTaskCompletionPolicy(task) {
  return task?.completionPolicy === DEFAULT_COMPLETION_POLICY
    ? DEFAULT_COMPLETION_POLICY
    : LEGACY_COMPLETION_POLICY
}

export function teamTaskWorkGeneration(task) {
  return Math.max(1, Number(task?.workGeneration) || 1)
}

export function teamTaskProviderWorkGeneration(task) {
  return Math.max(1, Number(task?.providerWorkGeneration) || 1)
}

function unresolvedCoordinatorMessages(task) {
  return (task?.messages || []).filter(message =>
    message.deliveryStatus !== 'delivered' || message.providerDeliveryStatus !== 'delivered')
}

export function teamTaskReleaseReady(task) {
  if (task?.status !== 'awaiting_release' || !task.completionRequest || task.pendingGates?.length) return false
  const requiredGeneration = teamTaskWorkGeneration(task)
  if (teamTaskProviderWorkGeneration(task) !== requiredGeneration ||
      Number(task.completionRequest.workGeneration) !== requiredGeneration ||
      unresolvedCoordinatorMessages(task).length) return false
  return (task.reports || []).some(report => Number(report.workGeneration) === requiredGeneration)
}

function normalizePendingGates(value) {
  if (!Array.isArray(value)) throw new TeamError('invalid_pending_gates', 'Pending gates must be an array.')
  const gates = [...new Set(value.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))]
  if (gates.length > TEAM_MAX_PENDING_GATES || gates.some(gate => !TASK_GATE_RE.test(gate))) {
    throw new TeamError('invalid_pending_gates',
      `Pending gates must contain at most ${TEAM_MAX_PENDING_GATES} bounded lowercase names.`)
  }
  return gates
}

function invalidateCompletionRequest(task, {
  reason,
  requestId = null,
  now = Date.now(),
} = {}) {
  if (!task.completionRequest) return false
  task.completionRequestHistory ||= []
  task.completionRequestHistory.push({
    ...task.completionRequest,
    invalidatedAt: nowIso(now),
    invalidatedReason: String(reason || 'task_changed').slice(0, 200),
    ...(requestId ? { invalidatedByRequestId: String(requestId) } : {}),
  })
  task.completionRequest = null
  return true
}

function normalizeSlug(value, kind, pattern) {
  const slug = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (!pattern.test(slug)) throw new TeamError(`invalid_${kind}`, `${kind} must use lowercase letters, numbers, dashes, or underscores.`)
  return slug
}

export const normalizeTeamName = value => normalizeSlug(value, 'team_name', TEAM_NAME_RE)
export const normalizeTeamAlias = value => normalizeSlug(value, 'team_alias', TEAM_ALIAS_RE)

function stores(state, { create = false } = {}) {
  if (!state || typeof state !== 'object') throw new TeamError('invalid_state', 'Team state is unavailable.', 500)
  if (create) {
    state.teams ||= {}
    state.teamTasks ||= {}
  }
  return { teams: state.teams || {}, tasks: state.teamTasks || {} }
}

export function activeTeams(state) {
  return Object.values(stores(state).teams).filter(team => team && !team.closedAt)
}

export function teamById(state, teamId, { active = true } = {}) {
  const team = stores(state).teams[String(teamId || '')]
  if (!team || (active && team.closedAt)) throw new TeamError('team_not_found', 'No active session team matches that identifier.', 404)
  return team
}

export function activeTeamForChannel(state, channel) {
  const matches = activeTeams(state).filter(team => team.members?.[channel])
  if (matches.length > 1) throw new TeamError('ambiguous_team', 'This channel belongs to more than one active team.', 409)
  return matches[0] || null
}

export function createTeam(state, {
  name,
  coordinatorChannel,
  createdBy,
  id = randomId('team'),
  now = Date.now(),
} = {}) {
  const teamName = normalizeTeamName(name)
  const channel = String(coordinatorChannel || '')
  if (!channel || !createdBy) throw new TeamError('invalid_team', 'A coordinator channel and owner are required.')
  const { teams } = stores(state, { create: true })
  if (Object.values(teams).some(team => !team.closedAt && team.name === teamName)) {
    throw new TeamError('team_name_in_use', `An active team named ${teamName} already exists.`, 409)
  }
  if (activeTeamForChannel(state, channel)) {
    throw new TeamError('channel_already_teamed', 'This channel already belongs to an active session team.', 409)
  }
  const team = {
    id: String(id),
    name: teamName,
    createdBy: String(createdBy),
    coordinatorChannel: channel,
    version: 1,
    dispatchMode: 'active',
    members: {
      [channel]: { role: 'coordinator', alias: 'coordinator', files: false, joinedAt: nowIso(now) },
    },
    createdAt: nowIso(now),
    closedAt: null,
  }
  teams[team.id] = team
  return team
}

export function teamDispatchMode(team) {
  return team?.dispatchMode === 'draining' ? 'draining' : 'active'
}

export function setTeamDispatchMode(team, mode, { now = Date.now() } = {}) {
  const next = String(mode || '').trim().toLowerCase()
  if (!['active', 'draining'].includes(next)) {
    throw new TeamError('invalid_dispatch_mode', 'Team dispatch mode must be active or draining.')
  }
  if (teamDispatchMode(team) !== next || !Object.hasOwn(team || {}, 'dispatchMode')) {
    team.dispatchMode = next
    team.dispatchModeChangedAt = nowIso(now)
    team.version = Math.max(1, Number(team.version) || 1) + 1
  }
  return { mode: next, changedAt: team.dispatchModeChangedAt || null }
}

export function addTeamWorker(state, teamId, {
  channel,
  alias,
  files = false,
  now = Date.now(),
} = {}) {
  const team = teamById(state, teamId)
  const target = String(channel || '')
  const normalizedAlias = normalizeTeamAlias(alias)
  if (!target || target === team.coordinatorChannel) throw new TeamError('invalid_worker', 'Choose another SAB session channel.')
  if (activeTeamForChannel(state, target)) throw new TeamError('channel_already_teamed', 'That channel already belongs to an active session team.', 409)
  if (Object.keys(team.members).length >= TEAM_MAX_MEMBERS) throw new TeamError('team_full', `A team may contain at most ${TEAM_MAX_MEMBERS} channels.`, 409)
  if (Object.values(team.members).some(member => member.alias === normalizedAlias)) {
    throw new TeamError('alias_in_use', `The alias ${normalizedAlias} is already used in this team.`, 409)
  }
  team.members[target] = { role: 'worker', alias: normalizedAlias, files: Boolean(files), joinedAt: nowIso(now) }
  team.version++
  return team.members[target]
}

export function setTeamWorkerFiles(state, teamId, selector, enabled) {
  const { team, channel, member } = resolveTeamPeer(state, teamId, selector)
  if (member.role !== 'worker') throw new TeamError('invalid_worker', 'File relay is configured per worker.')
  member.files = Boolean(enabled)
  team.version++
  return { channel, member }
}

export function resolveTeamPeer(state, teamId, selector) {
  const team = teamById(state, teamId)
  const requested = String(selector || '').trim().toLowerCase()
  const entries = Object.entries(team.members || {}).filter(([, member]) => member.role === 'worker')
  const matches = entries.filter(([channel, member]) => channel.toLowerCase() === requested || member.alias === requested)
  if (matches.length !== 1) throw new TeamError(matches.length ? 'ambiguous_peer' : 'peer_not_found', 'No unique worker matches that destination.', 404)
  return { team, channel: matches[0][0], member: matches[0][1] }
}

export function removeTeamWorker(state, teamId, selector, { now = Date.now() } = {}) {
  const { team, channel, member } = resolveTeamPeer(state, teamId, selector)
  delete team.members[channel]
  team.version++
  const cancelled = cancelTasks(state, task => task.teamId === team.id &&
    ACTIVE_TASK_STATES.has(task.status) && (task.sourceChannel === channel || task.targetChannel === channel),
  'Team membership was removed.', now)
  return { channel, member, cancelled }
}

export function closeTeam(state, teamId, { now = Date.now() } = {}) {
  const team = teamById(state, teamId)
  team.closedAt = nowIso(now)
  team.version++
  const cancelled = cancelTasks(state, task => task.teamId === team.id && ACTIVE_TASK_STATES.has(task.status),
    'The session team was closed.', now)
  return { team, cancelled }
}

function publicMember(member) {
  return { role: member.role, alias: member.alias, files: Boolean(member.files) }
}

export function teamContext(state, channel) {
  const team = activeTeamForChannel(state, channel)
  if (!team) return null
  const member = team.members[channel]
  const peers = Object.entries(team.members)
    .filter(([peerChannel]) => peerChannel !== channel)
    .map(([, peer]) => publicMember(peer))
  return {
    id: team.id,
    name: team.name,
    version: team.version,
    dispatchMode: teamDispatchMode(team),
    role: member.role,
    alias: member.alias,
    files: Boolean(member.files),
    peers,
  }
}

export function coordinatorPromptContext(state, channel) {
  const context = teamContext(state, channel)
  if (!context) return ''
  const workers = context.peers.filter(peer => peer.role === 'worker')
  if (context.role === 'coordinator') {
    const names = workers.map(peer => peer.alias).join(', ') || '(none)'
    return [
      '',
      '[Slack Agent Bridge session team]',
      `Team: ${context.name}`,
      'Role: coordinator',
      `Workers: ${names}`,
      'You may inspect live team state with `sab team context --json`, delegate with `sab team send --to ALIAS --stdin`, and collect bounded results with `sab team wait --task TASK_ID --json` or `sab team inbox --active --limit 20 --page --json`.',
      'A worker provider final is a turn report, not task release. Inspect `pendingGates` and `releaseReady`; use `sab team message --task TASK_ID --stdin` for follow-up and `sab team release --task TASK_ID` only when the worker explicitly declared completion and every gate is clear.',
      'Use `sab team continue --task TASK_ID --stdin` to create an audited linked continuation after an already-terminal task. Use `sab team replace` or `sab team cancel` for queued work, and `sab team mode draining` to finish active work without dispatching more.',
      'Only explicitly linked workers are reachable. Do not reveal or fabricate SAB task identities.',
    ].join('\n')
  }
  return [
    '',
    '[Slack Agent Bridge session team]',
    `Team: ${context.name}`,
    'Role: worker',
    'This ordinary owner turn is not a delegated team task. You may inspect `sab team context --json`, but may reply to a coordinator only while processing an explicit SAB task.',
  ].join('\n')
}

function taskPayloadHash({ text, files = [] }) {
  return hash(JSON.stringify({
    text: String(text || ''),
    files: files.map(file => ({ filename: file.filename, size: file.size, sha256: file.sha256 || null })),
  }))
}

function taskRequestHash({ text, files = [], parentTaskId = null }) {
  const payload = taskPayloadHash({ text, files })
  return parentTaskId ? hash(JSON.stringify({ payload, parentTaskId: String(parentTaskId) })) : payload
}

export function createTeamTask(state, {
  teamId,
  sourceChannel,
  sourceSessionId,
  sourceProvider,
  sourceNodeId = 'local',
  target,
  text,
  files = [],
  parentTaskId = null,
  requestId,
  id = randomId('task'),
  now = Date.now(),
} = {}) {
  const team = teamById(state, teamId)
  if (team.coordinatorChannel !== sourceChannel || team.members?.[sourceChannel]?.role !== 'coordinator') {
    throw new TeamError('dispatch_not_allowed', 'Only this team\'s coordinator may create worker tasks.', 403)
  }
  const { channel: targetChannel, member } = resolveTeamPeer(state, team.id, target)
  const prompt = String(text || '').trim()
  if (!prompt && !files.length) throw new TeamError('empty_task', 'A task needs text or at least one file.')
  if (textBytes(prompt) > TEAM_MESSAGE_MAX_BYTES) throw new TeamError('message_too_large', `Team messages may be at most ${TEAM_MESSAGE_MAX_BYTES} bytes.`, 413)
  if (!Array.isArray(files)) throw new TeamError('invalid_files', 'Task files must be an array.')
  if (files.length && !member.files) throw new TeamError('files_not_allowed', 'File relay is not enabled for that worker.', 403)
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
  const { tasks } = stores(state, { create: true })
  const payloadHash = taskRequestHash({ text: prompt, files, parentTaskId })
  const existing = Object.values(tasks).find(task => task.sourceChannel === sourceChannel && task.requestId === key)
  if (existing) {
    if (existing.teamId !== team.id || existing.targetChannel !== targetChannel || existing.payloadHash !== payloadHash) {
      throw new TeamError('request_conflict', 'That request ID was already used for different team work.', 409)
    }
    return { task: existing, created: false }
  }
  const active = Object.values(tasks).filter(task => task.teamId === team.id && ACTIVE_TASK_STATES.has(task.status))
  if (active.length >= TEAM_MAX_ACTIVE_TASKS) {
    throw new TeamError('team_queue_full', `This team already has ${TEAM_MAX_ACTIVE_TASKS} active tasks.`, 429)
  }
  if (active.filter(task => task.targetChannel === targetChannel).length >= TEAM_MAX_QUEUED_PER_WORKER) {
    throw new TeamError('worker_queue_full', `That worker already has ${TEAM_MAX_QUEUED_PER_WORKER} active tasks.`, 429)
  }
  const pruned = pruneTeamTasks(state, { now, max: TEAM_MAX_TASKS - 1 })
  if (Object.keys(tasks).length >= TEAM_MAX_TASKS) throw new TeamError('task_journal_full', 'The bounded team task journal is full.', 503)
  const task = {
    id: String(id),
    requestId: key,
    teamId: team.id,
    teamVersion: team.version,
    sourceChannel,
    sourceSessionId,
    sourceProvider,
    sourceNodeId,
    targetChannel,
    targetAlias: member.alias,
    ...(parentTaskId ? { parentTaskId: String(parentTaskId) } : {}),
    targetSessionId: null,
    targetProvider: null,
    targetNodeId: null,
    status: 'queued',
    completionPolicy: DEFAULT_COMPLETION_POLICY,
    workGeneration: 1,
    providerWorkGeneration: 1,
    pendingGates: [],
    completionRequest: null,
    lifecycleVersion: 1,
    instructionVersion: 1,
    instruction: prompt,
    text: prompt,
    files: files.map(file => ({
      path: file.path, filename: file.filename, size: file.size, sha256: file.sha256 || null,
    })),
    fileDeliveryStatus: files.length ? 'pending' : 'none',
    fileDeliveryError: null,
    payloadHash,
    replies: [],
    messages: [],
    controlRequests: [],
    result: null,
    error: null,
    completionDeliveryStatus: null,
    completionDeliveryError: null,
    completionSlackTs: null,
    sourceSlackTs: null,
    targetSlackTs: null,
    sourcePayloadSlackTs: null,
    targetPayloadSlackTs: null,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    lastTransition: { from: null, to: 'queued', reason: 'created', at: nowIso(now), requestId: key },
    expiresAt: nowIso(now + TEAM_TASK_TTL_MS),
  }
  tasks[task.id] = task
  return { task, created: true, pruned }
}

export function teamTaskForRequest(state, sourceChannel, requestId) {
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
  return Object.values(stores(state).tasks).find(task => task.sourceChannel === sourceChannel && task.requestId === key) || null
}

export function assertTeamTaskRetry(state, task, { teamId, target, text, files = [], parentTaskId = null } = {}) {
  const { channel } = resolveTeamPeer(state, teamId, target)
  const payloadHash = taskRequestHash({ text: String(text || '').trim(), files, parentTaskId })
  if (task.teamId !== teamId || task.targetChannel !== channel || task.payloadHash !== payloadHash) {
    throw new TeamError('request_conflict', 'That request ID was already used for different team work.', 409)
  }
  return task
}

export function teamTask(state, taskId) {
  const task = stores(state).tasks[String(taskId || '')]
  if (!task) throw new TeamError('task_not_found', 'No team task matches that identifier.', 404)
  if (!TASK_STATES.has(task.status)) throw new TeamError('invalid_task_state', 'The team task has invalid persisted state.', 500)
  return task
}

export function claimTeamTask(state, taskId, {
  targetSessionId,
  targetProvider,
  targetNodeId = 'local',
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.status !== 'queued') throw new TeamError('task_not_queued', 'Only a queued task may be claimed.', 409)
  if (teamDispatchMode(teamById(state, task.teamId)) === 'draining') {
    throw new TeamError('team_draining', 'This team is draining active work and will not dispatch queued tasks.', 409)
  }
  task.targetSessionId = String(targetSessionId || '')
  task.targetProvider = String(targetProvider || '')
  task.targetNodeId = String(targetNodeId || 'local')
  task.dispatchClaimedAt = nowIso(now)
  return transitionTask(task, 'dispatching', 'worker_claimed', { now })
}

export function claimTeamTaskForSession(state, taskId, session, options = {}) {
  if (!session || typeof session !== 'object' || !session.id) {
    throw new TeamError('invalid_worker_session', 'An authoritative worker session is required.', 500)
  }
  if (session.teamActiveTaskId && session.teamActiveTaskId !== taskId) {
    throw new TeamError('worker_busy', 'This worker session is already reserved by another task.', 409)
  }
  const {
    expectedInstructionVersion = null,
    expectedAuditInstructionVersion = null,
    ...claimOptions
  } = options
  const queued = teamTask(state, taskId)
  const instructionVersion = Math.max(1, Number(queued.instructionVersion) || 1)
  const auditInstructionVersion = Math.max(1, Number(queued.payloadAuditInstructionVersion) || 1)
  if (expectedInstructionVersion !== null && instructionVersion !== expectedInstructionVersion) {
    throw new TeamError('task_revision_changed',
      'The queued task instruction changed before its dispatch claim.', 409)
  }
  if (expectedAuditInstructionVersion !== null &&
      (auditInstructionVersion !== expectedAuditInstructionVersion ||
       auditInstructionVersion !== instructionVersion)) {
    throw new TeamError('task_audit_stale',
      'The queued task instruction has not been fully reflected in its Slack audit cards.', 409)
  }
  const task = claimTeamTask(state, taskId, { ...claimOptions, targetSessionId: session.id })
  task.startedAt ||= task.dispatchClaimedAt
  session.teamActiveTaskId = task.id
  session.teamAvailabilityChangedAt = task.dispatchClaimedAt
  session.teamAvailabilityReason = 'claimed_team_task'
  return task
}

export function markTeamTaskRunning(state, taskId, { now = Date.now() } = {}) {
  const task = teamTask(state, taskId)
  if (!['dispatching', 'running'].includes(task.status)) throw new TeamError('task_not_dispatching', 'The task is not being dispatched.', 409)
  task.startedAt ||= nowIso(now)
  task.acceptedAt ||= nowIso(now)
  // Retain the original instruction separately for bounded inbox/audit output.
  // The mutable delivery envelope can still be released after acceptance.
  task.text = ''
  return transitionTask(task, 'running', 'provider_accepted', { now })
}

export function appendTeamTaskReply(state, taskId, {
  fromChannel,
  text,
  files = [],
  pendingGates = null,
  requestId,
  now = Date.now(),
  id = randomId('reply'),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.targetChannel !== fromChannel) throw new TeamError('reply_not_allowed', 'Only the assigned worker may reply to this task.', 403)
  const body = String(text || '').trim()
  if (!body && !files.length) throw new TeamError('empty_reply', 'A reply needs text or at least one file.')
  if (textBytes(body) > TEAM_MESSAGE_MAX_BYTES) throw new TeamError('message_too_large', `Team replies may be at most ${TEAM_MESSAGE_MAX_BYTES} bytes.`, 413)
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
  const normalizedGates = pendingGates === null ? null : normalizePendingGates(pendingGates)
  const payloadHash = normalizedGates === null
    ? taskPayloadHash({ text: body, files })
    : hash(JSON.stringify({
        message: taskPayloadHash({ text: body, files }),
        pendingGates: normalizedGates,
      }))
  const existing = task.replies.find(reply => reply.requestId === key)
  if (existing) {
    if (existing.payloadHash !== payloadHash) throw new TeamError('request_conflict', 'That reply request ID was already used for different content.', 409)
    // A reply accepted from the exact authenticated worker process is stronger
    // delivery proof than a provider lifecycle hook. Older daemons could
    // persist the reply while leaving the task in `dispatching`; heal that
    // state on an idempotent retry as well.
    const accepted = task.status === 'dispatching'
    if (accepted) markTeamTaskRunning(state, task.id, { now })
    return { reply: existing, created: false, accepted }
  }
  if ([task.completionRequest, ...(task.completionRequestHistory || [])]
    .some(item => item?.requestId === key)) {
    throw new TeamError('request_conflict', 'That request ID was already used for a completion declaration.', 409)
  }
  if (!ACTIVE_TASK_STATES.has(task.status)) throw new TeamError('task_not_active', 'That task no longer accepts replies.', 409)
  // Keep one bounded journal slot available for the checkpoint that clears the
  // final declared gate. Otherwise progress chatter could make a two-phase task
  // impossible to complete successfully.
  const reservesGateSlot = teamTaskCompletionPolicy(task) !== LEGACY_COMPLETION_POLICY
  const clearsFinalGate = reservesGateSlot && normalizedGates?.length === 0 && (task.pendingGates || []).length > 0
  const replyLimit = !reservesGateSlot || clearsFinalGate ? TEAM_MAX_REPLIES : TEAM_MAX_REPLIES - 1
  if (task.replies.length >= replyLimit) {
    throw new TeamError('reply_limit', clearsFinalGate
      ? 'This task reached its bounded reply limit.'
      : 'This task reserved its final reply slot for a gate-clearing checkpoint.', 409)
  }
  if (normalizedGates !== null) invalidateCompletionRequest(task, {
    reason: 'worker_checkpoint_changed', requestId: key, now,
  })
  const reply = {
    id: String(id), requestId: key, payloadHash, fromChannel, text: body,
    files: files.map(file => ({
      path: file.path, filename: file.filename, size: file.size, sha256: file.sha256 || null,
    })),
    textSlackTs: null,
    fileDeliveryStatus: files.length ? 'pending' : 'none',
    fileDeliveryError: null,
    ...(normalizedGates === null ? {} : { kind: 'checkpoint', pendingGates: normalizedGates }),
    createdAt: nowIso(now),
  }
  task.replies.push(reply)
  if (normalizedGates !== null) {
    task.pendingGates = normalizedGates
    task.gatesUpdatedAt = nowIso(now)
  }
  const accepted = task.status === 'dispatching'
  if (accepted) markTeamTaskRunning(state, task.id, { now })
  else bumpTask(task, now)
  reply.lifecycleVersion = task.lifecycleVersion
  return { reply, created: true, accepted }
}

export function appendTeamTaskCheckpoint(state, taskId, options = {}) {
  if (!Object.hasOwn(options, 'pendingGates')) {
    throw new TeamError('pending_gates_required', 'A checkpoint must declare its complete pending-gate list.')
  }
  return appendTeamTaskReply(state, taskId, options)
}

export function requestTeamTaskCompletion(state, taskId, {
  targetSessionId,
  fromChannel,
  summary,
  requestId,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.targetChannel !== fromChannel || task.targetSessionId !== targetSessionId) {
    throw new TeamError('completion_not_allowed', 'Only the exact assigned worker session may declare this task ready.', 403)
  }
  const text = String(summary || '').trim()
  if (!text) throw new TeamError('empty_completion', 'Task completion needs a bounded summary.')
  if (textBytes(text) > TEAM_MESSAGE_MAX_BYTES) {
    throw new TeamError('message_too_large', `Team messages may be at most ${TEAM_MESSAGE_MAX_BYTES} bytes.`, 413)
  }
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
  const payloadHash = hash(text)
  const existing = [task.completionRequest, ...(task.completionRequestHistory || [])]
    .find(item => item?.requestId === key)
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      throw new TeamError('completion_already_requested', 'This task already has a different completion declaration.', 409)
    }
    return { task, request: existing, created: false }
  }
  if (!WORKER_BOUND_TASK_STATES.has(task.status)) {
    throw new TeamError('task_not_active', 'Only an assigned active task may be declared ready.', 409)
  }
  if (unresolvedCoordinatorMessages(task).length) {
    throw new TeamError('task_message_in_flight',
      'A coordinator follow-up has not completed exact provider delivery; declare completion only after receiving it.', 409)
  }
  if (task.replies.some(reply => reply.requestId === key)) {
    throw new TeamError('request_conflict', 'That request ID was already used for a task reply.', 409)
  }
  if (task.completionRequest) {
    throw new TeamError('completion_already_requested', 'This task already has a different active completion declaration.', 409)
  }
  const pending = normalizePendingGates(task.pendingGates || [])
  if (pending.length) {
    throw new TeamError('task_gates_pending', `Task completion is blocked by pending gates: ${pending.join(', ')}.`, 409)
  }
  task.completionRequest = {
    requestId: key,
    payloadHash,
    summary: text,
    requestedAt: nowIso(now),
    workGeneration: teamTaskProviderWorkGeneration(task),
  }
  bumpTask(task, now)
  task.completionRequest.lifecycleVersion = task.lifecycleVersion
  return { task, request: task.completionRequest, created: true }
}

function boundedResult(result) {
  const text = String(result || '').trim()
  return textBytes(text) > TEAM_MESSAGE_MAX_BYTES
    ? Buffer.from(text, 'utf8').subarray(0, TEAM_MESSAGE_MAX_BYTES).toString('utf8') +
      '\n\n[Result truncated in the team journal; see the worker Slack channel for the complete response.]'
    : text
}

// A provider turn ending is an observation, not necessarily task completion.
// New tasks retain their worker reservation until the worker has explicitly
// declared readiness and the coordinator releases the task. Legacy records
// intentionally preserve the historical provider-final behavior.
export function reportTeamTaskTurn(state, taskId, {
  targetSessionId,
  result,
  warning = null,
  providerWorkGeneration = null,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (teamTaskCompletionPolicy(task) === LEGACY_COMPLETION_POLICY) {
    if (!['dispatching', 'running'].includes(task.status)) {
      throw new TeamError('task_not_running', 'Only the assigned active task may complete.', 409)
    }
    if (task.targetSessionId !== targetSessionId) {
      throw new TeamError('task_target_changed', 'The task belongs to another native session.', 409)
    }
    const completed = warning
      ? completeTeamTaskWithWarning(state, taskId, { targetSessionId, result, warning, now })
      : String(result || '').trim()
        ? completeTeamTask(state, taskId, { targetSessionId, result, now })
        : failTeamTask(state, taskId, 'The worker turn ended without a stable final response.', { now })
    return { task: completed, report: null, created: true, stale: false }
  }
  if (task.targetSessionId !== targetSessionId) {
    throw new TeamError('task_target_changed', 'The task belongs to another native session.', 409)
  }
  const currentGeneration = teamTaskProviderWorkGeneration(task)
  const observedGeneration = providerWorkGeneration === null
    ? currentGeneration
    : Math.max(1, Number(providerWorkGeneration) || 1)
  if (observedGeneration !== currentGeneration) {
    return { task, report: null, created: false, stale: true }
  }
  // Stop, App Server completion, and the idle fallback can converge on the
  // same native turn. Deduplicate that exact provider-work generation while
  // still allowing a later delivered coordinator follow-up to report anew.
  const existingReport = (task.reports || []).find(report =>
    Number(report.workGeneration || 1) === observedGeneration)
  if (existingReport) return { task, report: existingReport, created: false, stale: false }
  if (!WORKER_BOUND_TASK_STATES.has(task.status)) {
    throw new TeamError('task_not_running', 'Only the assigned active task may report a completed provider turn.', 409)
  }
  task.result = boundedResult(result)
  task.warning = warning ? String(warning).slice(0, 2000) : null
  task.turnCompletedAt = nowIso(now)
  task.reports ||= []
  while (task.reports.length >= TEAM_MAX_REPORTS) {
    const delivered = task.reports.findIndex(item => item.deliveryStatus === 'delivered')
    if (delivered < 0) break
    task.reports.splice(delivered, 1)
  }
  let report
  if (task.reports.length >= TEAM_MAX_REPORTS) {
    // Slack may be unavailable for many turns. Keep bounded state and preserve
    // the newest authoritative report without rejecting provider finalization.
    report = task.reports.at(-1)
    report.result = task.result
    report.warning = task.warning
    report.workGeneration = observedGeneration
    report.deliveryStatus = 'pending'
    report.deliveryError = null
    report.coalescedCount = Number(report.coalescedCount || 1) + 1
    report.createdAt = nowIso(now)
  } else {
    report = {
      id: randomId('report'),
      result: task.result,
      warning: task.warning,
      workGeneration: observedGeneration,
      deliveryStatus: 'pending',
      deliveryError: null,
      slackTs: null,
      createdAt: nowIso(now),
    }
    task.reports.push(report)
  }
  transitionTask(task, 'awaiting_release', warning
    ? 'provider_turn_idle_without_completion_hook'
    : 'provider_turn_completed', { now })
  report.lifecycleVersion = task.lifecycleVersion
  return { task, report, created: true, stale: false }
}

export function releaseTeamTask(state, taskId, {
  sourceChannel,
  requestId,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.sourceChannel !== sourceChannel) {
    throw new TeamError('task_control_not_allowed', 'Only the task coordinator may release this task.', 403)
  }
  const payloadHash = hash('release')
  const control = taskControlRequest(task, requestId, 'release', payloadHash)
  if (task.terminalRequest?.kind === 'release') {
    if (task.terminalRequest.requestId === control.key && task.terminalRequest.payloadHash === payloadHash) {
      return { task, created: false }
    }
    throw new TeamError('task_not_awaiting_release', 'This task was already released.', 409)
  }
  if (control.existing && TERMINAL_TASK_STATES.has(task.status)) return { task, created: false }
  if (task.status !== 'awaiting_release') {
    throw new TeamError('task_not_awaiting_release', 'Only a reported task awaiting coordinator release may complete.', 409)
  }
  if (!task.completionRequest) {
    throw new TeamError('completion_not_declared', 'The worker has not declared this task ready for release.', 409)
  }
  const pending = normalizePendingGates(task.pendingGates || [])
  if (pending.length) {
    throw new TeamError('task_gates_pending', `Task release is blocked by pending gates: ${pending.join(', ')}.`, 409)
  }
  if (unresolvedCoordinatorMessages(task).length) {
    throw new TeamError('task_message_in_flight',
      'A coordinator follow-up has not completed exact provider delivery; this task cannot be released.', 409)
  }
  const requiredGeneration = teamTaskWorkGeneration(task)
  if (teamTaskProviderWorkGeneration(task) !== requiredGeneration ||
      Number(task.completionRequest.workGeneration) !== requiredGeneration ||
      !(task.reports || []).some(report => Number(report.workGeneration) === requiredGeneration)) {
    throw new TeamError('stale_task_report',
      'The completion declaration and provider report do not cover the latest delivered coordinator work.', 409)
  }
  // Release is a terminal safety valve and must remain available even when a
  // long task used its bounded coordinator-message/control journal.
  if (task.controlRequests.length < TASK_CONTROL_MAX) {
    rememberTaskControl(task, control.key, 'release', payloadHash, now)
  }
  task.terminalRequest = {
    requestId: control.key, kind: 'release', payloadHash, createdAt: nowIso(now),
  }
  task.result = task.result || task.completionRequest.summary
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  task.releasedAt = nowIso(now)
  const status = task.warning ? 'completed_with_warning' : 'completed'
  return { task: transitionTask(task, status, 'coordinator_released', { now, requestId: control.key }), created: true }
}

export function completeTeamTask(state, taskId, {
  targetSessionId,
  result,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (teamTaskCompletionPolicy(task) !== LEGACY_COMPLETION_POLICY) {
    throw new TeamError('explicit_release_required', 'This task requires a worker completion declaration and coordinator release.', 409)
  }
  if (!['dispatching', 'running'].includes(task.status)) throw new TeamError('task_not_running', 'Only the assigned active task may complete.', 409)
  if (task.targetSessionId !== targetSessionId) throw new TeamError('task_target_changed', 'The task belongs to another native session.', 409)
  task.result = boundedResult(result)
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  return transitionTask(task, 'completed', 'legacy_provider_final', { now })
}

export function completeTeamTaskWithWarning(state, taskId, {
  targetSessionId,
  result,
  warning,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (teamTaskCompletionPolicy(task) !== LEGACY_COMPLETION_POLICY) {
    throw new TeamError('explicit_release_required', 'This task requires a worker completion declaration and coordinator release.', 409)
  }
  if (!['dispatching', 'running'].includes(task.status)) {
    throw new TeamError('task_not_running', 'Only the assigned active task may complete.', 409)
  }
  if (task.targetSessionId !== targetSessionId) {
    throw new TeamError('task_target_changed', 'The task belongs to another native session.', 409)
  }
  task.result = boundedResult(result)
  task.warning = String(warning || 'The provider completed without a reliable lifecycle completion hook.').slice(0, 2000)
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  return transitionTask(task, 'completed_with_warning', 'legacy_provider_idle_without_completion_hook', { now })
}

export function failTeamTask(state, taskId, error, { now = Date.now(), cancelled = false } = {}) {
  const task = teamTask(state, taskId)
  if (!ACTIVE_TASK_STATES.has(task.status)) return task
  task.error = String(error || (cancelled ? 'Task cancelled.' : 'Task failed.')).slice(0, 2000)
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  return transitionTask(task, cancelled ? 'cancelled' : 'failed', cancelled ? 'cancelled' : 'failed', { now })
}

function taskControlRequest(task, requestId, kind, payloadHash) {
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
  if (task.requestId === key) {
    throw new TeamError('request_conflict', 'That request ID was already used to create this task.', 409)
  }
  task.controlRequests ||= []
  const existing = task.controlRequests.find(request => request.requestId === key)
  if (existing && (existing.kind !== kind || existing.payloadHash !== payloadHash)) {
    throw new TeamError('request_conflict', 'That request ID was already used for a different task operation.', 409)
  }
  return { key, existing }
}

function rememberTaskControl(task, requestId, kind, payloadHash, now) {
  task.controlRequests ||= []
  if (task.controlRequests.length >= TASK_CONTROL_MAX) {
    throw new TeamError('task_control_limit', 'This task reached its bounded control-operation limit.', 409)
  }
  task.controlRequests.push({ requestId, kind, payloadHash, createdAt: nowIso(now) })
}

export function cancelQueuedTeamTask(state, taskId, {
  sourceChannel,
  reason = 'Cancelled by the coordinator.',
  requestId = `cancel:${String(taskId || '')}`,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.sourceChannel !== sourceChannel) {
    throw new TeamError('task_control_not_allowed', 'Only the task coordinator may cancel queued work.', 403)
  }
  const body = String(reason || 'Cancelled by the coordinator.').slice(0, 2000)
  const payloadHash = hash(body)
  const control = taskControlRequest(task, requestId, 'cancel', payloadHash)
  if (task.status === 'cancelled') {
    if (task.terminalRequest?.requestId === control.key) {
      if (task.terminalRequest.payloadHash === payloadHash) return task
      throw new TeamError('request_conflict',
        'That cancellation request ID was already accepted with a different reason.', 409)
    }
    if (control.existing) return task
    // Preserve the historical idempotent cancellation surface while making a
    // new bounded request identity queryable when journal capacity permits.
    if (task.controlRequests.length >= TASK_CONTROL_MAX) {
      throw new TeamError('task_control_limit',
        'This cancelled task cannot journal another cancellation request identity.', 409)
    }
    rememberTaskControl(task, control.key, 'cancel', payloadHash, now)
    bumpTask(task, now)
    return task
  }
  if (control.existing) return task
  if (task.status !== 'queued') throw new TeamError('task_not_queued', 'Only queued work may be cancelled.', 409)
  // Cancellation is the terminal safety valve and must remain available even
  // after the bounded replace/message idempotency journal is full. A terminal
  // cancelled task itself makes subsequent cancellation retries harmless.
  if (task.controlRequests.length < TASK_CONTROL_MAX) {
    rememberTaskControl(task, control.key, 'cancel', payloadHash, now)
  }
  task.terminalRequest = { requestId: control.key, kind: 'cancel', payloadHash, createdAt: nowIso(now) }
  return failTeamTask(state, task.id, body, { now, cancelled: true })
}

export function replaceQueuedTeamTask(state, taskId, {
  sourceChannel,
  text,
  requestId,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.sourceChannel !== sourceChannel) {
    throw new TeamError('task_control_not_allowed', 'Only the task coordinator may replace queued work.', 403)
  }
  const body = String(text || '').trim()
  if (!body) throw new TeamError('empty_task', 'A replacement task needs text.')
  if (textBytes(body) > TEAM_MESSAGE_MAX_BYTES) throw new TeamError('message_too_large', `Team messages may be at most ${TEAM_MESSAGE_MAX_BYTES} bytes.`, 413)
  const payloadHash = hash(body)
  const control = taskControlRequest(task, requestId, 'replace', payloadHash)
  if (control.existing) return { task, created: false }
  if (task.status !== 'queued') throw new TeamError('task_not_queued', 'Only queued work may be replaced.', 409)
  rememberTaskControl(task, control.key, 'replace', payloadHash, now)
  task.instruction = body
  task.text = body
  task.instructionVersion = Math.max(1, Number(task.instructionVersion) || 1) + 1
  task.currentPayloadHash = taskPayloadHash({ text: body, files: task.files })
  bumpTask(task, now)
  return { task, created: true }
}

export function appendCoordinatorTaskMessage(state, taskId, {
  sourceChannel,
  text,
  requestId,
  now = Date.now(),
  id = randomId('message'),
} = {}) {
  const task = teamTask(state, taskId)
  if (task.sourceChannel !== sourceChannel) {
    throw new TeamError('task_control_not_allowed', 'Only the task coordinator may message its worker.', 403)
  }
  const body = String(text || '').trim()
  if (!body) throw new TeamError('empty_message', 'A task message needs text.')
  if (textBytes(body) > TEAM_MESSAGE_MAX_BYTES) throw new TeamError('message_too_large', `Team messages may be at most ${TEAM_MESSAGE_MAX_BYTES} bytes.`, 413)
  const payloadHash = hash(body)
  const control = taskControlRequest(task, requestId, 'message', payloadHash)
  task.messages ||= []
  const existing = task.messages.find(message => message.requestId === control.key)
  if (control.existing || existing) return { message: existing, created: false }
  if (!WORKER_BOUND_TASK_STATES.has(task.status)) {
    throw new TeamError('task_not_active', 'Only an active task accepts coordinator messages.', 409)
  }
  rememberTaskControl(task, control.key, 'message', payloadHash, now)
  const message = {
    id: String(id), requestId: control.key, payloadHash, text: body,
    deliveryStatus: 'pending', deliveryError: null, sourceSlackTs: null,
    targetSlackTs: null, createdAt: nowIso(now),
    resumesTask: task.status === 'awaiting_release',
    workGeneration: teamTaskWorkGeneration(task) + 1,
  }
  if (invalidateCompletionRequest(task, {
    reason: 'coordinator_follow_up', requestId: control.key, now,
  })) message.invalidatedCompletion = true
  task.messages.push(message)
  task.workGeneration = message.workGeneration
  bumpTask(task, now)
  return { message, created: true }
}

export function beginCoordinatorTaskMessageDelivery(state, taskId, messageId, { now = Date.now() } = {}) {
  const task = teamTask(state, taskId)
  const message = (task.messages || []).find(item => item.id === messageId)
  if (!message) throw new TeamError('task_message_not_found', 'That coordinator task message is unavailable.', 404)
  message.deliveryStartedAt ||= nowIso(now)
  // Slack mirroring is deliberately awaited before provider delivery. The
  // worker can report during that window, so delivery-time state—not the state
  // observed when the message was journaled—decides whether this is a resumed
  // turn and invalidates the now-stale readiness declaration.
  if (task.status === 'awaiting_release') {
    message.resumesTask = true
    if (invalidateCompletionRequest(task, {
      reason: 'coordinator_follow_up', requestId: message.requestId, now,
    })) message.invalidatedCompletion = true
  }
  return task
}

export function completeCoordinatorTaskMessageDelivery(state, taskId, messageId, { now = Date.now() } = {}) {
  const task = teamTask(state, taskId)
  const message = (task.messages || []).find(item => item.id === messageId)
  if (!message) throw new TeamError('task_message_not_found', 'That coordinator task message is unavailable.', 404)
  if (!WORKER_BOUND_TASK_STATES.has(task.status)) {
    throw new TeamError('task_not_active', 'The task ended before this coordinator message completed delivery.', 409)
  }
  if (task.status === 'awaiting_release') {
    message.resumesTask = true
    if (invalidateCompletionRequest(task, {
      reason: 'coordinator_follow_up', requestId: message.requestId, now,
    })) message.invalidatedCompletion = true
  }
  task.providerWorkGeneration = Math.max(
    teamTaskProviderWorkGeneration(task),
    Math.max(1, Number(message.workGeneration) || teamTaskWorkGeneration(task)),
  )
  message.providerDeliveryStatus = 'delivered'
  message.deliveryStatus = 'delivered'
  message.deliveryError = null
  message.deliveredAt = nowIso(now)
  transitionTask(task, 'running', 'coordinator_follow_up_delivered', {
    now, requestId: message.requestId,
  })
  return task
}

export function deferCoordinatorTaskMessageDelivery(state, taskId, messageId, { now = Date.now() } = {}) {
  const task = teamTask(state, taskId)
  const message = (task.messages || []).find(item => item.id === messageId)
  if (!message) throw new TeamError('task_message_not_found', 'That coordinator task message is unavailable.', 404)
  message.deliveryDeferredAt = nowIso(now)
  return task
}

function cancelTasks(state, predicate, reason, now) {
  const cancelled = []
  for (const task of Object.values(stores(state).tasks)) {
    if (!predicate(task)) continue
    failTeamTask(state, task.id, reason, { now, cancelled: true })
    cancelled.push(task.id)
  }
  return cancelled
}

export function tasksForChannel(state, channel, { limit = 100, after = null } = {}) {
  const visible = Object.values(stores(state).tasks)
    .filter(task => task.sourceChannel === channel || task.targetChannel === channel)
  let afterTask = null
  if (after) {
    afterTask = visible.find(task => task.id === after)
    if (!afterTask) throw new TeamError('invalid_cursor', 'That inbox cursor is unavailable for this channel.', 404)
  }
  return visible
    .filter(task => !afterTask || String(task.createdAt) > String(afterTask.createdAt) ||
      (task.createdAt === afterTask.createdAt && task.id > afterTask.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 100, 200)))
}

function decodeTaskCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor || ''), 'base64url').toString('utf8'))
    if (!parsed?.createdAt || !parsed?.id) throw new Error('invalid')
    return parsed
  } catch {
    throw new TeamError('invalid_cursor', 'That inbox cursor is invalid.', 400)
  }
}

function encodeTaskCursor(task) {
  return Buffer.from(JSON.stringify({ createdAt: task.createdAt, id: task.id })).toString('base64url')
}

export function tasksPageForChannel(state, channel, {
  limit = 100,
  cursor = null,
  active = false,
  target = null,
  status = null,
  since = null,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 200))
  const statuses = status == null ? null : new Set((Array.isArray(status) ? status : [status]).map(String))
  if (statuses && [...statuses].some(value => !TASK_STATES.has(value))) {
    throw new TeamError('invalid_status', 'One or more inbox task statuses are invalid.')
  }
  const sinceTime = since == null ? null : Date.parse(String(since))
  if (since != null && !Number.isFinite(sinceTime)) throw new TeamError('invalid_since', 'Inbox since must be an ISO timestamp.')
  const pageAfter = cursor ? decodeTaskCursor(cursor) : null
  const selector = target == null ? null : String(target).trim().toLowerCase()
  const visible = Object.values(stores(state).tasks)
    .filter(task => task.sourceChannel === channel || task.targetChannel === channel)
    .filter(task => !active || ACTIVE_TASK_STATES.has(task.status))
    .filter(task => !statuses || statuses.has(task.status))
    .filter(task => !selector || task.targetAlias === selector || String(task.targetChannel).toLowerCase() === selector)
    .filter(task => sinceTime == null || Date.parse(task.createdAt) >= sinceTime)
    .filter(task => !pageAfter || String(task.createdAt) < String(pageAfter.createdAt) ||
      (task.createdAt === pageAfter.createdAt && task.id < pageAfter.id))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))
  const page = visible.slice(0, boundedLimit)
  return {
    tasks: page,
    nextCursor: visible.length > boundedLimit && page.length ? encodeTaskCursor(page.at(-1)) : null,
  }
}

export function publicTeamTask(task, callerChannel) {
  if (callerChannel !== task.sourceChannel && callerChannel !== task.targetChannel) {
    throw new TeamError('task_not_visible', 'That task does not belong to this channel.', 403)
  }
  return {
    id: task.id,
    teamId: task.teamId,
    parentTaskId: task.parentTaskId || null,
    direction: callerChannel === task.sourceChannel ? 'outgoing' : 'incoming',
    sourceAlias: 'coordinator',
    targetAlias: task.targetAlias,
    status: task.status,
    lifecycleVersion: Math.max(1, Number(task.lifecycleVersion) || 1),
    completionPolicy: teamTaskCompletionPolicy(task),
    pendingGates: [...(task.pendingGates || [])],
    completionRequestedAt: task.completionRequest?.requestedAt || null,
    completionSummary: task.completionRequest?.summary || null,
    workGeneration: teamTaskWorkGeneration(task),
    providerWorkGeneration: teamTaskProviderWorkGeneration(task),
    releaseReady: teamTaskReleaseReady(task),
    instruction: task.instruction ?? task.text ?? '',
    fileDeliveryStatus: task.fileDeliveryStatus,
    fileDeliveryError: task.fileDeliveryError,
    completionDeliveryStatus: task.completionDeliveryStatus || null,
    completionDeliveryError: task.completionDeliveryError || null,
    replies: task.replies.map(reply => ({
      id: reply.id,
      text: reply.text,
      files: reply.files.map(file => ({
        filename: file.filename,
        size: file.size,
        ...(callerChannel === task.sourceChannel && file.path ? { path: file.path } : {}),
      })),
      fileDeliveryStatus: reply.fileDeliveryStatus,
      fileDeliveryError: reply.fileDeliveryError,
      kind: reply.kind || 'progress',
      pendingGates: reply.pendingGates || null,
      createdAt: reply.createdAt,
    })),
    messages: (task.messages || []).map(message => ({
      id: message.id,
      text: message.text,
      deliveryStatus: message.deliveryStatus,
      deliveryError: message.deliveryError,
      workGeneration: Number(message.workGeneration) || null,
      createdAt: message.createdAt,
    })),
    reports: (task.reports || []).map(report => ({
      id: report.id,
      result: report.result,
      warning: report.warning || null,
      deliveryStatus: report.deliveryStatus,
      deliveryError: report.deliveryError,
      workGeneration: Number(report.workGeneration) || null,
      createdAt: report.createdAt,
      lifecycleVersion: report.lifecycleVersion,
    })),
    result: task.result,
    warning: task.warning || null,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    turnCompletedAt: task.turnCompletedAt || null,
    updatedAt: task.updatedAt || task.createdAt,
    lastTransition: task.lastTransition || null,
    observedAt: nowIso(Date.now()),
    expiresAt: task.expiresAt,
  }
}

export function teamMutationForRequest(state, callerChannel, requestId, { taskId = null } = {}) {
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
  const visible = Object.values(stores(state).tasks).filter(task =>
    (!taskId || task.id === taskId) &&
    (task.sourceChannel === callerChannel || task.targetChannel === callerChannel))
  const matches = []
  for (const task of visible) {
    if (task.sourceChannel === callerChannel && task.requestId === key) {
      matches.push({ kind: task.parentTaskId ? 'continue' : 'send', resourceId: task.id, task, at: task.createdAt })
    }
    if (task.targetChannel === callerChannel) {
      for (const reply of task.replies || []) {
        if (reply.requestId === key) matches.push({
          kind: reply.kind === 'checkpoint' ? 'checkpoint' : 'reply', resourceId: reply.id, task, at: reply.createdAt,
        })
      }
      const completion = [task.completionRequest, ...(task.completionRequestHistory || [])]
        .find(item => item?.requestId === key)
      if (completion) matches.push({
        kind: 'complete', resourceId: task.id, task, at: completion.requestedAt,
      })
    }
    if (task.sourceChannel === callerChannel) {
      if (task.terminalRequest?.requestId === key) matches.push({
        kind: task.terminalRequest.kind || 'cancel', resourceId: task.id, task, at: task.terminalRequest.createdAt,
      })
      for (const control of task.controlRequests || []) {
        if (control.requestId !== key) continue
        if (task.terminalRequest?.requestId === key && control.kind === task.terminalRequest.kind) continue
        const message = (task.messages || []).find(item => item.requestId === key)
        matches.push({ kind: control.kind, resourceId: message?.id || task.id, task, at: control.createdAt })
      }
    }
  }
  if (!matches.length) throw new TeamError('mutation_not_found', 'No accepted team mutation matches that request ID.', 404)
  if (matches.length > 1) throw new TeamError('ambiguous_request_id', 'That request ID matches more than one visible task; include its task ID.', 409)
  const match = matches[0]
  return {
    requestId: key,
    kind: match.kind,
    status: 'accepted',
    resourceId: match.resourceId,
    taskId: match.task.id,
    taskStatus: match.task.status,
    lifecycleVersion: Math.max(1, Number(match.task.lifecycleVersion) || 1),
    acceptedAt: match.at || match.task.updatedAt || match.task.createdAt,
  }
}

// Repairs only redundant binding projections. It never changes a task status,
// invents provider liveness, or chooses between conflicting active tasks.
export function reconcileTeamSessionBindings(state, { now = Date.now() } = {}) {
  const repairs = []
  const anomalies = []
  const sessions = state?.sessions || {}
  const tasks = state?.teamTasks || {}
  const exactTasksBySession = new Map()
  for (const task of Object.values(tasks)) {
    if (!isWorkerBoundTeamTask(task)) continue
    const session = sessions[task.targetSessionId]
    const exact = session && session.channel === task.targetChannel && state.channels?.[task.targetChannel] === session.id
    if (!exact) continue
    const existing = exactTasksBySession.get(session.id) || []
    existing.push(task)
    exactTasksBySession.set(session.id, existing)
  }
  for (const session of Object.values(sessions)) {
    if (!session?.teamActiveTaskId) continue
    const task = tasks[session.teamActiveTaskId]
    const exact = task && isWorkerBoundTeamTask(task) && task.targetSessionId === session.id &&
      task.targetChannel === session.channel && state.channels?.[session.channel] === session.id
    if (exact) continue
    const oldTaskId = session.teamActiveTaskId
    delete session.teamActiveTaskId
    session.teamAvailabilityChangedAt = nowIso(now)
    session.teamAvailabilityReason = task ? 'cleared_stale_task_binding' : 'cleared_missing_task_binding'
    repairs.push({ sessionId: session.id, taskId: oldTaskId, reason: session.teamAvailabilityReason })
  }
  for (const [sessionId, exactTasks] of exactTasksBySession) {
    const session = sessions[sessionId]
    if (exactTasks.length > 1) {
      anomalies.push({
        sessionId,
        taskIds: exactTasks.map(task => task.id),
        activeTaskId: session.teamActiveTaskId || null,
        reason: 'conflicting_worker_task_bindings',
      })
      continue
    }
    const task = exactTasks[0]
    if (!session.teamActiveTaskId) {
      session.teamActiveTaskId = task.id
      session.teamAvailabilityChangedAt = nowIso(now)
      session.teamAvailabilityReason = 'restored_durable_task_binding'
      repairs.push({ sessionId: session.id, taskId: task.id, reason: session.teamAvailabilityReason })
    }
  }
  return { changed: repairs.length > 0, repairs, anomalies }
}

export function pruneTeamTasks(state, { now = Date.now(), max = TEAM_MAX_TASKS } = {}) {
  const { tasks } = stores(state)
  const removable = Object.values(tasks)
    .filter(task => !isActiveTeamTask(task) && teamTaskDeliverySettled(task) &&
      Date.parse(task.expiresAt || 0) <= now)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
  const removed = []
  for (const task of removable) { delete tasks[task.id]; removed.push(task) }
  const completed = Object.values(tasks)
    .filter(task => !isActiveTeamTask(task) && teamTaskDeliverySettled(task))
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
  while (Object.keys(tasks).length > max && completed.length) {
    const task = completed.shift()
    if (tasks[task.id]) { delete tasks[task.id]; removed.push(task) }
  }
  return removed
}

export function teamTaskDeliverySettled(task) {
  const completion = !Object.hasOwn(task || {}, 'completionDeliveryStatus') ||
    task?.completionDeliveryStatus === 'delivered'
  const replies = (task?.replies || []).every(reply => {
    const text = !reply.text || Boolean(reply.textSlackTs)
    const files = !reply.files?.length || ['none', 'uploaded'].includes(reply.fileDeliveryStatus) ||
      (reply.fileDeliveryStatus === 'failed' && Boolean(reply.fileDeliveryNotifiedAt))
    return text && files
  })
  const messages = (task?.messages || []).every(message => ['delivered', 'failed'].includes(message.deliveryStatus))
  const reports = (task?.reports || []).every(report => report.deliveryStatus === 'delivered')
  return completion && replies && messages && reports
}

export function delegatedTaskPrompt(team, task, destinationFiles = []) {
  const paths = destinationFiles.length
    ? `\nFiles copied into this worker's private attachment area:\n${destinationFiles.map(file => `  • ${file.path}`).join('\n')}`
    : ''
  const lifecycleInstructions = teamTaskCompletionPolicy(task) === LEGACY_COMPLETION_POLICY
    ? [
        'Complete this task independently. Your stable final answer will be returned automatically to the coordinator.',
        `Use \`sab team reply --task ${task.id} --stdin\` for useful interim findings. Use \`sab team send-file --task ${task.id} -- FILE_PATH\` to return files when file relay is enabled.`,
      ]
    : [
        'A provider turn ending reports progress; it does not release this task or its worker reservation.',
        `Use \`sab team checkpoint --task ${task.id} --pending GATE[,GATE] --stdin\` whenever tests, CI, runtime proof, review, or merge work remains. Use \`--pending none\` only when every declared gate is clear.`,
        `Only after all work and gates are complete, declare readiness with \`sab team complete --task ${task.id} --stdin\` before your final answer. The coordinator then releases the task.`,
        `Use \`sab team reply --task ${task.id} --stdin\` for other useful interim findings. Use \`sab team send-file --task ${task.id} -- FILE_PATH\` to return files when file relay is enabled.`,
      ]
  return [
    `<sab-team-task id="${task.id}" team="${team.id}" source="coordinator">`,
    '[Slack Agent Bridge delegated task]',
    `Team: ${team.name}`,
    'Role: worker',
    `Task: ${task.id}`,
    'Origin: coordinator',
    ...lifecycleInstructions,
    'You may not delegate this task to another SAB channel.',
    '</sab-team-task>',
    '',
    task.text,
    paths,
  ].join('\n')
}

// A provider input stream may disappear after a task has been claimed but
// before it acknowledges the immutable marker. If that claim later fails, the
// exact queued envelope must be removed so reconnect recovery cannot execute a
// task whose coordinator has already received a failure.
export function withoutDelegatedTaskPrompt(queue, taskId) {
  const wanted = String(taskId || '')
  return (Array.isArray(queue) ? queue : []).filter(item => {
    const text = typeof item === 'string' ? item : String(item?.text || '')
    return taskMarker(text) !== wanted
  })
}

export function taskMarker(prompt) {
  const match = /<sab-team-task\s+id="(task_[A-Za-z0-9_-]+)"/.exec(String(prompt || ''))
  return match?.[1] || null
}

export function beginOwnerTeamTurn(session, request, { now = Date.now(), budget = 20 } = {}) {
  session.teamTurn = {
    actor: 'owner',
    messageTs: request?.messageTs || null,
    startedAt: nowIso(now),
    expiresAt: nowIso(now + TEAM_TURN_TTL_MS),
    remaining: Math.max(1, Math.min(Number(budget) || 20, 50)),
  }
  return session.teamTurn
}

export function beginCollaboratorTeamTurn(session, request, { now = Date.now() } = {}) {
  session.teamTurn = {
    actor: 'collaborator',
    messageTs: request?.messageTs || null,
    startedAt: nowIso(now),
    expiresAt: nowIso(now + TEAM_TURN_TTL_MS),
    remaining: 0,
  }
  return session.teamTurn
}

export function beginContinuationTeamTurn(session, { teamId, eventId } = {}, {
  now = Date.now(), budget = 20,
} = {}) {
  const team = String(teamId || '')
  const event = String(eventId || '')
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(team) || !/^[A-Za-z0-9_-]{1,128}$/.test(event)) {
    throw new TeamError('invalid_continuation_turn', 'Automatic continuation identity is invalid.', 500)
  }
  session.teamTurn = {
    actor: 'continuation',
    teamId: team,
    eventId: event,
    messageTs: `team-continuation:${event}`,
    startedAt: nowIso(now),
    expiresAt: nowIso(now + TEAM_TURN_TTL_MS),
    remaining: Math.max(1, Math.min(Number(budget) || 20, 50)),
  }
  return session.teamTurn
}

export function assertCoordinatorDispatch(session, {
  now = Date.now(), teamId = null, allowContinuation = false,
} = {}) {
  const turn = session?.teamTurn
  const authorizedActor = turn?.actor === 'owner' || (
    allowContinuation && turn?.actor === 'continuation' && turn.teamId === teamId
  )
  if (!turn || !authorizedActor || Date.parse(turn.expiresAt || 0) <= now) {
    throw new TeamError('owner_turn_required',
      'Team delegation is available only during a current owner or authorized automatic-continuation turn.', 403)
  }
  if (!(turn.remaining > 0)) {
    throw new TeamError('dispatch_budget_exhausted',
      'This turn used its bounded team dispatch budget. Automatic mode can renew it from the next authenticated worker event.', 429)
  }
  return turn
}

export function assertCoordinatorTaskControl(session, {
  now = Date.now(), teamId = null, allowContinuation = false,
} = {}) {
  const turn = session?.teamTurn
  const authorizedActor = turn?.actor === 'owner' || (
    allowContinuation && turn?.actor === 'continuation' && turn.teamId === teamId
  )
  if (!turn || !authorizedActor || Date.parse(turn.expiresAt || 0) <= now) {
    throw new TeamError('owner_turn_required',
      'Team task control is available only during a current owner or authorized automatic-continuation turn.', 403)
  }
  return turn
}

export function consumeCoordinatorDispatch(session, options = {}) {
  const turn = assertCoordinatorDispatch(session, options)
  turn.remaining--
  return turn
}

export function clearTeamTurn(session) {
  if (session && Object.hasOwn(session, 'teamTurn')) {
    delete session.teamTurn
    return true
  }
  return false
}
