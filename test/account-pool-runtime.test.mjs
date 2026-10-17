import test from 'node:test'
import assert from 'node:assert/strict'
import { compileAccountRegistry } from '../daemon/account-registry.mjs'
import { normalizeQuotaObservation } from '../daemon/account-quota.mjs'
import { createAccountPoolRuntime } from '../daemon/account-pool-runtime.mjs'

const now = 1800000000000
const enrollment = () => ({ schemaVersion: 1, requestId: 'runtime-fixture', accounts: [
  { key: 'primary', provider: 'claude', email: 'primary@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
  { key: 'secondary', provider: 'claude', email: 'secondary@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'second' }] },
  { key: 'client', provider: 'claude', email: 'client@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'client' }], allowedChannels: ['CCLIENT'] },
], groups: [{ key: 'mine', name: 'Mine', members: ['primary', 'secondary'], preferred: { claude: 'primary' } },
  { key: 'client', name: 'Client', members: ['client'] }], routing: { defaultGroup: 'mine', channels: { CCLIENT: 'client' } } })
const legacy = 'second=PRIVATE-SECOND\nclient=PRIVATE-CLIENT\n'

function reserveTask(f) {
  f.session.teamActiveTaskId = 'task-held'
  f.state.teams = { team: { id: 'team', coordinatorChannel: 'CCOORD', members: { CMINE: { role: 'worker' } } } }
  f.state.teamTasks = { 'task-held': { id: 'task-held', teamId: 'team', status: 'awaiting_release',
    completionPolicy: 'coordinator-release', sourceChannel: 'CCOORD', targetSessionId: f.session.id, targetChannel: 'CMINE', targetProvider: 'claude',
    workGeneration: 2, providerWorkGeneration: 2, pendingGates: ['review', 'merge'], completionRequest: null,
    messages: [], reports: [{ workGeneration: 2, deliveryStatus: 'delivered' }] } }
  return structuredClone(f.state.teamTasks)
}

test('explicit idle-task maintenance preserves pending gates, task authority and unrelated state', async () => {
  const f = setup({ blockReason: s => s.teamActiveTaskId ? 'delegated team task in progress' : null })
  const tasks = reserveTask(f), other = structuredClone(f.other)
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'ordinary' }), /blocked/)
  assert.equal((await f.runtime.switchAccount(f.session, 'second', { requestId: 'maintain', preserveTask: 'task-held' })).status, 'committed')
  assert.deepEqual(f.state.teamTasks, tasks); assert.deepEqual(f.other, other)
  assert.equal(f.session.teamActiveTaskId, 'task-held')
  assert.equal(Object.keys(f.state.accountPools.proofs).length, 0)
  assert.equal(f.state.accountPools.switches.CMINE.taskMaintenance.taskId, 'task-held')
  assert.equal((await f.runtime.switchAccount(f.session, 'second', { requestId: 'maintain', preserveTask: 'task-held' })).status, 'committed')
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'maintain' }), /conflict/)
})

test('task maintenance refuses running, mismatched, pending-message, busy and automatic switches', async () => {
  for (const reason of ['running', 'wrong-task', 'pending-message', 'busy', 'automatic', 'dormant']) {
    const f = setup({ isDormant: async () => true,
      blockReason: s => reason === 'busy' ? 'turn in progress' : s.teamActiveTaskId ? 'delegated team task in progress' : reason === 'dormant' ? 'provider is dormant' : null })
    reserveTask(f)
    if (reason === 'dormant') f.session.pid = null
    if (reason === 'running') f.state.teamTasks['task-held'].status = 'running'
    if (reason === 'pending-message') f.state.teamTasks['task-held'].messages = [{ deliveryStatus: 'pending' }]
    await assert.rejects(f.runtime.switchAccount(f.session, 'second', {
      requestId: reason, preserveTask: reason === 'wrong-task' ? 'task-other' : 'task-held', automatic: reason === 'automatic',
    }))
    assert.equal(f.events.some(e => e.restart), false)
  }
})

