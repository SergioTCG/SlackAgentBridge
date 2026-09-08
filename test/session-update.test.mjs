import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bulkUpdateBlockReason, createSessionReplacementHookTracker, drainSessionInputQueue, planBulkSessionUpdate,
  rebindSessionRuntimeState, recoverSessionInputFence, runBulkSessionUpdate,
  shouldRetryDormantSessionWake,
} from '../daemon/session-update.mjs'
import {
  artifactDeliveryInstruction, artifactGrantTokensFromPrompts, createArtifactGrantStore,
} from '../daemon/artifacts.mjs'

function stateFixture() {
  return {
    channels: {
      CCLAUDE: 'claude-id', CCODEX: 'codex-id', CPI: 'pi-id', STALE: 'wrong-alias', CAUTO: 'automation-id',
    },
    sessions: {
      'claude-id': { id: 'claude-id', pid: 11, tmux: 'sab-claude', cwd: '/work/a', channel: 'CCLAUDE' },
      'codex-id': { id: 'codex-id', provider: 'codex', pid: 22, tmux: 'sab-codex', cwd: '/work/b', channel: 'CCODEX' },
      'pi-id': { id: 'pi-id', provider: 'pi', pid: 33, tmux: 'sab-pi', cwd: '/work/c', channel: 'CPI' },
      'automation-id': { id: 'automation-id', provider: 'codex', pid: 44, tmux: 'sab-auto', cwd: '/work/d', channel: 'CAUTO' },
      standby: { id: 'standby', provider: 'codex', pid: 55, tmux: 'sab-standby', cwd: '/work/e', channel: null },
      'wrong-alias': { id: 'wrong-alias', pid: 66, tmux: 'sab-wrong', cwd: '/work/f', channel: 'OTHER' },
    },
    automations: {
      job: { status: 'active', sessionId: 'automation-id', tmux: 'sab-auto' },
    },
  }
}

test('bulk update plan includes only idle authoritative active sessions', () => {
  const state = stateFixture()
  const plan = planBulkSessionUpdate(state, {
    pidAlive: () => true,
    busySessionIds: new Set(['codex-id']),
  })
  assert.deepEqual(plan.eligible.map(session => session.id), ['claude-id', 'pi-id'])
  assert.deepEqual(plan.skipped.map(item => [item.session.id, item.reason]), [
    ['codex-id', 'turn in progress'],
    ['automation-id', 'automation-owned session'],
  ])
})

test('bulk update blockers cover interactive, transitional, managed, and restart work', () => {
  const base = { id: 'one', channel: 'C1', tmux: 'sab-one' }
  assert.equal(bulkUpdateBlockReason(base, { questionSessionIds: new Set(['one']) }), 'question awaiting an answer')
  assert.equal(bulkUpdateBlockReason(base, { pendingPermissionChannels: new Set(['C1']) }), 'permission awaiting a decision')
  assert.equal(bulkUpdateBlockReason(base, { transitionChannels: new Set(['C1']) }), 'provider switch in progress')
  assert.equal(bulkUpdateBlockReason(base, { internalSessionIds: new Set(['one']) }), 'private maintenance turn in progress')
  assert.equal(bulkUpdateBlockReason({ ...base, teamActiveTaskId: 'task_one' }), 'delegated team task in progress')
  assert.equal(bulkUpdateBlockReason({ ...base, managed: { status: 'paused' } }), 'managed Pi work in progress')
  assert.equal(bulkUpdateBlockReason(base, { restartingSessionIds: new Set(['one']) }), 'session already restarting')
})

