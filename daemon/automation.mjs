import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { channelNodeId, nodeIdForSession, LOCAL_NODE_ID } from './nodes.mjs'
import { TEAM_MESSAGE_MAX_BYTES } from './teams.mjs'

import {
  isPathWithin,
  normalizeProvider,
  normalizeRemoteLaunchFlags,
  providerOf,
} from './providers.mjs'

const MAX_EXTERNAL_KEY = 512
const MAX_INITIAL_PROMPT_BYTES = 256 * 1024
const SLACK_USER_ID = /^[UW][A-Z0-9]{8,}$/
// Slack channel names: lowercase letters, digits, hyphens and underscores, at
// most 80 characters. A requested name is used verbatim, never suffixed.
export const SLACK_CHANNEL_NAME = /^[a-z0-9_-]{1,80}$/
const TEAM_SELECTOR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const TEAM_ALIAS = /^[a-z0-9][a-z0-9_-]{0,47}$/
const TEAM_REQUEST_KEYS = new Set(['name', 'alias', 'task', 'createTeam'])
const NEW_TEAM_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/
const TERMINAL_STATUSES = new Set(['stopped', 'released'])

export const automationOwnsSession = (record, session) => Boolean(record && !TERMINAL_STATUSES.has(record.status) &&
  (record.sessionId === session.id || session.tmux && record.tmux === session.tmux))

export async function proveAutomationReleaseProcess(session, { pidAlive, isTmuxAlive, validProviderRootClaim }) {
  const { pid, tmux } = session
  return Boolean(pid && tmux && pidAlive(pid) && await isTmuxAlive(tmux) &&
    await validProviderRootClaim(pid, tmux, providerOf(session)) &&
    session.pid === pid && session.tmux === tmux && pidAlive(pid))
}

export function validateAutomationRelease(input) {
  const patterns = { requestId: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, sessionId: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/,
    channelId: /^[CG][A-Z0-9]{1,32}$/, tmux: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 4 ||
      Object.entries(patterns).some(([key, pattern]) => typeof input[key] !== 'string' || !pattern.test(input[key]))) {
    throw new AutomationRequestError('invalid_release', 'release requires exact requestId, sessionId, channelId and tmux')
  }
  return Object.fromEntries(Object.keys(patterns).map(key => [key, input[key]]))
}

export class AutomationRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'AutomationRequestError'
    this.code = code
    this.status = status
  }
}

function requestError(code, message) {
  throw new AutomationRequestError(code, message)
}

function validateExternalKey(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > MAX_EXTERNAL_KEY || /[\u0000-\u001f\u007f]/.test(value)) {
    requestError('invalid_external_key', `externalKey must be 1-${MAX_EXTERNAL_KEY} printable characters without surrounding whitespace`)
  }
  // URL parsers normalize these two complete path segments before routing, so
  // accepting either would create a durable automation that status/stop cannot
  // address through the public lifecycle API.
  if (['.', '..', '__proto__', 'prototype', 'constructor'].includes(value)) requestError('invalid_external_key', 'externalKey is reserved')
  return value
}