test('task mutation during credential proof prevents teardown; an interrupted restart preserves the reservation', async () => {
  let change = () => {}
  const f = setup({ blockReason: s => s.teamActiveTaskId ? 'delegated team task in progress' : null,
    verifyIdentity: async () => { change(); return 'verified' } })
  reserveTask(f)
  change = () => { f.state.teamTasks['task-held'].pendingGates.push('new-gate') }
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'raced', preserveTask: 'task-held' }))
  assert.equal(f.events.some(e => e.restart), false)
  const interrupted = setup({ blockReason: s => s.teamActiveTaskId ? 'delegated team task in progress' : null,
    restart: async () => { throw new Error('native resume interrupted') } })
  const tasks = reserveTask(interrupted)
  await assert.rejects(interrupted.runtime.switchAccount(interrupted.session, 'second', { requestId: 'crash', preserveTask: 'task-held' }), /uncertain/)
  assert.deepEqual(interrupted.state.teamTasks, tasks)
  await interrupted.runtime.recover()
  assert.equal(interrupted.session.teamActiveTaskId, 'task-held')
})

test('native normalization of stale flag fragments is not an account handover mismatch', async () => {
  const f = setup({ restart: async (s, alias) => { s.account = alias; s.pid = 200; s.launchFlags = '--chrome --dangerously-skip-permissions --model opus --effort max --resume native-one' } })
  f.session.launchFlags = '--chrome --dangerously-skip-permissions 5 (1M context) --model opus --effort max --resume native-one'
  assert.equal((await f.runtime.switchAccount(f.session, 'second', { requestId: 'canonical' })).status, 'committed')
})

test('a proved preflight rejection unlocks the unchanged task without an uncertain-restart fence', async () => {
  const f = setup({ blockReason: s => s.teamActiveTaskId ? 'delegated team task in progress' : null,
    restart: async () => { throw Object.assign(new Error('unknown background job'), { accountPreflightRejected: true }) } })
  const tasks = reserveTask(f)
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'preflight', preserveTask: 'task-held' }), /rejected/)
  assert.equal(f.state.accountPools.switches.CMINE.phase, 'rejected')
  assert.deepEqual(f.state.teamTasks, tasks)
  assert.equal(f.session.pid, 100)
  assert.equal(f.session.account, undefined)
})

test('serialized restart preserves an exact task reservation and reconciles without replay or automatic proof', async () => {
  const f = setup({ blockReason: s => s.teamActiveTaskId ? 'delegated team task in progress' : null,
    restart: async (session, alias) => { session.account = alias; session.pid = 200; throw new Error('crash after adoption') } })
  const tasks = reserveTask(f)
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'resume-recovery', preserveTask: 'task-held' }), /uncertain/)
  const disk = JSON.parse(JSON.stringify(f.state))
  const recovered = setup({ initialState: disk, readRegistry: () => f.registry,
    blockReason: s => s.teamActiveTaskId ? 'delegated team task in progress' : null,
    restart: async () => assert.fail('recovery must not restart') })
  await recovered.runtime.recover()
  assert.deepEqual(disk.teamTasks, tasks)
  assert.throws(() => recovered.runtime.assertInputAllowed(recovered.session), /uncertain/)
  const result = await recovered.runtime.reconcile(recovered.session, { requestId: 'resume-recovery' })
  assert.equal(result.status, 'reconciled')
  assert.deepEqual(disk.teamTasks, tasks)
  assert.equal(recovered.session.teamActiveTaskId, 'task-held')
  assert.equal(Object.keys(disk.accountPools.proofs).length, 0)
})
function setup({ mode = 'manual', initialState = null, ...overrides } = {}) {
  const registry = compileAccountRegistry(enrollment(), { legacyAccounts: legacy })
  const session = { id: 'native-one', channel: 'CMINE', cwd: '/workspace', tmux: 'sab-one', pid: 100,
    model: 'opus', effort: 'max', launchFlags: '--chrome --dsp', teamTurn: { role: 'owner', id: 'exact-turn' } }
  const other = { id: 'other-native', channel: 'COTHER', pid: 101, tmux: 'sab-other', cwd: '/other' }
  const state = initialState || { channels: { CMINE: session.id, COTHER: other.id }, sessions: { [session.id]: session, [other.id]: other } }
  const events = [], notices = []
  let blocked = null
  const runtime = createAccountPoolRuntime({ state, mode, readRegistry: () => registry,
    persist: () => { events.push(structuredClone(state)) }, now: () => now,
    readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: now,
      identity: { email: account.email, principalId: account.id }, quota: { five_hour: { utilization: account.key === 'primary' ? 99 : 10, resets_at: new Date(now + 3600000).toISOString() } } }),
    blockReason: () => blocked,
    verifyIdentity: async () => 'verified',
    restart: async (current, alias) => { events.push({ restart: true, alias }); current.account = alias; current.pid = 200 },
    notify: async (channel, notice) => { notices.push({ channel, notice }) }, ...overrides,
  })
  return { runtime, registry, state, session: state.sessions[state.channels.CMINE], other: state.sessions[state.channels.COTHER], events, notices,
    setBlocked: reason => { blocked = reason } }
}