test('provider binaries update once and every stopped session resumes even after update failure', async () => {
  const sessions = [
    { id: 'c1' }, { id: 'c2' }, { id: 'x1', provider: 'codex' }, { id: 'p1', provider: 'pi' },
  ]
  const calls = []
  const result = await runBulkSessionUpdate(sessions, {
    revalidateSession: async session => session.id === 'p1' ? 'became busy' : null,
    stopSession: async session => { calls.push(`stop:${session.id}`) },
    updateProvider: async provider => {
      calls.push(`update:${provider}`)
      if (provider === 'codex') throw new Error('offline')
      return { summary: 'latest' }
    },
    resumeSession: async (session, update) => { calls.push(`resume:${session.id}:${update.updateError || 'ok'}`) },
  })

  assert.deepEqual(calls, [
    'stop:c1', 'stop:c2', 'update:claude', 'resume:c1:ok', 'resume:c2:ok',
    'stop:x1', 'update:codex', 'resume:x1:offline',
  ])
  assert.equal(result.providers.length, 2)
  assert.deepEqual(result.results.map(item => [item.session.id, item.status]), [
    ['c1', 'resumed'], ['c2', 'resumed'], ['x1', 'resumed'], ['p1', 'skipped'],
  ])
})

test('a stop failure affects only that exact session', async () => {
  const calls = []
  const result = await runBulkSessionUpdate([{ id: 'one' }, { id: 'two' }], {
    revalidateSession: async () => null,
    stopSession: async session => {
      calls.push(`stop:${session.id}`)
      if (session.id === 'one') throw new Error('cannot stop')
    },
    updateProvider: async provider => { calls.push(`update:${provider}`); return { summary: 'latest' } },
    resumeSession: async session => { calls.push(`resume:${session.id}`) },
  })
  assert.deepEqual(calls, ['stop:one', 'stop:two', 'update:claude', 'resume:two'])
  assert.deepEqual(result.results.map(item => [item.session.id, item.status, item.phase]), [
    ['one', 'failed', 'stop'], ['two', 'resumed', undefined],
  ])
})

test('native session replacement carries maintenance input and fences to the new identity', () => {
  const pending = new Map([
    ['old-session', ['first', 'second']],
    ['new-session', ['already-new']],
  ])
  const updating = new Set(['old-session'])
  const restarting = new Set(['old-session'])
  const waking = new Map([['old-session', 1234]])

  rebindSessionRuntimeState('old-session', 'new-session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
    restartingSessionIds: restarting,
    wakingSessions: waking,
  })

  assert.deepEqual(pending.get('new-session'), ['first', 'second', 'already-new'])
  assert.equal(pending.has('old-session'), false)
  for (const collection of [updating, restarting]) {
    assert.equal(collection.has('old-session'), false)
    assert.equal(collection.has('new-session'), true)
  }
  assert.equal(waking.has('old-session'), false)
  assert.equal(waking.get('new-session'), 1234)
})

test('session-start input drain preserves arrival order and releases maintenance only after delivery', async () => {
  const session = { id: 'old-session' }
  const pending = new Map([['old-session', ['first']]])
  const updating = new Set(['old-session'])
  const restarting = new Set(['old-session'])
  const waking = new Map([['old-session', 1234]])
  const draining = new Set()
  const delivered = []
  let releaseFirst
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve })
  let firstStarted
  const sawFirst = new Promise(resolve => { firstStarted = resolve })

  const drain = drainSessionInputQueue(() => session.id, {
    pendingBySession: pending,
    updatingSessionIds: updating,
    drainingSessionIds: draining,
    deliver: async item => {
      delivered.push(item)
      if (item === 'first') {
        firstStarted()
        await firstBlocked
      }
    },
  })

  await sawFirst
  assert.equal(draining.has('old-session'), true)
  assert.equal(updating.has('old-session'), true)
  rebindSessionRuntimeState('old-session', 'new-session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
    restartingSessionIds: restarting,
    wakingSessions: waking,
  })
  session.id = 'new-session'
  pending.set('new-session', [...(pending.get('new-session') || []), 'second'])
  releaseFirst()
  await drain

  assert.deepEqual(delivered, ['first', 'second'])
  assert.equal(pending.has('old-session'), false)
  assert.equal(pending.has('new-session'), false)
  assert.equal(draining.has('old-session'), false)
  assert.equal(draining.has('new-session'), false)
  assert.equal(updating.has('old-session'), false)
  assert.equal(updating.has('new-session'), false)
})

