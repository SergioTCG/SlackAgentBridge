import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  AutomationRequestError,
  createAutomationLifecycle,
  shouldFenceAutomationHook,
  validateAutomationRequest,
  waitForProviderInput,
} from '../daemon/automation.mjs'

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-automation-'))
  const requestedCwd = path.join(root, 'worktree')
  fs.mkdirSync(requestedCwd)
  const cwd = fs.realpathSync(requestedCwd)
  const state = overrides.state || {
    control: null,
    sessions: { unrelated: { id: 'unrelated', cwd: root, channel: 'COTHER', provider: 'codex' } },
    channels: { COTHER: 'unrelated' },
    whitelist: { COTHER: { UOTHER000: 'Other' } },
  }
  const queue = []
  const calls = { launch: [], invite: [], ready: [], inject: [], terminate: [], archive: [], notify: [], persist: [] }
  const lifecycle = createAutomationLifecycle({
    state,
    home: root,
    persist: () => calls.persist.push(structuredClone(state)),
    schedule: fn => queue.push(fn),
    launch: async automation => { calls.launch.push(automation.externalKey) },
    invite: async (channel, userId) => {
      calls.invite.push([channel, userId])
      return { name: userId === 'U098WAUUX5M' ? 'Rade' : userId, invitation: 'invited' }
    },
    waitForInputReady: async session => { calls.ready.push(session.id) },
    inject: async (session, prompt) => { calls.inject.push([session.id, prompt]) },
    terminate: async automation => { calls.terminate.push(automation.externalKey) },
    archive: async (channel, automation) => { calls.archive.push([channel, automation.externalKey]) },
    notifyFailure: async (automation, failure) => { calls.notify.push([automation.externalKey, failure.code]) },
    now: (() => { let value = 1_000; return () => ++value })(),
    ...overrides.dependencies,
  })
  const request = {
    externalKey: 'github:twenty-five-seven-doo/barrique#123',
    cwd,
    provider: 'claude',
    flags: ['--model', 'opus', '--effort', 'max', '--dsp', '--chrome'],
    collaborators: ['U098WAUUX5M'],
    initialPrompt: 'Implement issue 123 exactly once.',
  }
  async function drain() {
    while (queue.length) await queue.shift()()
  }
  return { root, cwd, state, queue, calls, lifecycle, request, drain }
}

test('duplicate external keys return one durable launch', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))

  const first = f.lifecycle.create(f.request)
  const second = f.lifecycle.create({ ...f.request, initialPrompt: 'different payload must not replace the first' })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.automation.tmux, second.automation.tmux)
  assert.equal(second.automation.initialPrompt, f.request.initialPrompt)
  assert.equal(f.queue.length, 1)

  await f.drain()
  assert.deepEqual(f.calls.launch, [f.request.externalKey])
  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'awaiting_session')
})

test('a daemon restart never repeats a launch already journaled as launching', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.lifecycle.create(f.request)
  f.state.automations[f.request.externalKey].status = 'launching'

  const restartLaunches = []
  const restarted = createAutomationLifecycle({
    state: f.state,
    home: f.root,
    persist: () => {},
    schedule: fn => f.queue.push(fn),
    launch: async automation => restartLaunches.push(automation.externalKey),
    invite: async (_channel, userId) => ({ name: userId, invitation: 'invited' }),
    inject: async () => {}, terminate: async () => {}, archive: async () => {}, notifyFailure: async () => {},
  })
  restarted.recover()
  await f.drain()
  assert.deepEqual(restartLaunches, [])
  assert.equal(restarted.status(f.request.externalKey).status, 'launching')
})

test('restart correlates a SessionStart persisted before automation setup without relaunching', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  f.state.automations[f.request.externalKey].status = 'awaiting_session'
  f.state.sessions['session-123'] = {
    id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd,
  }
  f.state.channels.CAUTO = 'session-123'
  f.queue.length = 0
  const restartCalls = { launch: 0, invite: 0, inject: 0 }
  const restarted = createAutomationLifecycle({
    state: f.state, home: f.root, persist: () => {}, schedule: fn => f.queue.push(fn),
    launch: async () => { restartCalls.launch++ },
    invite: async (_channel, userId) => { restartCalls.invite++; return { name: userId, invitation: 'invited' } },
    inject: async () => { restartCalls.inject++ }, terminate: async () => {}, archive: async () => {}, notifyFailure: async () => {},
  })
  restarted.recover()
  await f.drain()
  assert.deepEqual(restartCalls, { launch: 0, invite: 1, inject: 1 })
  assert.equal(restarted.status(f.request.externalKey).status, 'active')
})