test('pool mode off is zero-I/O and creates no state, even if the registry is broken', async () => {
  const state = { sessions: {}, channels: {} }
  const runtime = createAccountPoolRuntime({ state, mode: 'off', readRegistry: () => { throw new Error('must not read') },
    persist: () => { throw new Error('must not write') }, readQuota: () => { throw new Error('must not call') } })
  await runtime.tick()
  assert.deepEqual(state, { sessions: {}, channels: {} })
  assert.equal(runtime.enabled, false)
})

test('new live sessions outside their channel route cannot receive prompts even before their first restart', () => {
  const { runtime, session } = setup()
  session.account = 'client'
  assert.throws(() => runtime.assertInputAllowed(session), /account_outside_group/)
  session.account = 'second'; runtime.assertInputAllowed(session)
})

test('credential mismatch is rejected before teardown and does not poison the current input surface', async () => {
  const { runtime, session, events } = setup({ verifyIdentity: async () => 'identity-mismatch' })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'wrong-identity' }), /account_handover_rejected/)
  assert.equal(events.filter(e => e.restart).length, 0)
  assert.equal(runtime.status(session.channel).pendingSwitch.phase, 'rejected')
  runtime.assertInputAllowed(session)
})

test('an unverified replacement cannot mint resume proof or receive input; exact reconciliation never restarts it', async () => {
  let valid = false, restarts = 0
  const { runtime, session, state } = setup({
    verifyIdentity: async (s, a, { stage }) => stage === 'credential' || valid ? 'verified' : 'identity-mismatch',
    restart: async (s, alias) => { restarts++; s.account = alias; s.pid = 200 },
  })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'verify-replacement' }), /account_handover_uncertain/)
  assert.equal(Object.keys(state.accountPools.proofs).length, 0)
  assert.throws(() => runtime.assertInputAllowed(session), /account_handover_uncertain/)
  assert.throws(() => runtime.assertLaunchAllowed(session), /account_handover_uncertain/)
  await assert.rejects(runtime.reconcile(session, { requestId: 'wrong-request' }), /account_request_conflict/)
  await assert.rejects(runtime.reconcile(session, { requestId: 'verify-replacement' }), /account_identity_unverified/)
  valid = true
  assert.equal((await runtime.reconcile(session, { requestId: 'verify-replacement' })).status, 'reconciled')
  runtime.assertInputAllowed(session)
  assert.equal(restarts, 1)
  assert.equal(Object.keys(state.accountPools.proofs).length, 0)
  assert.ok(Object.values(state.accountPools.receipts).every(r => r.phase === 'reconciled'))
})

test('scope-limited legacy manual switching is visibly unverified and never authorizes automatic rotation', async () => {
  const { runtime, session, state, notices } = setup({ verifyIdentity: async () => 'scope-unavailable' })
  await runtime.switchAccount(session, 'second', { requestId: 'legacy-manual' })
  assert.equal(Object.keys(state.accountPools.proofs).length, 0)
  assert.equal(runtime.status(session.channel).pendingSwitch.identityVerified, false)
  assert.match(notices.at(-1).notice, /does not authorize automatic/)
})