test('failed session input delivery restores the undelivered item ahead of later arrivals', async () => {
  const pending = new Map([['session', ['first']]])
  const updating = new Set(['session'])
  const draining = new Set()

  await assert.rejects(drainSessionInputQueue('session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
    drainingSessionIds: draining,
    deliver: async () => {
      pending.set('session', [...(pending.get('session') || []), 'second'])
      throw new Error('input unavailable')
    },
  }), /input unavailable/)

  assert.deepEqual(pending.get('session'), ['first', 'second'])
  assert.equal(updating.has('session'), true)
  assert.equal(draining.has('session'), false)
})

test('native replacement preserves grants for the exact in-flight queue remainder', async () => {
  const session = { id: 'old-session' }
  const first = `first${artifactDeliveryInstruction('first-token')}`
  const second = `second${artifactDeliveryInstruction('second-token')}`
  const pending = new Map([['old-session', [first, second]]])
  const updating = new Set(['old-session'])
  const draining = new Set()
  const inFlightPrompts = new WeakMap()
  const grants = createArtifactGrantStore({ token: (() => {
    const values = ['first-token', 'second-token', 'unrelated-token']
    return () => values.shift()
  })() })
  for (let index = 0; index < 3; index++) {
    grants.issue({
      sessionId: 'old-session', channelId: 'C1', provider: 'codex',
      userId: 'U1', workspaceRoot: process.cwd(),
    })
  }
  let rejectDelivery
  let deliveryStarted
  const started = new Promise(resolve => { deliveryStarted = resolve })
  const drain = drainSessionInputQueue(() => session.id, {
    pendingBySession: pending,
    updatingSessionIds: updating,
    drainingSessionIds: draining,
    inFlightPrompts,
    inFlightOwner: session,
    deliver: () => new Promise((resolve, reject) => {
      rejectDelivery = reject
      deliveryStarted()
    }),
  })

  await started
  assert.deepEqual(pending.get('old-session'), [])
  assert.deepEqual(inFlightPrompts.get(session), [first, second])
  rebindSessionRuntimeState('old-session', 'new-session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
  })
  assert.equal(grants.rebind({
    fromSessionId: 'old-session', toSessionId: 'new-session', channelId: 'C1', provider: 'codex',
    tokens: artifactGrantTokensFromPrompts([
      ...(pending.get('new-session') || []), ...(inFlightPrompts.get(session) || []),
    ]),
  }), 2)
  session.id = 'new-session'
  rejectDelivery(new Error('replacement raced with delivery'))
  await assert.rejects(drain, /replacement raced with delivery/)

  assert.deepEqual(pending.get('new-session'), [first, second])
  assert.equal(inFlightPrompts.has(session), false)
  assert.equal(grants.claim('first-token', {
    sessionId: 'new-session', channelId: 'C1', provider: 'codex',
  }).sessionId, 'new-session')
  assert.equal(grants.claim('second-token', {
    sessionId: 'new-session', channelId: 'C1', provider: 'codex',
  }).sessionId, 'new-session')
  assert.throws(() => grants.claim('unrelated-token', {
    sessionId: 'new-session', channelId: 'C1', provider: 'codex',
  }), /invalid/)
})

test('a replacement hook snapshots drain authority before asynchronous validation', async () => {
  const session = { id: 'old-session' }
  const prompt = `queued${artifactDeliveryInstruction('delayed-hook-token')}`
  const pending = new Map([['old-session', [prompt]]])
  const replacementHooks = createSessionReplacementHookTracker()
  const inFlightPrompts = replacementHooks
  let releaseDelivery
  let deliveryStarted
  const started = new Promise(resolve => { deliveryStarted = resolve })
  const drain = drainSessionInputQueue(() => session.id, {
    pendingBySession: pending,
    updatingSessionIds: new Set(['old-session']),
    drainingSessionIds: new Set(),
    inFlightPrompts,
    inFlightOwner: session,
    deliver: () => new Promise(resolve => {
      releaseDelivery = resolve
      deliveryStarted()
    }),
  })

  await started
  const hook = replacementHooks.begin(session)
  releaseDelivery()
  await drain
  assert.equal(inFlightPrompts.has(session), false)
  assert.deepEqual(replacementHooks.prompts(hook), [prompt])
  assert.deepEqual(artifactGrantTokensFromPrompts(replacementHooks.prompts(hook)), ['delayed-hook-token'])
  replacementHooks.finish(hook)
  assert.deepEqual(replacementHooks.prompts(hook), [])
})