test('a stale claimed launch becomes an actionable failure without a retry', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.lifecycle.create(f.request)
  const automation = f.state.automations[f.request.externalKey]
  automation.status = 'launching'
  automation.launchRequestedAt = 1
  const restarted = createAutomationLifecycle({
    state: f.state, home: f.root, persist: () => {}, schedule: () => {},
    launch: async () => assert.fail('must not relaunch'), invite: async () => {}, inject: async () => {},
    terminate: async () => {}, archive: async () => {}, isTmuxAlive: async () => false,
    launchTimeoutMs: 10, now: () => 100,
  })
  await restarted.reconcile()
  assert.equal(restarted.status(f.request.externalKey).status, 'failed')
  assert.equal(restarted.status(f.request.externalKey).failure.code, 'launch_interrupted')
})

test('SessionStart correlation completes invitations and injects the initial prompt once', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  await f.drain()

  const session = { id: 'session-123', tmux: automation.tmux, cwd: f.cwd, channel: 'CAUTO', provider: 'claude' }
  assert.equal(f.lifecycle.correlateSessionStart(session), true)
  assert.equal(f.lifecycle.status(f.request.externalKey).sessionId, 'session-123')
  assert.equal(f.lifecycle.status(f.request.externalKey).channelId, 'CAUTO')
  await f.drain()

  assert.deepEqual(f.calls.invite, [['CAUTO', 'U098WAUUX5M']])
  assert.deepEqual(f.state.whitelist.CAUTO, { U098WAUUX5M: 'Rade' })
  assert.deepEqual(f.calls.inject, [['session-123', f.request.initialPrompt]])
  assert.deepEqual(f.calls.ready, ['session-123'])
  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'active')
  assert.equal(f.lifecycle.status(f.request.externalKey).prompt.status, 'delivered')

  const restartQueue = []
  const restarted = createAutomationLifecycle({
    state: f.state, home: f.root, persist: () => {}, schedule: fn => restartQueue.push(fn),
    launch: async () => assert.fail('must not launch'), invite: async () => assert.fail('must not invite'),
    inject: async () => assert.fail('must not inject twice'), terminate: async () => {}, archive: async () => {},
    notifyFailure: async () => {},
  })
  restarted.recover()
  while (restartQueue.length) await restartQueue.shift()()
  assert.equal(restarted.consumeInitialPromptEcho('session-123', f.request.initialPrompt), true)
  assert.equal(restarted.consumeInitialPromptEcho('session-123', f.request.initialPrompt), false)
})

test('an interrupted prompt claim fails closed instead of reinjecting after restart', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.lifecycle.create(f.request)
  const automation = f.state.automations[f.request.externalKey]
  automation.status = 'injecting_prompt'
  automation.sessionId = 'session-123'
  automation.channelId = 'CAUTO'
  automation.prompt.status = 'claimed'

  f.lifecycle.recover()
  await f.drain()
  assert.deepEqual(f.calls.inject, [])
  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'failed')
  assert.equal(f.lifecycle.status(f.request.externalKey).failure.code, 'prompt_delivery_interrupted')
})

test('collaborator invitation failure never whitelists that user or submits the prompt', async t => {
  const f = fixture({
    dependencies: {
      invite: async (_channel, userId) => {
        f.calls.invite.push(['CAUTO', userId])
        if (userId === 'UFAIL0001') throw Object.assign(new Error('missing_scope'), { code: 'missing_scope' })
        return { name: 'Rade', invitation: 'invited' }
      },
    },
  })
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.request.collaborators.push('UFAIL0001')
  const { automation } = f.lifecycle.create(f.request)
  await f.drain()
  f.lifecycle.correlateSessionStart({ id: 'session-123', tmux: automation.tmux, cwd: f.cwd, channel: 'CAUTO' })
  await f.drain()

  assert.deepEqual(f.state.whitelist.CAUTO, { U098WAUUX5M: 'Rade' })
  assert.equal(f.state.whitelist.CAUTO.UFAIL0001, undefined)
  assert.deepEqual(f.calls.inject, [])
  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'failed')
  assert.equal(f.lifecycle.status(f.request.externalKey).collaborators[1].status, 'failed')
  assert.deepEqual(f.calls.notify, [[f.request.externalKey, 'collaborator_invitation_failed']])
})