test('a dead uncertain replacement permits an explicit same-target recovery selection, never an automatic retry', async () => {
  const { runtime, session } = setup({ restart: async (s, alias) => { s.account = alias; s.pid = null; s.tmux = null; throw new Error('failed launch') } })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'failed-original' }), /account_handover_uncertain/)
  assert.throws(() => runtime.assertLaunchAllowed(session), /account_handover_uncertain/)
  const recovery = await runtime.switchAccount(session, 'second', { requestId: 'explicit-recovery' })
  assert.equal(recovery.status, 'selected')
  runtime.assertLaunchAllowed(session)
  assert.equal(runtime.status(session.channel).pendingSwitch.requestId, 'explicit-recovery')
})

test('a failed refresh retains last known reset times for display, never as current capacity proof', async () => {
  let clock = now, failures = false
  const { runtime, session } = setup({ now: () => clock, readQuota: async account => failures
    ? { provider: 'claude', observedAt: clock, status: 'provider-unavailable', windows: [] }
    : normalizeQuotaObservation({ provider: 'claude', observedAt: clock, identity: { email: account.email, principalId: account.id },
      quota: { five_hour: { utilization: 98, resets_at: new Date(now + 3600000).toISOString() } } }) })
  await runtime.refresh('primary'); clock += 360001; failures = true; await runtime.refresh('primary')
  const info = runtime.status(session.channel), current = info.accounts.find(a => a.email === 'primary@example.test')
  assert.equal(current.observation.status, 'provider-unavailable')
  assert.equal(current.lastKnownQuota.windows[0].resetsAt, now + 3600000)
  assert.equal(info.decision.candidates.find(c => c.accountId === current.id).ready, false)
})

test('draining excludes new selections but never interrupts a busy account or deletes its credentials', async () => {
  let registry = compileAccountRegistry(enrollment(), { legacyAccounts: legacy })
  const spec = structuredClone(registry.spec); spec.requestId = 'draining'; spec.groups.find(g => g.key === 'mine').preferred.claude = 'secondary'
  spec.accounts.find(a => a.key === 'primary').lifecycle = 'draining'
  registry = compileAccountRegistry(spec, { legacyAccounts: legacy, prior: registry })
  const { runtime, session, events, setBlocked } = setup({ mode: 'auto', readRegistry: () => registry })
  setBlocked('turn in progress')
  await runtime.tick()
  assert.equal(events.filter(e => e.restart).length, 0)
  assert.equal(runtime.status(session.channel).decision.candidates.find(c => c.accountId === registry.history.accounts.primary.id).reason, 'account-draining')
  assert.equal(runtime.inventory().usage[registry.history.accounts.primary.id].length, 2)
  assert.throws(() => runtime.assertLaunchAllowed(session), /account_draining/)
})

test('full Claude profile switches persist the exact credential kind, without changing native settings or unrelated sessions', async () => {
  let registry = compileAccountRegistry(enrollment(), { legacyAccounts: legacy })
  const spec = structuredClone(registry.spec); spec.requestId = 'full-profile'
  spec.accounts.find(a => a.key === 'secondary').credentials.push({ kind: 'claude-profile', profile: 'full-second' })
  registry = compileAccountRegistry(spec, { legacyAccounts: legacy, prior: registry })
  const { runtime, session, other } = setup({ readRegistry: () => registry, restart: async (s, alias, options) => {
    s.account = alias; s.accountKind = 'claude-profile'; s.pid = 200
    assert.equal(options.account.credentials.some(c => c.kind === 'claude-profile'), true)
  } })
  const before = structuredClone(other)
  assert.equal((await runtime.switchAccount(session, 'secondary', { requestId: 'native-profile' })).status, 'committed')
  assert.equal(session.account, 'full-second'); assert.equal(session.accountKind, 'claude-profile')
  assert.equal(runtime.status(session.channel).currentAccount.email, 'secondary@example.test')
  assert.equal(session.model, 'opus'); assert.equal(session.effort, 'max'); assert.deepEqual(other, before)
})