test('overlapping replacement hooks retain separate prompt authority', () => {
  const session = { id: 'old-session' }
  const tracker = createSessionReplacementHookTracker()
  tracker.set(session, ['first replacement prompt'])
  const firstHook = tracker.begin(session)
  tracker.delete(session)
  tracker.set(session, ['second replacement prompt'])
  const secondHook = tracker.begin(session)

  assert.deepEqual(tracker.prompts(firstHook), [
    'first replacement prompt', 'second replacement prompt',
  ])
  assert.deepEqual(tracker.prompts(secondHook), ['second replacement prompt'])
  tracker.finish(firstHook)
  assert.deepEqual(tracker.prompts(firstHook), [])
  assert.deepEqual(tracker.prompts(secondHook), ['second replacement prompt'])
  tracker.finish(secondHook)
})

test('pending-only dormant input retries wake without weakening active maintenance fences', () => {
  assert.equal(shouldRetryDormantSessionWake({ pending: true, providerAlive: false }), true)
  assert.equal(shouldRetryDormantSessionWake({ pending: true, providerAlive: false, waking: true }), false)
  assert.equal(shouldRetryDormantSessionWake({ pending: true, providerAlive: false, updating: true }), false)
  assert.equal(shouldRetryDormantSessionWake({ pending: true, providerAlive: false, draining: true }), false)
  assert.equal(shouldRetryDormantSessionWake({ pending: true, providerAlive: true }), false)
  assert.equal(shouldRetryDormantSessionWake({ pending: false, providerAlive: false }), false)
})

test('startup failure releases a stranded maintenance marker while preserving queued input', () => {
  const pending = new Map([['session', ['retry me']]])
  const updating = new Set(['session'])
  const draining = new Set()

  assert.equal(recoverSessionInputFence('session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
    drainingSessionIds: draining,
  }), 'retry')
  assert.deepEqual(pending.get('session'), ['retry me'])
  assert.equal(updating.has('session'), false)

  updating.add('session')
  draining.add('session')
  assert.equal(recoverSessionInputFence('session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
    drainingSessionIds: draining,
  }), 'draining')
  assert.equal(updating.has('session'), true)
})

test('startup recovery cannot release a newer input-fence owner', () => {
  const olderOwner = Object.freeze({ generation: 1 })
  const newerOwner = Object.freeze({ generation: 2 })
  const pending = new Map([['session', ['newer operation owns this']]])
  const updating = new Set(['session'])
  const draining = new Set()
  const owners = new Map([['session', newerOwner]])

  assert.equal(recoverSessionInputFence('session', {
    pendingBySession: pending,
    updatingSessionIds: updating,
    drainingSessionIds: draining,
    fenceOwners: owners,
    expectedOwner: olderOwner,
  }), 'superseded')
  assert.equal(updating.has('session'), true)
  assert.equal(owners.get('session'), newerOwner)
  assert.deepEqual(pending.get('session'), ['newer operation owns this'])
})

test('native replacement transfers exact input-fence ownership', () => {
  const owner = Object.freeze({ generation: 1 })
  const updating = new Set(['old-session'])
  const owners = new Map([['old-session', owner]])

  rebindSessionRuntimeState('old-session', 'new-session', {
    pendingBySession: new Map(),
    updatingSessionIds: updating,
    restartingSessionIds: new Set(),
    wakingSessions: new Map(),
    fenceOwners: owners,
  })

  assert.equal(owners.has('old-session'), false)
  assert.equal(owners.get('new-session'), owner)
  assert.equal(updating.has('new-session'), true)
})