export function validateAutomationRequest(input, { home = process.env.HOME } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) requestError('invalid_request', 'request body must be a JSON object')
  const externalKey = validateExternalKey(input.externalKey)
  const provider = typeof input.provider === 'string' ? normalizeProvider(input.provider, '') : null
  if (!provider) requestError('unknown_provider', 'provider must be claude, codex, or pi')

  if (typeof input.cwd !== 'string' || !input.cwd || input.cwd.includes('\0')) requestError('invalid_cwd', 'cwd is required')
  const requestedCwd = path.resolve(input.cwd.replace(/^~/, home))
  let cwd = requestedCwd
  let canonicalHome = home
  let directory = false
  try {
    cwd = fs.realpathSync(requestedCwd)
    canonicalHome = fs.realpathSync(home)
    directory = fs.statSync(cwd).isDirectory()
  } catch {}
  if (!home || !isPathWithin(canonicalHome, cwd) || !directory) requestError('invalid_cwd', 'cwd is not an allowed existing directory')

  let flags
  try { flags = normalizeRemoteLaunchFlags(provider, input.flags ?? []) }
  catch (error) { requestError('invalid_flags', String(error?.message || error)) }
  if (provider === 'claude' && flags.some(flag => flag.split('=', 1)[0] === '--continue')) {
    requestError('invalid_flags', '--continue cannot create an independently owned automation session')
  }

  if (!Array.isArray(input.collaborators)) requestError('invalid_collaborators', 'collaborators must be an array of Slack user IDs')
  const collaborators = []
  for (const value of input.collaborators) {
    if (typeof value !== 'string' || !SLACK_USER_ID.test(value)) {
      requestError('invalid_collaborator', `invalid collaborator Slack user ID: ${String(value || '')}`)
    }
    if (!collaborators.includes(value)) collaborators.push(value)
  }
  if (collaborators.length > 50) requestError('invalid_collaborators', 'at most 50 collaborators may be requested')

  if (typeof input.initialPrompt !== 'string') requestError('invalid_initial_prompt', 'initialPrompt must be a string')
  if (Buffer.byteLength(input.initialPrompt) > MAX_INITIAL_PROMPT_BYTES) {
    requestError('invalid_initial_prompt', `initialPrompt may be at most ${MAX_INITIAL_PROMPT_BYTES} bytes`)
  }

  let channelName = null
  if (input.channelName !== undefined && input.channelName !== null) {
    if (typeof input.channelName !== 'string' || !SLACK_CHANNEL_NAME.test(input.channelName)) {
      requestError('invalid_channel_name', 'channelName must be 1-80 lowercase letters, digits, hyphens or underscores')
    }
    channelName = input.channelName
  }

  let team = null
  if (input.team !== undefined && input.team !== null) {
    if (typeof input.team !== 'object' || Array.isArray(input.team) ||
        Object.keys(input.team).some(key => !TEAM_REQUEST_KEYS.has(key))) {
      requestError('invalid_team', 'team must be an object with name and optional alias and task')
    }
    if (typeof input.team.name !== 'string' || !TEAM_SELECTOR.test(input.team.name)) {
      requestError('invalid_team', 'team.name must name the active team the caller coordinates')
    }
    let alias = null
    if (input.team.alias !== undefined && input.team.alias !== null) {
      if (typeof input.team.alias !== 'string' || !TEAM_ALIAS.test(input.team.alias)) {
        requestError('invalid_team_alias', 'team.alias must be 1-48 lowercase letters, digits, hyphens or underscores')
      }
      alias = input.team.alias
    }
    let task = null
    if (input.team.task !== undefined && input.team.task !== null) {
      if (typeof input.team.task !== 'string' || !input.team.task.trim()) {
        requestError('invalid_team_task', 'team.task must be non-empty text')
      }
      task = input.team.task.trim()
      if (Buffer.byteLength(task) > TEAM_MESSAGE_MAX_BYTES) {
        requestError('invalid_team_task', `team.task may be at most ${TEAM_MESSAGE_MAX_BYTES} bytes`)
      }
      // The task header is the first prompt, so the worker starts inside the
      // task lifecycle. A second raw prompt would compete with that turn.
      if (input.initialPrompt.trim()) {
        requestError('invalid_initial_prompt', 'a team bootstrap task replaces initialPrompt; send an empty initialPrompt')
      }
    }
    // The new channel may also coordinate a new sub-team of the caller's team.
    let createTeam = null
    if (input.team.createTeam !== undefined && input.team.createTeam !== null) {
      if (typeof input.team.createTeam !== 'string' || !NEW_TEAM_NAME.test(input.team.createTeam)) {
        requestError('invalid_team_name', 'team.createTeam must be 1-48 lowercase letters, digits, hyphens or underscores')
      }
      createTeam = input.team.createTeam
    }
    team = { name: input.team.name, alias, task, createTeam }
  }
  return { externalKey, cwd, provider, flags, collaborators, initialPrompt: input.initialPrompt, channelName, team }
}

// Requests that create a named or team-bound channel are compared on replay:
// one external key must never name two different channels, teams or tasks.
function requestFingerprint(request) {
  return crypto.createHash('sha256').update(JSON.stringify({
    externalKey: request.externalKey,
    cwd: request.cwd,
    provider: request.provider,
    flags: request.flags,
    collaborators: request.collaborators,
    initialPrompt: promptDigest(request.initialPrompt),
    channelName: request.channelName,
    team: request.team ? {
      name: request.team.name, alias: request.team.alias, task: promptDigest(request.team.task),
      createTeam: request.team.createTeam || null,
    } : null,
  })).digest('hex')
}

function automationTmux(externalKey) {
  return `sab-auto-${crypto.createHash('sha256').update(externalKey).digest('hex').slice(0, 20)}`
}

function errorCode(error) {
  return String(error?.code || error?.data?.error || 'unknown_error').slice(0, 100)
}

function errorMessage(error) {
  return String(error?.message || error?.data?.error || error || 'unknown error').slice(0, 1000)
}

const promptDigest = value => crypto.createHash('sha256').update(String(value || '').trim()).digest('hex')

export function shouldFenceAutomationHook(record, tmux) {
  if (!record || !tmux || record.tmux !== tmux) return false
  return Boolean(record.stop?.requestedAt || record.stop?.terminated || ['stopping', 'stopped'].includes(record.status))
}

export async function waitForProviderInput(session, {
  isProcessAlive,
  isTmuxAlive,
  piStream,
  sleep,
  attempts = 60,
  intervalMs = 500,
}) {
  if (!(session?.pid && isProcessAlive(session.pid))) throw new Error('the correlated provider process is not alive')
  if (!session.tmux || !(await isTmuxAlive(session.tmux))) throw new Error('the correlated tmux session is not alive')
  if (providerOf(session) !== 'pi') return
  for (let i = 0; i < attempts; i++) {
    const stream = piStream(session.pid)
    if (stream?.provider === 'pi' && !stream.res.writableEnded && !stream.res.destroyed) return
    if (!isProcessAlive(session.pid)) throw new Error('the correlated Pi process exited before its input stream connected')
    await sleep(intervalMs)
  }
  throw new Error('the authenticated Pi input stream did not connect before the readiness deadline')
}