test('provider-specific flags and request fields use the remote launch allowlist', t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const claude = validateAutomationRequest(f.request, { home: f.root })
  assert.deepEqual(claude.flags, [
    '--model', 'opus', '--effort', 'max', '--dangerously-skip-permissions', '--chrome',
  ])
  assert.throws(() => validateAutomationRequest({ ...f.request, provider: 'codex', flags: ['--dsp'] }, { home: f.root }), AutomationRequestError)
  assert.deepEqual(
    validateAutomationRequest({ ...f.request, provider: 'codex', flags: ['--yolo', '--model=gpt-5.6-sol'] }, { home: f.root }).flags,
    ['--dangerously-bypass-approvals-and-sandbox', '--model=gpt-5.6-sol'],
  )
  assert.throws(() => validateAutomationRequest({ ...f.request, collaborators: ['not-a-slack-id'] }, { home: f.root }), /collaborator/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, flags: ['--continue'] }, { home: f.root }), /independently owned/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, flags: ['--continue=true'] }, { home: f.root }), /independently owned/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, flags: ['--continue=false'] }, { home: f.root }), /independently owned/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, flags: ['--effort', 'xhigh'] }, { home: f.root }), /effort/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, flags: ['--effort=xhigh'] }, { home: f.root }), /effort/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, provider: undefined }, { home: f.root }), /provider/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, cwd: path.join(f.root, '..', 'escape') }, { home: f.root }), /cwd/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, externalKey: '.' }, { home: f.root }), /reserved/i)
  assert.throws(() => validateAutomationRequest({ ...f.request, externalKey: '..' }, { home: f.root }), /reserved/i)
})

test('stopped automation hooks are fenced only for their exact tmux identity', () => {
  const record = {
    tmux: 'sab-auto-original', status: 'failed',
    stop: { requestedAt: 123, terminated: false },
  }
  assert.equal(shouldFenceAutomationHook(record, 'sab-auto-original'), true)
  assert.equal(shouldFenceAutomationHook(record, 'ccs-resumed'), false)
  assert.equal(shouldFenceAutomationHook(record, null), false)
})

test('status is useful before and after SessionStart', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  const pending = f.lifecycle.status(f.request.externalKey)
  assert.equal(pending.sessionId, null)
  assert.equal(pending.channelId, null)
  assert.equal(pending.tmux, automation.tmux)
  assert.equal(pending.cwd, f.cwd)

  f.lifecycle.correlateSessionStart({ id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd })
  const started = f.lifecycle.status(f.request.externalKey)
  assert.equal(started.sessionId, 'session-123')
  assert.equal(started.channelId, 'CAUTO')
  assert.equal(started.collaborators[0].status, 'pending')
})

test('stop and archive are exact and idempotent without touching unrelated state', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const unrelatedBefore = structuredClone({
    session: f.state.sessions.unrelated,
    channel: f.state.channels.COTHER,
    whitelist: f.state.whitelist.COTHER,
  })
  const { automation } = f.lifecycle.create(f.request)
  await f.drain()
  f.lifecycle.correlateSessionStart({ id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd })
  await f.drain()

  await f.lifecycle.stop(f.request.externalKey, { archive: true })
  await f.lifecycle.stop(f.request.externalKey, { archive: true })
  assert.deepEqual(f.calls.terminate, [f.request.externalKey])
  assert.deepEqual(f.calls.archive, [['CAUTO', f.request.externalKey]])
  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'stopped')
  assert.deepEqual({
    session: f.state.sessions.unrelated,
    channel: f.state.channels.COTHER,
    whitelist: f.state.whitelist.COTHER,
  }, unrelatedBefore)
})

test('stop waits for an in-flight launch before terminating its exact tmux', async t => {
  let acceptLaunch
  const launchGate = new Promise(resolve => { acceptLaunch = resolve })
  const f = fixture({
    dependencies: {
      launch: async automation => {
        f.calls.launch.push(automation.externalKey)
        await launchGate
      },
    },
  })
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  f.lifecycle.create(f.request)
  const launchTask = f.queue.shift()()
  await new Promise(resolve => setImmediate(resolve))

  const stopping = f.lifecycle.stop(f.request.externalKey)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.terminate, [], 'termination must not race ahead of launch completion')

  acceptLaunch()
  await launchTask
  const stopped = await stopping
  assert.deepEqual(f.calls.terminate, [f.request.externalKey])
  assert.equal(stopped.status, 'stopped')
})

test('reconcile correlates a persisted SessionStart before applying launch timeout', async t => {
  const f = fixture()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  f.queue.length = 0
  const record = f.state.automations[f.request.externalKey]
  record.status = 'awaiting_session'
  record.launchRequestedAt = 1
  f.state.sessions['session-123'] = {
    id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd,
  }

  await f.lifecycle.reconcile()
  await f.drain()
  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'active')
  assert.equal(f.lifecycle.status(f.request.externalKey).failure, null)
})