test('monitor refresh is account-deduplicated, durable, throttled, and never overwrites a newer observation', async () => {
  let calls = 0, release
  const { runtime, state } = setup({ mode: 'shadow', readQuota: async account => { calls++; await new Promise(resolve => { release = resolve });
    return { provider: account.provider, observedAt: now, status: 'scope-unavailable', windows: [] } } })
  const first = runtime.refresh('primary')
  const duplicate = runtime.refresh('primary')
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  await Promise.all([first, duplicate])
  const samples = Object.values(state.accountPools.observations)
  assert.equal(samples.length, 1)
  assert.equal(samples[0].observation.status, 'scope-unavailable')
  assert.ok(samples[0].nextPollAt > now)
})

test('shadow mode observes and recommends without changing sessions, bindings, or launching providers', async () => {
  const { runtime, state, session, other, events } = setup({ mode: 'shadow' })
  const before = structuredClone({ session, other })
  await runtime.tick()
  assert.deepEqual({ session, other }, before)
  assert.ok(Object.keys(state.accountPools.observations).length > 0)
  assert.ok(!events.some(event => event.restart))
  const status = runtime.status('CMINE')
  assert.equal(status.mode, 'shadow')
  assert.equal(status.currentAccount.email, 'primary@example.test')
  assert.equal(status.decision.reason, 'capacity-handover')
  assert.equal(status.automaticSwitching, false)
  assert.equal(runtime.enforcing, false)
  session.account = 'client' // shadow does not alter legacy resume behavior
  runtime.assertLaunchAllowed(session)
  runtime.assertProviderLaunchAllowed(session.channel, 'claude', 'client')
})

test('provider switching cannot launch a standby/default account outside the channel pool', () => {
  const { runtime } = setup()
  runtime.assertProviderLaunchAllowed('CMINE', 'claude', 'second')
  assert.throws(() => runtime.assertProviderLaunchAllowed('CMINE', 'claude', 'client'), /account_outside_group/)
  assert.throws(() => runtime.assertProviderLaunchAllowed('CCLIENT', 'claude', null), /stale_account_session/)
  runtime.assertProviderLaunchAllowed('CMINE', 'pi')
})

test('manual handover journals before restart, preserves current settings, and leaves unrelated sessions untouched', async () => {
  const { runtime, state, session, other, events } = setup()
  const before = structuredClone(other), settings = structuredClone({ model: session.model, effort: session.effort, launchFlags: session.launchFlags, teamTurn: session.teamTurn })
  const result = await runtime.switchAccount(session, 'secondary@example.test', { requestId: 'owner-switch-1', expectedSessionId: session.id })
  assert.equal(result.status, 'committed')
  assert.deepEqual({ model: session.model, effort: session.effort, launchFlags: session.launchFlags, teamTurn: session.teamTurn }, settings)
  assert.deepEqual(other, before)
  assert.equal(session.account, 'second')
  assert.equal(state.accountPools.bindings.CMINE.accountId, result.accountId)
  const restartIndex = events.findIndex(event => event.restart)
  assert.ok(restartIndex > 0)
  assert.equal(events[restartIndex - 1].accountPools.switches.CMINE.phase, 'restarting')
  const again = await runtime.switchAccount(session, 'secondary@example.test', { requestId: 'owner-switch-1', expectedSessionId: session.id })
  assert.equal(again.status, 'committed')
  assert.equal(events.filter(event => event.restart).length, 1)
})

test('wrong group, wrong provider, blocked turns, stale identity, and rebound channels reject before restart', async () => {
  const { runtime, state, session, events, setBlocked } = setup()
  await assert.rejects(runtime.switchAccount(session, 'client', { requestId: 'cross-group' }), /account_outside_group/)
  setBlocked('delegated team task in progress')
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'busy' }), /account_switch_blocked/)
  setBlocked(null)
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'stale', expectedSessionId: 'old-id' }), /stale_account_session/)
  state.channels.CMINE = 'other-native'
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'rebound' }), /stale_account_session/)
  assert.ok(!events.some(event => event.restart))
})