function publicStatus(record) {
  if (!record) return null
  return {
    externalKey: record.externalKey,
    status: record.status,
    sessionId: record.sessionId || null,
    tmux: record.tmux,
    channelId: record.channelId || null,
    ...(record.channelName ? { channelName: record.channelName } : {}),
    ...(record.team ? {
      team: {
        teamId: record.team.teamId,
        teamName: record.team.teamName,
        alias: record.team.alias,
        role: 'worker',
        taskId: record.team.taskId || null,
        ...(record.team.createdTeam ? { coordinates: { ...record.team.createdTeam } } : {}),
      },
    } : {}),
    cwd: record.cwd,
    provider: record.provider,
    flags: [...record.flags],
    collaborators: record.collaborators.map(item => ({
      userId: item.userId,
      displayName: item.displayName || null,
      status: item.status,
      invitation: item.invitation || null,
      error: item.error || null,
    })),
    prompt: {
      status: record.prompt.status,
      claimedAt: record.prompt.claimedAt || null,
      deliveredAt: record.prompt.deliveredAt || null,
      acknowledgedAt: record.prompt.acknowledgedAt || null,
    },
    failure: record.failure ? { ...record.failure } : null,
    stop: record.stop ? { ...record.stop } : null,
    ...(record.release ? { release: { ...record.release } } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function createAutomationLifecycle({
  state,
  home = process.env.HOME,
  persist,
  schedule = fn => setImmediate(fn),
  launch,
  invite,
  inject,
  waitForInputReady = async () => {},
  terminate,
  archive,
  isTmuxAlive = async () => true,
  validateReleaseSession = async () => false,
  notifyReleased = async () => {},
  launchTimeoutMs = 5 * 60 * 1000,
  notifyFailure = async () => {},
  // Creates the Slack channel of a named or team-bound automation before its
  // launch. Rejections carrying `definitive: true` prove nothing was created.
  prepareChannel = null,
  // Team adapter: authorize(request, caller) is the only asynchronous step;
  // reserve/bind/release are synchronous journal mutations.
  teamBootstrap = null,
  now = () => Date.now(),
  log = () => {},
}) {
  if (!state || typeof state !== 'object') throw new TypeError('automation lifecycle requires state')
  for (const [name, fn] of Object.entries({ persist, launch, invite, inject, terminate, archive })) {
    if (typeof fn !== 'function') throw new TypeError(`automation lifecycle requires ${name}()`)
  }
  const running = new Map()
  const bootstrapRunning = new Map()
  const sessionRefs = new Map()
  // Channel preparations owned by this process. The loopback API accepts
  // requests before boot recovery runs, so recovery must not mistake one of
  // these for a preparation interrupted by an earlier process.
  const preparing = new Map()

  const records = () => state.automations || {}
  const recordFor = externalKey => Object.hasOwn(records(), externalKey) ? records()[externalKey] : null
  const touch = record => { record.updatedAt = now(); persist() }
  const stopRequested = record => Boolean(record?.stop?.requestedAt)

  function setFailure(record, code, message, action) {
    if (!record || TERMINAL_STATUSES.has(record.status)) return
    record.status = 'failed'
    record.failure = { code, message: String(message).slice(0, 1000), action, at: now() }
    touch(record)
  }

  function runOnce(key, operation, task) {
    const marker = `${key}:${operation}`
    if (running.has(marker)) return running.get(marker)
    let finish
    const completion = new Promise(resolve => { finish = resolve })
    running.set(marker, completion)
    schedule(async () => {
      try { await task() }
      catch (error) { log('automation task failed', key, operation, errorMessage(error)) }
      finally { running.delete(marker); finish() }
    })
    return completion
  }

  async function launchPending(externalKey) {
    const record = recordFor(externalKey)
    if (!record || record.status !== 'pending') return
    record.status = 'launching'
    record.launchRequestedAt = now()
    touch(record) // the no-retry crash boundary precedes every external effect
    try {
      await launch(record)
      if (record.status === 'launching') {
        record.status = 'awaiting_session'
        record.launchAcceptedAt = now()
        touch(record)
      }
    } catch (error) {
      setFailure(record, 'launch_failed', errorMessage(error), 'Fix the launch error, stop this automation, and create a new externalKey.')
      await notifyFailure(record, record.failure).catch(() => {})
    }
  }

  function exactSession(record) {
    const candidate = sessionRefs.get(record.sessionId) || state.sessions?.[record.sessionId]
    if (!candidate || candidate.id !== record.sessionId || candidate.tmux !== record.tmux || providerOf(candidate) !== record.provider) return null
    if (candidate.channel !== record.channelId) return null
    return candidate
  }

  async function configure(externalKey) {
    const record = recordFor(externalKey)
    if (!record || stopRequested(record) || !['configuring_collaborators', 'ready_to_prompt'].includes(record.status)) return
    const session = exactSession(record)
    if (!session) {
      setFailure(record, 'session_correlation_lost', 'The correlated provider session is no longer bound to the expected tmux and Slack channel.', 'Inspect the automation status, then stop it before retrying with a new externalKey.')
      await notifyFailure(record, record.failure).catch(() => {})
      return
    }

    record.status = 'configuring_collaborators'
    touch(record)
    for (const collaborator of record.collaborators) {
      if (collaborator.status === 'ready') continue
      if (collaborator.status === 'failed') return
      let result
      try { result = await invite(record.channelId, collaborator.userId) }
      catch (error) {
        if (stopRequested(record)) return
        collaborator.status = 'failed'
        collaborator.error = { code: errorCode(error), message: errorMessage(error) }
        setFailure(
          record,
          'collaborator_invitation_failed',
          `Slack could not invite ${collaborator.userId}: ${collaborator.error.message}`,
          'Correct the Slack membership or app scope problem, then stop this automation and retry with a new externalKey.',
        )
        await notifyFailure(record, record.failure).catch(() => {})
        return
      }
      if (stopRequested(record)) return
      const name = String(result?.name || collaborator.userId).slice(0, 256)
      if (!state.whitelist) state.whitelist = {}
      state.whitelist[record.channelId] = { ...(state.whitelist[record.channelId] || {}), [collaborator.userId]: name }
      collaborator.displayName = name
      collaborator.invitation = result?.invitation || 'invited'
      collaborator.status = 'ready'
      collaborator.error = null
      touch(record) // invitation result and whitelist become durable together
    }

    if (stopRequested(record) || record.status !== 'configuring_collaborators') return
    record.status = 'ready_to_prompt'
    touch(record)
    if (record.prompt.status === 'team_task') {
      // The team dispatcher delivers the bootstrap task with its normal header
      // and exactly-once claim. It may start only after collaborator setup.
      try { await waitForInputReady(session) }
      catch (error) {
        if (stopRequested(record)) return
        setFailure(record, 'input_not_ready', errorMessage(error), 'Fix the provider input transport, then stop this automation and retry with a new externalKey.')
        await notifyFailure(record, record.failure).catch(() => {})
        return
      }
      if (stopRequested(record) || record.status !== 'ready_to_prompt') return
      record.status = 'active'
      touch(record)
      try { teamBootstrap?.ready?.(record) }
      catch (error) { log('automation team task wake failed', record.externalKey, errorMessage(error)) }
      return
    }
    if (record.prompt.status === 'delivered') {
      record.status = 'active'
      touch(record)
      return
    }
    if (record.prompt.status !== 'pending') return
    if (!record.initialPrompt) {
      record.initialPrompt = null
      record.prompt.status = 'delivered'
      record.prompt.deliveredAt = now()
      record.status = 'active'
      touch(record)
      return
    }

    try { await waitForInputReady(session) }
    catch (error) {
      if (stopRequested(record)) return
      setFailure(record, 'input_not_ready', errorMessage(error), 'Fix the provider input transport, then stop this automation and retry with a new externalKey.')
      await notifyFailure(record, record.failure).catch(() => {})
      return
    }
    if (stopRequested(record)) return

    // tmux/SSE input and the JSON state file cannot share a transaction. Claim
    // first and never retry an ambiguous claim: this guarantees at-most-once
    // submission across daemon crashes, with an actionable failure instead of
    // silently running the same remote job twice.
    const initialPrompt = record.initialPrompt
    record.prompt.sha256 = promptDigest(initialPrompt)
    record.prompt.status = 'claimed'
    record.prompt.claimedAt = now()
    record.status = 'injecting_prompt'
    record.initialPrompt = null
    touch(record)
    try {
      await inject(session, initialPrompt)
    } catch (error) {
      if (stopRequested(record)) return
      record.prompt.status = 'failed'
      setFailure(record, 'prompt_delivery_failed', errorMessage(error), 'Inspect the terminal before deciding whether to continue manually; the bridge will not retry this prompt.')
      await notifyFailure(record, record.failure).catch(() => {})
      return
    }
    if (stopRequested(record)) return
    record.prompt.status = 'delivered'
    record.prompt.deliveredAt = now()
    record.status = 'active'
    touch(record)
  }

  function newRecord(request, status) {
    const createdAt = now()
    return {
      version: 1,
      externalKey: request.externalKey,
      cwd: request.cwd,
      provider: request.provider,
      flags: request.flags,
      collaborators: request.collaborators.map(userId => ({ userId, status: 'pending', displayName: null, invitation: null, error: null })),
      initialPrompt: request.initialPrompt,
      prompt: { status: 'pending', claimedAt: null, deliveredAt: null, acknowledgedAt: null },
      tmux: automationTmux(request.externalKey),
      sessionId: null,
      channelId: null,
      status,
      failure: null,
      stop: { requestedAt: null, archiveRequested: false, terminated: false, channelArchived: false },
      createdAt,
      updatedAt: createdAt,
    }
  }

  function create(input) {
    const externalKey = validateExternalKey(input?.externalKey)
    const existing = recordFor(externalKey)
    if (existing) return { automation: existing, created: false }
    const request = validateAutomationRequest(input, { home })
    if (request.channelName || request.team) {
      throw new AutomationRequestError('channel_preparation_required', 'named and team-bound automations are created through submit()', 500)
    }
    const record = newRecord(request, 'pending')
    if (!state.automations) state.automations = {}
    state.automations[externalKey] = record
    persist() // uniqueness and tmux correlation exist before launch is queued
    runOnce(externalKey, 'launch', () => launchPending(externalKey))
    return { automation: record, created: true }
  }

  function replay(record, input) {
    let request = null
    try { request = validateAutomationRequest(input, { home }) } catch {}
    const conflict = record.requestHash
      ? !request || requestFingerprint(request) !== record.requestHash
      // A plain automation already owns this key: a named or team-bound
      // request must not silently return it without its channel or team.
      : Boolean(request && (request.channelName || request.team))
    if (conflict) {
      throw new AutomationRequestError('external_key_conflict', 'That externalKey was already used for a different automation request.', 409)
    }
    return { automation: record, created: false }
  }

  // The HTTP entry point. Plain requests keep the historical synchronous
  // journal-then-launch path. A named or team-bound request first creates its
  // Slack channel, so a name collision fails before anything is launched, and
  // a team worker joins its team in the same journal write that binds the
  // channel to this automation.
  async function submit(input, { caller = null } = {}) {
    const externalKey = validateExternalKey(input?.externalKey)
    const prior = recordFor(externalKey)
    if (prior) return replay(prior, input)
    const request = validateAutomationRequest(input, { home })
    if (!request.channelName && !request.team) return create(input)
    if (!prepareChannel || (request.team && !teamBootstrap)) {
      throw new AutomationRequestError('channel_preparation_unavailable', 'named and team-bound automations are unavailable in this bridge', 503)
    }
    const authorization = request.team ? await teamBootstrap.authorize(request, caller) : null
    // Authorization awaits process proofs; a concurrent request may have won.
    const raced = recordFor(externalKey)
    if (raced) return replay(raced, input)
    const record = newRecord(request, 'preparing_channel')
    record.requestHash = requestFingerprint(request)
    record.channelName = request.channelName
    record.channelSetup = { status: 'creating', requestedAt: now() }
    if (request.team) {
      // Re-asserts and consumes the coordinator's dispatch authority and
      // reserves the worker slot, synchronously with this journal write.
      record.team = teamBootstrap.reserve(record, request, authorization)
      if (request.team.task) record.prompt.status = 'team_task'
    }
    if (!state.automations) state.automations = {}
    state.automations[externalKey] = record
    const preparation = prepareRecord(record, request)
    preparing.set(externalKey, preparation)
    try { return await preparation }
    finally { if (preparing.get(externalKey) === preparation) preparing.delete(externalKey) }
  }

  async function prepareRecord(record, request) {
    const externalKey = record.externalKey
    persist() // the journal precedes the Slack side effect

    let channel
    try {
      channel = await prepareChannel(record, {
        journalName: name => {
          record.channelSetup = { ...record.channelSetup, name }
          persist()
        },
      })
    }
    catch (error) {
      if (record.team) teamBootstrap.release(record)
      if (error?.definitive) {
        // Slack rejected the channel outright: nothing exists and nothing was
        // launched, so the external key stays available for a corrected retry.
        if (state.automations?.[externalKey] === record) delete state.automations[externalKey]
        persist()
        throw new AutomationRequestError(error.code || 'channel_create_failed', errorMessage(error), error.status || 409)
      }
      record.channelSetup = { ...record.channelSetup, status: 'uncertain', error: errorMessage(error) }
      const attempted = record.channelSetup.name || record.channelName
      setFailure(record, 'channel_creation_uncertain',
        `Slack did not confirm whether it created the channel${attempted ? ` #${attempted}` : ''}: ${errorMessage(error)}`,
        'If that channel exists, archive it; then retry with a new externalKey.')
      throw new AutomationRequestError('channel_creation_uncertain', record.failure.message, 502)
    }
    record.channelId = channel.channelId
    record.channelName = channel.channelName || record.channelName
    record.channelSetup = { ...record.channelSetup, status: 'created', createdAt: now() }
    if (record.team) {
      try {
        Object.assign(record.team, teamBootstrap.bind(record, request))
      } catch (error) {
        teamBootstrap.release(record)
        setFailure(record, 'team_join_failed', errorMessage(error),
          'Stop this automation with --archive to remove its channel, then retry with a new externalKey.')
        await notifyFailure(record, record.failure).catch(() => {})
        throw new AutomationRequestError(error?.code || 'team_join_failed', errorMessage(error), error?.status || 409)
      }
    }
    record.status = 'pending'
    touch(record) // channel, membership and bootstrap task become durable together
    runOnce(externalKey, 'launch', () => launchPending(externalKey))
    if (record.team) {
      Promise.resolve()
        .then(() => teamBootstrap.joined?.(record))
        .catch(error => log('automation team join notice failed', externalKey, errorMessage(error)))
    }
    return { automation: record, created: true }
  }

  function correlateSessionStart(session) {
    if (!session?.id || !session?.tmux || !session?.channel) return false
    const provider = providerOf(session)
    const record = Object.values(records()).find(item =>
      item.tmux === session.tmux && item.provider === provider && !stopRequested(item) && !['stopping', 'stopped', 'released'].includes(item.status))
    if (!record) return false
    // A session's cwd follows its agent's working folder, so only the first
    // correlation proves the launch directory. A record already bound to this
    // exact session is being re-observed, for example at daemon recovery.
    const rebound = Boolean(record.sessionId) && record.sessionId === session.id
    if (!rebound && path.resolve(session.cwd || record.cwd) !== record.cwd) {
      setFailure(record, 'session_cwd_mismatch', 'The tmux session registered from a different working directory.', 'Stop the automation and investigate the launcher before retrying.')
      return false
    }
    // A prepared channel is part of the automation's identity: its team
    // membership and bootstrap task already name it.
    if (record.channelId && session.channel !== record.channelId) {
      setFailure(record, 'session_channel_mismatch', 'The automation session bound a different Slack channel than the one created for it.', 'Stop the automation and investigate before retrying.')
      return false
    }
    record.sessionId = session.id
    record.channelId = session.channel
    record.sessionStartedAt ||= now()
    sessionRefs.set(session.id, session)
    if (record.status === 'active' || record.status === 'failed') {
      // Earlier releases failed a set-up automation exactly this way once its
      // agent changed folder. Restore that case, and only that case.
      if (rebound && record.status === 'failed' && record.failure?.code === 'session_cwd_mismatch' &&
          ['delivered', 'team_task'].includes(record.prompt?.status) && !record.initialPrompt &&
          (record.collaborators || []).every(item => item.status === 'ready')) {
        record.status = 'active'
        record.failure = null
      }
      touch(record)
      return true
    }
    record.status = 'configuring_collaborators'
    record.failure = null
    touch(record)
    runOnce(record.externalKey, 'configure', () => configure(record.externalKey))
    return true
  }

  function consumeInitialPromptEcho(sessionId, prompt) {
    const record = Object.values(records()).find(item => item.sessionId === sessionId)
    if (!record || record.prompt.acknowledgedAt || !['claimed', 'delivered'].includes(record.prompt.status)) return false
    if (!record.prompt.sha256 || promptDigest(prompt) !== record.prompt.sha256) return false
    record.prompt.acknowledgedAt = now()
    touch(record)
    return true
  }

  function recover() {
    for (const record of Object.values(records())) {
      if (record.status === 'released') continue
      if (record.status === 'preparing_channel' && !preparing.has(record.externalKey)) {
        // The bridge stopped while Slack was creating the channel. Its outcome
        // is unknown and Slack offers no idempotent create, so fail closed.
        if (record.team) teamBootstrap?.release?.(record)
        record.channelSetup = { ...(record.channelSetup || {}), status: 'interrupted' }
        const attempted = record.channelSetup.name || record.channelName
        setFailure(record, 'channel_creation_interrupted',
          `The bridge restarted while creating the Slack channel${attempted ? ` #${attempted}` : ''}; its outcome is unknown.`,
          'If that channel exists, archive it; then create the automation with a new externalKey.')
        continue
      }
      if (record.prompt?.status === 'claimed' && record.status === 'injecting_prompt') {
        runOnce(record.externalKey, 'recover-prompt', async () => {
          if (record.prompt.status !== 'claimed' || record.status !== 'injecting_prompt') return
          record.prompt.status = 'failed'
          setFailure(record, 'prompt_delivery_interrupted', 'The daemon restarted after claiming the initial prompt; it was not retried because delivery may already have occurred.', 'Inspect the terminal and continue manually, or stop this automation before creating a replacement.')
          await notifyFailure(record, record.failure).catch(() => {})
        })
        continue
      }
      const correlated = Object.values(state.sessions || {}).find(session =>
        session.tmux === record.tmux && providerOf(session) === record.provider && session.channel)
      if (correlated && !['stopping', 'stopped'].includes(record.status) && !record.stop?.terminated) {
        correlateSessionStart(correlated)
        continue
      }
      if (record.status === 'pending') runOnce(record.externalKey, 'launch', () => launchPending(record.externalKey))
      else if (['configuring_collaborators', 'ready_to_prompt'].includes(record.status) && record.sessionId && record.channelId) {
        runOnce(record.externalKey, 'configure', () => configure(record.externalKey))
      } else if (record.status === 'stopping' || (record.status === 'stopped' && record.stop?.archiveRequested && !record.stop?.channelArchived)) {
        runOnce(record.externalKey, 'stop', () => stop(record.externalKey, { archive: record.stop?.archiveRequested }))
      }
    }
  }

  async function reconcile() {
    for (const record of Object.values(records())) {
      if (!['launching', 'awaiting_session'].includes(record.status) || record.sessionId || !record.launchRequestedAt) continue
      const correlated = Object.values(state.sessions || {}).find(session =>
        session.tmux === record.tmux && providerOf(session) === record.provider && session.channel)
      if (correlated) {
        correlateSessionStart(correlated)
        continue
      }
      if (now() - record.launchRequestedAt < launchTimeoutMs) continue
      let alive = false
      try { alive = await isTmuxAlive(record.tmux) } catch {}
      if (record.sessionId || !['launching', 'awaiting_session'].includes(record.status)) continue
      const lateCorrelation = Object.values(state.sessions || {}).find(session =>
        session.tmux === record.tmux && providerOf(session) === record.provider && session.channel)
      if (lateCorrelation) {
        correlateSessionStart(lateCorrelation)
        continue
      }
      const code = alive ? 'session_start_timeout' : 'launch_interrupted'
      const message = alive
        ? 'The automation tmux exists but its provider did not register SessionStart before the launch deadline.'
        : 'The daemon restarted or the terminal exited after launch was claimed, and the automation tmux does not exist.'
      setFailure(record, code, message, 'Inspect the tmux/provider startup failure, stop this automation, and retry with a new externalKey.')
      await notifyFailure(record, record.failure).catch(() => {})
    }
  }

  async function stop(externalKey, { archive: shouldArchive = false } = {}) {
    validateExternalKey(externalKey)
    // Let an in-flight channel preparation settle first: it either binds the
    // channel (which this stop then archives) or removes the request.
    await preparing.get(externalKey)?.catch(() => {})
    const record = recordFor(externalKey)
    if (!record) return null
    if (record.status === 'released') throw new AutomationRequestError('automation_ownership_released', 'Automation ownership was released; stop cannot touch the retained session.', 409)
    record.stop ||= { requestedAt: null, archiveRequested: false, terminated: false, channelArchived: false }
    if (shouldArchive) record.stop.archiveRequested = true
    if (record.status === 'stopped' && record.stop.terminated && (!record.stop.archiveRequested || record.stop.channelArchived)) {
      return publicStatus(record)
    }
    record.status = 'stopping'
    record.stop.requestedAt ||= now()
    touch(record)
    try {
      // A standard Ghostty launch may return before the tmux session appears.
      // Let that exact, journaled launch settle before attempting termination,
      // otherwise a stopped automation could materialize after the kill check.
      await (running.get(`${externalKey}:launch`) || Promise.resolve())
      if (!record.stop.terminated) {
        await terminate(record)
        record.stop.terminated = true
        touch(record)
      }
      if (record.stop.archiveRequested && record.channelId && !record.stop.channelArchived) {
        await archive(record.channelId, record)
        record.stop.channelArchived = true
        touch(record)
      }
      if (record.stop.archiveRequested && !record.channelId) record.stop.channelArchived = true
      // A channel whose creation is unconfirmed may exist without SAB knowing
      // its ID. Stop cannot archive it, so it keeps the name and the failure.
      const unresolved = ['uncertain', 'interrupted'].includes(record.channelSetup?.status) && !record.channelId
      if (unresolved) record.stop.unresolvedChannel = record.channelSetup.name || record.channelName || null
      record.status = 'stopped'
      record.stoppedAt = now()
      if (!unresolved) record.failure = null
      touch(record)
    } catch (error) {
      setFailure(record, 'stop_failed', errorMessage(error), 'Resolve the reported process or Slack archive error, then repeat the same stop request.')
      await notifyFailure(record, record.failure).catch(() => {})
    }
    return publicStatus(record)
  }

  function status(externalKey) {
    validateExternalKey(externalKey)
    return publicStatus(recordFor(externalKey))
  }

  async function release(externalKey, input) {
    validateExternalKey(externalKey)
    const expected = validateAutomationRelease(input), record = recordFor(externalKey)
    if (!record) return null
    const receipt = () => {
      if (record.status !== 'released') return null
      if (Object.entries(expected).some(([key, value]) => record.release?.[key] !== value)) {
        throw new AutomationRequestError('release_request_conflict', 'Automation ownership release request conflict.', 409)
      }
      touch(record) // a retry also makes an earlier failed atomic write durable
      return publicStatus(record)
    }
    const prior = receipt()
    if (prior) return prior
    const correlate = () => {
      const session = state.sessions?.[expected.sessionId]
      if (record.status !== 'active' || record.stop?.requestedAt || !['delivered', 'team_task'].includes(record.prompt?.status) || record.initialPrompt ||
          !record.collaborators.every(item => item.status === 'ready') ||
          running.has(`${externalKey}:launch`) || running.has(`${externalKey}:configure`)) {
        throw new AutomationRequestError('automation_setup_incomplete', 'Release requires completed automation setup with no pending launch or stop.', 409)
      }
      if (!session || record.sessionId !== expected.sessionId || record.channelId !== expected.channelId ||
          session.channel !== expected.channelId || state.channels?.[expected.channelId] !== session.id || session.tmux !== expected.tmux ||
          session.cwd !== record.cwd || providerOf(session) !== record.provider ||
          channelNodeId(state, session.channel) !== LOCAL_NODE_ID || nodeIdForSession(session) !== LOCAL_NODE_ID ||
          Object.values(state.sessions || {}).some(other => other.id !== session.id && other.tmux === record.tmux)) {
        throw new AutomationRequestError('automation_release_correlation', 'Release requires the exact local automation session/channel correlation.', 409)
      }
      return session
    }
    const session = correlate(), processClaim = { pid: session.pid, tmux: session.tmux }
    if (record.tmux !== session.tmux && await isTmuxAlive(record.tmux)) {
      throw new AutomationRequestError('automation_release_tmux_alive', 'The original automation tmux is still alive; inspect correlation before release.', 409)
    }
    if (!await validateReleaseSession(session)) throw new AutomationRequestError('automation_release_process', 'The exact provider process could not be proved; no ownership was changed.', 409)
    if (record.tmux !== session.tmux && await isTmuxAlive(record.tmux)) {
      throw new AutomationRequestError('automation_release_tmux_alive', 'The original automation tmux reappeared; ownership was not released.', 409)
    }
    const racedReceipt = receipt()
    if (racedReceipt) return racedReceipt
    if (correlate() !== session || session.pid !== processClaim.pid || session.tmux !== processClaim.tmux) {
      throw new AutomationRequestError('automation_release_correlation', 'Session correlation changed during release proof.', 409)
    }
    record.release = { ...expected, releasedAt: now() }
    record.status = 'released'
    touch(record) // journal before the notice; no session, whitelist or channel mutation
    try { await notifyReleased(record) } catch { /* durable result remains queryable */ }
    return publicStatus(record)
  }

  function findForHook(provider, sessionId, tmux) {
    return Object.values(records()).find(record =>
      record.status !== 'released' && record.provider === provider && ((sessionId && record.sessionId === sessionId) || (tmux && record.tmux === tmux))) || null
  }

  function codexBootstrapDisposition(bootstrap, tmux) {
    const record = Object.values(records()).find(item => item.provider === 'codex' && item.tmux === tmux)
    if (!record || stopRequested(record) || ['stopping', 'stopped', 'released'].includes(record.status)) return { disposition: 'ignore', record }
    if (!bootstrap?.threadId || !bootstrap?.cwd || path.resolve(bootstrap.cwd) !== record.cwd) {
      return { disposition: 'forbidden', record }
    }
    if (record.sessionId) {
      return { disposition: record.sessionId === bootstrap.threadId ? 'duplicate' : 'forbidden', record }
    }
    if (!['launching', 'awaiting_session'].includes(record.status)) return { disposition: 'ignore', record }
    return { disposition: 'accept', record }
  }

  async function acceptCodexBootstrap(bootstrap, tmux, accept) {
    if (typeof accept !== 'function') throw new TypeError('Codex bootstrap requires an accept callback')
    // Serialize the bootstrap decision by terminal, not by the proposed thread
    // ID. A provider process should emit one root thread, but two conflicting
    // identities arriving together must not both observe the automation as
    // uncorrelated and race through SessionStart adoption.
    const key = tmux
    if (bootstrapRunning.has(key)) {
      await bootstrapRunning.get(key)
      return codexBootstrapDisposition(bootstrap, tmux).disposition
    }
    const initial = codexBootstrapDisposition(bootstrap, tmux)
    if (initial.disposition !== 'accept') return initial.disposition
    const pending = (async () => {
      await accept(initial.record)
    })()
    bootstrapRunning.set(key, pending)
    try {
      await pending
      const final = codexBootstrapDisposition(bootstrap, tmux).disposition
      if (final === 'duplicate') return 'accepted'
      // Hook handlers are intentionally failure-tolerant and may reject by
      // returning early. Until durable automation correlation exists, ask the
      // proxy to retry instead of acknowledging and losing the only identity
      // event.
      return final === 'accept' ? 'not_ready' : final
    } finally {
      if (bootstrapRunning.get(key) === pending) bootstrapRunning.delete(key)
    }
  }

  return {
    create, submit, status, stop, release, recover, reconcile, correlateSessionStart,
    consumeInitialPromptEcho, findForHook, acceptCodexBootstrap,
  }
}