test('reconcile cannot overwrite correlation that completes during its liveness check', async t => {
  let finishLiveness
  const liveness = new Promise(resolve => { finishLiveness = resolve })
  const f = fixture({ dependencies: { isTmuxAlive: () => liveness, launchTimeoutMs: 1, now: () => 100 } })
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  f.queue.length = 0
  const record = f.state.automations[f.request.externalKey]
  record.status = 'awaiting_session'
  record.launchRequestedAt = 1

  const reconciling = f.lifecycle.reconcile()
  const session = { id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd }
  f.state.sessions[session.id] = session
  f.lifecycle.correlateSessionStart(session)
  finishLiveness(true)
  await reconciling
  await f.drain()

  assert.equal(f.lifecycle.status(f.request.externalKey).status, 'active')
  assert.equal(f.lifecycle.status(f.request.externalKey).failure, null)
})

test('input readiness is established before the one-way prompt claim', async t => {
  const order = []
  const f = fixture({
    dependencies: {
      waitForInputReady: async () => { order.push('ready') },
      inject: async () => { order.push('inject') },
    },
  })
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  await f.drain()
  f.lifecycle.correlateSessionStart({ id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd })
  await f.drain()

  assert.deepEqual(order, ['ready', 'inject'])
  assert.equal(f.lifecycle.status(f.request.externalKey).prompt.status, 'delivered')
})

test('input readiness failure leaves the prompt unclaimed and reports an actionable failure', async t => {
  const f = fixture({
    dependencies: {
      waitForInputReady: async () => { throw new Error('Pi stream unavailable') },
      inject: async () => assert.fail('must not inject without a ready input transport'),
    },
  })
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  await f.drain()
  f.lifecycle.correlateSessionStart({ id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd })
  await f.drain()

  const status = f.lifecycle.status(f.request.externalKey)
  assert.equal(status.status, 'failed')
  assert.equal(status.failure.code, 'input_not_ready')
  assert.equal(status.prompt.status, 'pending')
})

test('provider input readiness checks process and tmux before the prompt claim', async () => {
  const base = {
    id: 'session-123', pid: 123, tmux: 'sab-auto-1', provider: 'claude',
  }
  await assert.rejects(() => waitForProviderInput(base, {
    isProcessAlive: () => false, isTmuxAlive: async () => true,
    piStream: () => null, sleep: async () => {},
  }), /process is not alive/)
  await assert.rejects(() => waitForProviderInput(base, {
    isProcessAlive: () => true, isTmuxAlive: async () => false,
    piStream: () => null, sleep: async () => {},
  }), /tmux session is not alive/)
  await assert.doesNotReject(() => waitForProviderInput(base, {
    isProcessAlive: () => true, isTmuxAlive: async () => true,
    piStream: () => null, sleep: async () => {},
  }))
})

test('a failed stop remains authoritative over in-flight configuration', async t => {
  let ready
  const readiness = new Promise(resolve => { ready = resolve })
  const f = fixture({
    dependencies: {
      waitForInputReady: () => readiness,
      inject: async () => assert.fail('a requested stop must fence prompt injection'),
      terminate: async () => { throw new Error('exact termination refused') },
    },
  })
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { automation } = f.lifecycle.create(f.request)
  await f.drain()
  f.lifecycle.correlateSessionStart({ id: 'session-123', tmux: automation.tmux, channel: 'CAUTO', cwd: f.cwd })
  const configuring = f.queue.shift()()
  await new Promise(resolve => setImmediate(resolve))

  const stopped = await f.lifecycle.stop(f.request.externalKey)
  assert.equal(stopped.failure.code, 'stop_failed')
  ready()
  await configuring

  assert.equal(f.lifecycle.status(f.request.externalKey).failure.code, 'stop_failed')
  assert.equal(f.lifecycle.status(f.request.externalKey).prompt.status, 'pending')
})

test('legacy state and manual spawn state remain untouched until automation is used', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-automation-legacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = { control: 'C0', sessions: { old: { id: 'old', cwd: root } }, channels: {} }
  const before = structuredClone(state)
  const lifecycle = createAutomationLifecycle({
    state, home: root, persist: () => assert.fail('construction must not rewrite state'), schedule: () => {},
    launch: async () => {}, invite: async () => {}, inject: async () => {}, terminate: async () => {}, archive: async () => {},
    notifyFailure: async () => {},
  })
  assert.deepEqual(state, before)
  assert.equal(lifecycle.status('missing'), null)
})
