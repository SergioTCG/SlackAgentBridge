import crypto from 'node:crypto'

// Keep a full delegated text envelope below Slack's single-message limit so
// both linked channels retain a visible audit copy without hidden history reads.
export const TEAM_MESSAGE_MAX_BYTES = 24 * 1024
export const TEAM_MAX_MEMBERS = 20
export const TEAM_MAX_TASKS = 500
export const TEAM_MAX_REPLIES = 32
export const TEAM_MAX_ACTIVE_TASKS = 64
export const TEAM_MAX_QUEUED_PER_WORKER = 8
export const TEAM_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TEAM_TURN_TTL_MS = 12 * 60 * 60 * 1000

const TEAM_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const TEAM_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TASK_STATES = new Set(['queued', 'dispatching', 'running', 'completed', 'completed_with_warning', 'failed', 'cancelled'])
const ACTIVE_TASK_STATES = new Set(['queued', 'dispatching', 'running'])
const TASK_CONTROL_MAX = 32

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
      'Use `sab team message --task TASK_ID --stdin` to amend or answer an active task, `sab team replace` or `sab team cancel` for queued work, and `sab team mode draining` to finish active work without dispatching more.',
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

export function createTeamTask(state, {
  teamId,
  sourceChannel,
  sourceSessionId,
  sourceProvider,
  sourceNodeId = 'local',
  target,
  text,
  files = [],
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
  const payloadHash = taskPayloadHash({ text: prompt, files })
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
    targetSessionId: null,
    targetProvider: null,
    targetNodeId: null,
    status: 'queued',
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

export function assertTeamTaskRetry(state, task, { teamId, target, text, files = [] } = {}) {
  const { channel } = resolveTeamPeer(state, teamId, target)
  const payloadHash = taskPayloadHash({ text: String(text || '').trim(), files })
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
  task.status = 'dispatching'
  task.targetSessionId = String(targetSessionId || '')
  task.targetProvider = String(targetProvider || '')
  task.targetNodeId = String(targetNodeId || 'local')
  task.dispatchClaimedAt = nowIso(now)
  return bumpTask(task, now)
}

export function claimTeamTaskForSession(state, taskId, session, options = {}) {
  if (!session || typeof session !== 'object' || !session.id) {
    throw new TeamError('invalid_worker_session', 'An authoritative worker session is required.', 500)
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
  return task
}

export function markTeamTaskRunning(state, taskId, { now = Date.now() } = {}) {
  const task = teamTask(state, taskId)
  if (!['dispatching', 'running'].includes(task.status)) throw new TeamError('task_not_dispatching', 'The task is not being dispatched.', 409)
  task.status = 'running'
  task.startedAt ||= nowIso(now)
  task.acceptedAt ||= nowIso(now)
  // Retain the original instruction separately for bounded inbox/audit output.
  // The mutable delivery envelope can still be released after acceptance.
  task.text = ''
  return bumpTask(task, now)
}

export function appendTeamTaskReply(state, taskId, {
  fromChannel,
  text,
  files = [],
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
  const payloadHash = taskPayloadHash({ text: body, files })
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
  if (!ACTIVE_TASK_STATES.has(task.status)) throw new TeamError('task_not_active', 'That task no longer accepts replies.', 409)
  if (task.replies.length >= TEAM_MAX_REPLIES) throw new TeamError('reply_limit', 'This task reached its bounded reply limit.', 409)
  const reply = {
    id: String(id), requestId: key, payloadHash, fromChannel, text: body,
    files: files.map(file => ({
      path: file.path, filename: file.filename, size: file.size, sha256: file.sha256 || null,
    })),
    textSlackTs: null,
    fileDeliveryStatus: files.length ? 'pending' : 'none',
    fileDeliveryError: null,
    createdAt: nowIso(now),
  }
  task.replies.push(reply)
  const accepted = task.status === 'dispatching'
  if (accepted) markTeamTaskRunning(state, task.id, { now })
  else bumpTask(task, now)
  reply.lifecycleVersion = task.lifecycleVersion
  return { reply, created: true, accepted }
}

export function completeTeamTask(state, taskId, {
  targetSessionId,
  result,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (!['dispatching', 'running'].includes(task.status)) throw new TeamError('task_not_running', 'Only the assigned active task may complete.', 409)
  if (task.targetSessionId !== targetSessionId) throw new TeamError('task_target_changed', 'The task belongs to another native session.', 409)
  const text = String(result || '').trim()
  task.status = 'completed'
  task.result = textBytes(text) > TEAM_MESSAGE_MAX_BYTES
    ? Buffer.from(text, 'utf8').subarray(0, TEAM_MESSAGE_MAX_BYTES).toString('utf8') + '\n\n[Result truncated in the team journal; see the worker Slack channel for the complete response.]'
    : text
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  return bumpTask(task, now)
}

export function completeTeamTaskWithWarning(state, taskId, {
  targetSessionId,
  result,
  warning,
  now = Date.now(),
} = {}) {
  const task = teamTask(state, taskId)
  if (!['dispatching', 'running'].includes(task.status)) {
    throw new TeamError('task_not_running', 'Only the assigned active task may complete.', 409)
  }
  if (task.targetSessionId !== targetSessionId) {
    throw new TeamError('task_target_changed', 'The task belongs to another native session.', 409)
  }
  const text = String(result || '').trim()
  task.status = 'completed_with_warning'
  task.result = textBytes(text) > TEAM_MESSAGE_MAX_BYTES
    ? Buffer.from(text, 'utf8').subarray(0, TEAM_MESSAGE_MAX_BYTES).toString('utf8') + '\n\n[Result truncated in the team journal; see the worker Slack channel for the complete response.]'
    : text
  task.warning = String(warning || 'The provider completed without a reliable lifecycle completion hook.').slice(0, 2000)
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  return bumpTask(task, now)
}

export function failTeamTask(state, taskId, error, { now = Date.now(), cancelled = false } = {}) {
  const task = teamTask(state, taskId)
  if (!ACTIVE_TASK_STATES.has(task.status)) return task
  task.status = cancelled ? 'cancelled' : 'failed'
  task.error = String(error || (cancelled ? 'Task cancelled.' : 'Task failed.')).slice(0, 2000)
  task.text = ''
  task.files = []
  task.completionDeliveryStatus = 'pending'
  task.completionDeliveryError = null
  task.completedAt = nowIso(now)
  return bumpTask(task, now)
}

function taskControlRequest(task, requestId, kind, payloadHash) {
  const key = String(requestId || '')
  if (!REQUEST_ID_RE.test(key)) throw new TeamError('invalid_request_id', 'A bounded idempotency request ID is required.')
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
  if (task.status === 'cancelled') return task
  if (control.existing) return task
  if (task.status !== 'queued') throw new TeamError('task_not_queued', 'Only queued work may be cancelled.', 409)
  // Cancellation is the terminal safety valve and must remain available even
  // after the bounded replace/message idempotency journal is full. A terminal
  // cancelled task itself makes subsequent cancellation retries harmless.
  if (task.controlRequests.length < TASK_CONTROL_MAX) {
    rememberTaskControl(task, control.key, 'cancel', payloadHash, now)
  }
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
  if (!['dispatching', 'running'].includes(task.status)) {
    throw new TeamError('task_not_active', 'Only an active task accepts coordinator messages.', 409)
  }
  rememberTaskControl(task, control.key, 'message', payloadHash, now)
  const message = {
    id: String(id), requestId: control.key, payloadHash, text: body,
    deliveryStatus: 'pending', deliveryError: null, sourceSlackTs: null,
    targetSlackTs: null, createdAt: nowIso(now),
  }
  task.messages.push(message)
  bumpTask(task, now)
  return { message, created: true }
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
    direction: callerChannel === task.sourceChannel ? 'outgoing' : 'incoming',
    sourceAlias: 'coordinator',
    targetAlias: task.targetAlias,
    status: task.status,
    lifecycleVersion: Math.max(1, Number(task.lifecycleVersion) || 1),
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
      createdAt: reply.createdAt,
    })),
    messages: (task.messages || []).map(message => ({
      id: message.id,
      text: message.text,
      deliveryStatus: message.deliveryStatus,
      deliveryError: message.deliveryError,
      createdAt: message.createdAt,
    })),
    result: task.result,
    warning: task.warning || null,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    expiresAt: task.expiresAt,
  }
}

export function pruneTeamTasks(state, { now = Date.now(), max = TEAM_MAX_TASKS } = {}) {
  const { tasks } = stores(state)
  const removable = Object.values(tasks)
    .filter(task => !ACTIVE_TASK_STATES.has(task.status) && teamTaskDeliverySettled(task) &&
      Date.parse(task.expiresAt || 0) <= now)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))
  const removed = []
  for (const task of removable) { delete tasks[task.id]; removed.push(task) }
  const completed = Object.values(tasks)
    .filter(task => !ACTIVE_TASK_STATES.has(task.status) && teamTaskDeliverySettled(task))
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
  return completion && replies && messages
}

export function delegatedTaskPrompt(team, task, destinationFiles = []) {
  const paths = destinationFiles.length
    ? `\nFiles copied into this worker's private attachment area:\n${destinationFiles.map(file => `  • ${file.path}`).join('\n')}`
    : ''
  return [
    `<sab-team-task id="${task.id}" team="${team.id}" source="coordinator">`,
    '[Slack Agent Bridge delegated task]',
    `Team: ${team.name}`,
    'Role: worker',
    `Task: ${task.id}`,
    'Origin: coordinator',
    'Complete this task independently. Your stable final answer will be returned automatically to the coordinator.',
    `Use \`sab team reply --task ${task.id} --stdin\` for useful interim findings. Use \`sab team send-file --task ${task.id} -- FILE_PATH\` to return files when file relay is enabled.`,
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
