import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  isPathWithin,
  normalizeProvider,
  normalizeRemoteLaunchFlags,
  providerOf,
} from './providers.mjs'

const MAX_EXTERNAL_KEY = 512
const MAX_INITIAL_PROMPT_BYTES = 256 * 1024
const SLACK_USER_ID = /^[UW][A-Z0-9]{8,}$/
const TERMINAL_STATUSES = new Set(['stopped'])

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
  if (['__proto__', 'prototype', 'constructor'].includes(value)) requestError('invalid_external_key', 'externalKey is reserved')
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
  return { externalKey, cwd, provider, flags, collaborators, initialPrompt: input.initialPrompt }
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
  launchTimeoutMs = 5 * 60 * 1000,
  notifyFailure = async () => {},
  now = () => Date.now(),
  log = () => {},
}) {
  if (!state || typeof state !== 'object') throw new TypeError('automation lifecycle requires state')
  for (const [name, fn] of Object.entries({ persist, launch, invite, inject, terminate, archive })) {
    if (typeof fn !== 'function') throw new TypeError(`automation lifecycle requires ${name}()`)
  }
  const running = new Map()
  const sessionRefs = new Map()

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

  function create(input) {
    const externalKey = validateExternalKey(input?.externalKey)
    const existing = recordFor(externalKey)
    if (existing) return { automation: existing, created: false }
    const request = validateAutomationRequest(input, { home })
    const createdAt = now()
    const record = {
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
      status: 'pending',
      failure: null,
      stop: { requestedAt: null, archiveRequested: false, terminated: false, channelArchived: false },
      createdAt,
      updatedAt: createdAt,
    }
    if (!state.automations) state.automations = {}
    state.automations[externalKey] = record
    persist() // uniqueness and tmux correlation exist before launch is queued
    runOnce(externalKey, 'launch', () => launchPending(externalKey))
    return { automation: record, created: true }
  }

  function correlateSessionStart(session) {
    if (!session?.id || !session?.tmux || !session?.channel) return false
    const provider = providerOf(session)
    const record = Object.values(records()).find(item =>
      item.tmux === session.tmux && item.provider === provider && !stopRequested(item) && !['stopping', 'stopped'].includes(item.status))
    if (!record) return false
    if (path.resolve(session.cwd || record.cwd) !== record.cwd) {
      setFailure(record, 'session_cwd_mismatch', 'The tmux session registered from a different working directory.', 'Stop the automation and investigate the launcher before retrying.')
      return false
    }
    record.sessionId = session.id
    record.channelId = session.channel
    record.sessionStartedAt ||= now()
    sessionRefs.set(session.id, session)
    if (record.status === 'active' || record.status === 'failed') {
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
    const record = recordFor(externalKey)
    if (!record) return null
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
      record.status = 'stopped'
      record.stoppedAt = now()
      record.failure = null
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

  function findForHook(provider, sessionId, tmux) {
    return Object.values(records()).find(record =>
      record.provider === provider && ((sessionId && record.sessionId === sessionId) || (tmux && record.tmux === tmux))) || null
  }

  return { create, status, stop, recover, reconcile, correlateSessionStart, consumeInitialPromptEcho, findForHook }
}