test('dormant account corrections are explicit, durable, idempotent, and never launch or claim resume proof', async () => {
  const { runtime, state, session, events } = setup()
  session.pid = null; session.tmux = null
  const before = structuredClone(session)
  const options = { requestId: 'dormant-correction', expectedSessionId: session.id }
  const result = await runtime.switchAccount(session, 'second', options)
  assert.equal(result.status, 'selected')
  assert.equal(session.account, 'second')
  assert.deepEqual({ ...session, account: undefined }, { ...before, account: undefined })
  assert.ok(!events.some(event => event.restart))
  assert.equal(Object.keys(state.accountPools.proofs).length, 0)
  assert.equal((await runtime.switchAccount(session, 'second', options)).status, 'selected')
  runtime.assertLaunchAllowed(session)
  session.account = 'client'
  assert.throws(() => runtime.assertLaunchAllowed(session), /account_outside_group/)
})

test('dormant correction proves historical PID/tmux are dead and refuses racing native re-adoption', async () => {
  let release
  const { runtime, session, events, setBlocked } = setup({ isDormant: async () => new Promise(resolve => { release = resolve }) })
  setBlocked('provider is dormant')
  const pending = runtime.switchAccount(session, 'second', { requestId: 'historical-binding' })
  session.pid = 999 // SessionStart re-adopted it while tmux liveness was checked.
  release(true)
  await assert.rejects(pending, /account_handover_rejected/)
  assert.equal(session.account, undefined)
  assert.ok(!events.some(event => event.restart))
})

test('uncertain restart is journaled and never replayed on retry or daemon recovery', async () => {
  let attempts = 0
  const { runtime, state, session } = setup({ restart: async () => { attempts++; throw new Error('PRIVATE-ERROR') } })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'uncertain' }), /account_handover_uncertain/)
  assert.equal(state.accountPools.switches.CMINE.phase, 'interrupted')
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'uncertain' }), /account_handover_uncertain/)
  const recovered = setup({ initialState: JSON.parse(JSON.stringify(state)) })
  await recovered.runtime.recover()
  assert.equal(attempts, 1)
  assert.doesNotMatch(JSON.stringify(state.accountPools), /PRIVATE-ERROR|PRIVATE-SECOND|PRIVATE-CLIENT/)
})

test('concurrent handovers reserve one exact session before the first await', async () => {
  let release, restarts = 0
  const { runtime, session } = setup({ restart: async (current, alias) => { restarts++; await new Promise(resolve => { release = resolve }); current.account = alias } })
  const first = runtime.switchAccount(session, 'second', { requestId: 'first' })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'second' }), /account_switch_in_progress/)
  release(); await first
  assert.equal(restarts, 1)
})

test('automatic switching requires successful manual resume proof and never interrupts active work', async () => {
  const { runtime, session, other, events, setBlocked } = setup({ mode: 'auto' })
  other.pid = null // This canary exercises one exact live session.
  await runtime.tick()
  assert.ok(!events.some(event => event.restart))
  await runtime.switchAccount(session, 'second', { requestId: 'manual-proof' })
  // A safe-boundary return to the primary records proof of that direction too.
  await runtime.switchAccount(session, 'primary', { requestId: 'return-proof' })
  const count = events.filter(event => event.restart).length
  setBlocked('turn in progress')
  await runtime.tick()
  assert.equal(events.filter(event => event.restart).length, count)
  setBlocked(null)
  await runtime.tick()
  assert.equal(events.filter(event => event.restart).length, count + 1)
  assert.equal(session.account, 'second')
})

test('a persistence failure fences all future account mutations without stopping any provider', async () => {
  let restarts = 0
  const { runtime, session } = setup({ persist: () => { throw new Error('disk full PRIVATE-DATA') }, restart: async () => { restarts++ } })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'disk-error' }), /account_handover_rejected/)
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'another-attempt' }), /account_pool_persistence_failed/)
  await runtime.tick()
  assert.equal(restarts, 0)
  assert.equal(runtime.status('CMINE').persistenceFailed, true)
})

test('network/scope failures alone cannot rotate accounts even with proven resume directions', async () => {
  let failureMode = false, time = now
  const { runtime, session, other, events } = setup({ mode: 'auto', now: () => time,
    readQuota: async account => failureMode ? { provider: account.provider, observedAt: time, status: 'scope-unavailable', windows: [] }
      : normalizeQuotaObservation({ provider: 'claude', observedAt: time, identity: { email: account.email, principalId: account.id },
        quota: { five_hour: { utilization: account.key === 'primary' ? 99 : 10, resets_at: new Date(time + 3600000).toISOString() } } }) })
  other.pid = null
  await runtime.switchAccount(session, 'second', { requestId: 'prove-outward' })
  await runtime.switchAccount(session, 'primary', { requestId: 'prove-return' })
  failureMode = true
  await runtime.tick()
  assert.equal(events.filter(event => event.restart).length, 2)
  assert.equal(session.account, null)
})

test('recovery after JSON persistence marks both receipt and current switch interrupted without replay', async () => {
  const { runtime, state, session } = setup()
  await runtime.switchAccount(session, 'second', { requestId: 'recovery' })
  const copy = JSON.parse(JSON.stringify(state))
  copy.accountPools.switches.CMINE.phase = 'restarting'
  Object.values(copy.accountPools.receipts)[0].phase = 'restarting'
  const recovered = setup({ initialState: copy })
  await recovered.runtime.recover()
  assert.equal(copy.accountPools.switches.CMINE.phase, 'interrupted')
  assert.equal(Object.values(copy.accountPools.receipts)[0].phase, 'interrupted')
  assert.ok(!recovered.events.some(event => event.restart))
})

test('Codex profile handover preserves native identity, requested settings, channel, and standby legs', async () => {
  const record = compileAccountRegistry({ schemaVersion: 1, requestId: 'codex-profile-fixture', accounts: [
    { key: 'primary', provider: 'codex', email: 'primary@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
    { key: 'secondary', provider: 'codex', email: 'secondary@example.test', identityConfirmed: true, credentials: [{ kind: 'codex-profile', profile: 'second' }] },
  ], groups: [{ key: 'mine', name: 'Mine', members: ['primary', 'secondary'] }], routing: { defaultGroup: 'mine', channels: {} } })
  const session = { id: 'codex-native', channel: 'CCODEX', provider: 'codex', pid: 500, tmux: 'sab-native', cwd: '/codex',
    model: 'gpt-5.6-sol', requestedModel: 'gpt-5.6-sol', effort: 'xhigh', requestedEffort: 'xhigh', launchFlags: '--yolo' }
  const state = { channels: { CCODEX: session.id }, sessions: { [session.id]: session, standby: { id: 'standby', provider: 'claude', channel: null } },
    lineages: { CCODEX: { activeProvider: 'codex', legs: { codex: session.id, claude: 'standby' } } } }
  const before = structuredClone(state)
  let restarts = 0
  const runtime = createAccountPoolRuntime({ state, mode: 'manual', readRegistry: () => record, persist: () => {},
    verifyIdentity: async () => 'verified',
    restart: async (current, profile) => { restarts++; current.account = profile; current.pid = 501 } })
  const result = await runtime.switchAccount(session, 'secondary@example.test', { requestId: 'codex-outward' })
  assert.equal(result.status, 'committed')
  assert.equal(session.account, 'second')
  assert.equal(session.requestedModel, 'gpt-5.6-sol')
  assert.equal(session.requestedEffort, 'xhigh')
  assert.deepEqual(state.lineages, before.lineages)
  assert.deepEqual(state.sessions.standby, before.sessions.standby)
  assert.equal(restarts, 1)
})
