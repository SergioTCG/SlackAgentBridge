import test from 'node:test'
import assert from 'node:assert/strict'
import { compileAccountRegistry, publicAccountRegistry } from '../daemon/account-registry.mjs'
import { choosePoolAccount, normalizeQuotaObservation } from '../daemon/account-quota.mjs'
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
    usageLimitBlockReason: async () => blocked,
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
  const { runtime, session, events, notices } = setup({ verifyIdentity: async () => 'identity-mismatch' })
  await assert.rejects(runtime.switchAccount(session, 'second', { requestId: 'wrong-identity' }), /account_handover_rejected/)
  assert.equal(events.filter(e => e.restart).length, 0)
  assert.equal(runtime.status(session.channel).pendingSwitch.phase, 'rejected')
  assert.equal(runtime.status(session.channel).pendingSwitch.reason, 'account_identity_unverified')
  assert.deepEqual(notices.map(n => n.notice), ['Account handover was rejected before teardown: the target login could not be verified. The existing provider was not stopped.'])
  runtime.assertInputAllowed(session)
})

test('a rejected automatic handover names its cause once and backs off instead of retrying every tick', async () => {
  let time = now, idle = true, restarts = 0
  // 89% leaves 11% measured headroom, which the reservation estimate exhausts:
  // the ordinary path, not a usage limit.
  const { runtime, session, other, notices, state } = setup({ mode: 'auto', now: () => time,
    readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: time, identity: { email: account.email, principalId: account.id },
      quota: { five_hour: { utilization: account.key === 'primary' ? 89 : 10, resets_at: new Date(time + 3600000).toISOString() } } }),
    restart: async (current, alias) => {
      if (!idle) throw Object.assign(new Error('account_switch_not_proven_idle'), { accountPreflightRejected: true })
      restarts++; current.account = alias; current.pid = 200
    } })
  other.pid = null
  await runtime.switchAccount(session, 'second', { requestId: 'prove-outward' })
  await runtime.switchAccount(session, 'primary', { requestId: 'prove-return' })
  idle = false; notices.length = 0
  await runtime.tick()
  const first = state.accountPools.switches.CMINE
  assert.equal(first.phase, 'rejected')
  assert.equal(first.reason, 'account_switch_not_proven_idle')
  assert.deepEqual(notices.map(n => n.notice), ['Account handover was rejected before teardown: its terminal was not proven idle. ' +
    'The existing provider was not stopped. If it is still needed, SAB retries automatically in 15 min.'])
  const receipts = Object.keys(state.accountPools.receipts).length
  for (const minutes of [1, 5, 14]) { time = now + minutes * 60000; await runtime.tick() }
  assert.equal(Object.keys(state.accountPools.receipts).length, receipts, 'no attempt inside the back-off window')
  assert.equal(notices.length, 1)
  time = now + 16 * 60000
  await runtime.tick()
  const second = state.accountPools.switches.CMINE
  assert.equal(second.attempt, 2)
  assert.match(notices.at(-1).notice, /retries automatically in 30 min\.$/)
  assert.equal(notices.length, 2, 'a journaled rejection is not repeated as a generic blocked notice')
  time += 29 * 60000
  await runtime.tick()
  assert.equal(state.accountPools.switches.CMINE, second, 'the doubled window holds')
  idle = true; time += 2 * 60000
  await runtime.tick()
  assert.equal(state.accountPools.switches.CMINE.phase, 'committed')
  assert.equal(session.account, 'second')
  assert.equal(restarts, 3)
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

test('reconcile adopts the exact live replacement whose SessionStart a daemon restart lost, without restarting it', async () => {
  const f = setup({ restart: async (session, alias) => { session.account = alias; session.pid = 200; throw new Error('daemon stopped before SessionStart') } })
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'lost-start' }), /account_handover_uncertain/)
  const disk = JSON.parse(JSON.stringify(f.state))
  disk.sessions['native-one'].pid = null // its only SessionStart reached the stopped daemon
  const adopted = []
  const recovered = setup({ initialState: disk, readRegistry: () => f.registry,
    blockReason: session => session.pid ? null : 'provider is dormant',
    restart: async () => assert.fail('reconcile must not restart'),
    adoptReplacement: async session => { adopted.push(session.tmux); return 300 },
    verifyIdentity: async (session, account, { stage }) => stage === 'replacement' && session.pid === 300 ? 'verified' : 'identity-mismatch' })
  await recovered.runtime.recover()
  assert.throws(() => recovered.runtime.assertInputAllowed(recovered.session), /account_handover_uncertain/)
  assert.equal((await recovered.runtime.reconcile(recovered.session, { requestId: 'lost-start' })).status, 'reconciled')
  assert.equal(recovered.session.pid, 300)
  assert.deepEqual(adopted, ['sab-one'])
  recovered.runtime.assertInputAllowed(recovered.session)
  assert.equal(Object.keys(disk.accountPools.proofs).length, 0)
})

test('reconcile without a provable replacement process stays fenced and binds nothing', async () => {
  const f = setup({ restart: async (session, alias) => { session.account = alias; session.pid = 200; throw new Error('daemon stopped before SessionStart') } })
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'lost-start' }), /account_handover_uncertain/)
  f.session.pid = null
  const persisted = f.events.length
  const recovered = setup({ initialState: f.state, readRegistry: () => f.registry, adoptReplacement: async () => null,
    blockReason: session => session.pid ? null : 'provider is dormant' })
  await assert.rejects(recovered.runtime.reconcile(recovered.session, { requestId: 'lost-start' }), /account_switch_blocked/)
  assert.equal(recovered.session.pid, null)
  assert.equal(recovered.state.accountPools.switches.CMINE.phase, 'interrupted')
  assert.equal(recovered.events.length, 0)
  assert.equal(f.events.length, persisted)
  assert.throws(() => recovered.runtime.assertInputAllowed(recovered.session), /account_handover_uncertain/)
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

// The worker (or, standing, the sub-coordinator) of a team led from CCOORD.
function holdTask(f, { standing = false, status = 'running' } = {}) {
  f.state.teams = { team: { id: 'team', coordinatorChannel: 'CCOORD', members: { CMINE: { role: 'worker' } } } }
  const task = { id: 'task-held', teamId: 'team', status, completionPolicy: 'coordinator-release', sourceChannel: 'CCOORD',
    targetSessionId: f.session.id, targetChannel: 'CMINE', targetProvider: 'claude', workGeneration: 3, providerWorkGeneration: 3,
    pendingGates: [], replies: [], reports: [{ workGeneration: 2, deliveryStatus: 'delivered' }],
    messages: [{ id: 'message_done', workGeneration: 3, deliveryStatus: 'delivered', providerDeliveryStatus: 'delivered' }] }
  if (standing) { task.reservation = 'standing'; f.session.teamStandingTaskId = task.id } else f.session.teamActiveTaskId = task.id
  f.state.teamTasks = { [task.id]: task }
  return structuredClone(f.state.teamTasks)
}
const heldWork = s => s.teamActiveTaskId || s.teamStandingTaskId ? 'delegated team task in progress' : null

async function usageLimitFixture({ quota = { primary: 99, secondary: 10 }, ...overrides } = {}) {
  const settled = [], restarts = []
  const f = setup({ mode: 'auto', blockReason: heldWork, usageLimitBlockReason: async () => null,
    readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: now,
      identity: { email: account.email, principalId: account.id }, quota: { five_hour: { utilization: quota[account.key] ?? 10,
        resets_at: new Date(now + 3600000).toISOString() } } }),
    restart: async (current, alias, options) => { restarts.push(options); current.account = alias; current.pid = 200; return { note: 'Shell note.' } },
    onSettled: (session, info) => settled.push(info), ...overrides })
  f.other.pid = null
  // Automatic switching needs a proven manual round trip first.
  await f.runtime.switchAccount(f.session, 'second', { requestId: 'prove-outward' })
  await f.runtime.switchAccount(f.session, 'primary', { requestId: 'prove-return' })
  restarts.length = 0; settled.length = 0; f.notices.length = 0
  for (const key of ['primary', 'secondary']) await f.runtime.refresh(key)
  return { ...f, settled, restarts }
}

test('an exhausted account hands over a session with an active coordinator (standing) task, leaving the task unchanged', async () => {
  const f = await usageLimitFixture()
  const tasks = holdTask(f, { standing: true })
  await f.runtime.tick()
  assert.equal(f.restarts.length, 1)
  assert.equal(f.restarts[0].usageLimit, true)
  assert.equal(f.restarts[0].taskMaintenance.kind, 'usage-limit')
  assert.equal(f.restarts[0].source.email, 'primary@example.test')
  assert.equal(f.session.account, 'second')
  assert.deepEqual(f.state.teamTasks, tasks)
  assert.equal(f.session.teamStandingTaskId, 'task-held')
  const journal = f.state.accountPools.switches.CMINE
  assert.equal(journal.phase, 'committed')
  assert.equal(journal.usageLimit, true)
  assert.equal(journal.taskMaintenance.taskId, 'task-held')
  assert.equal(f.settled.length, 1)
  assert.equal(f.settled[0].journal, journal)
  assert.equal(f.settled[0].target.email, 'secondary@example.test')
  assert.deepEqual(f.notices.map(n => n.notice), ['Account handover complete: secondary@example.test (Mine). ' +
    'primary@example.test had reached its usage limit; team task `task-held` continues unchanged. Shell note.'])
})

test('an exhausted account hands over a running delegated task without failing, completing or releasing it', async () => {
  const f = await usageLimitFixture()
  const tasks = holdTask(f)
  await f.runtime.tick()
  assert.equal(f.restarts.length, 1)
  assert.deepEqual(f.state.teamTasks, tasks)
  assert.equal(f.state.teamTasks['task-held'].status, 'running')
  assert.equal(f.session.teamActiveTaskId, 'task-held')
  await f.runtime.tick()
  assert.equal(f.restarts.length, 1, 'the committed handover is not repeated')
  assert.equal(Object.values(f.state.accountPools.receipts).filter(r => r.usageLimit).length, 1)
})

test('held work on an account with capacity is never moved by a usage-limit handover', async () => {
  const f = await usageLimitFixture({ quota: { primary: 50, secondary: 10 } })
  holdTask(f)
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0)
  assert.equal(f.session.account, null)
})

test('a preferred-account return, or a drain, still waits until the held task is at a safe boundary', async () => {
  const f = await usageLimitFixture({ quota: { primary: 10, secondary: 60 } })
  await f.runtime.switchAccount(f.session, 'second', { requestId: 'onto-secondary' })
  f.state.accountPools.bindings.CMINE = { ...f.state.accountPools.bindings.CMINE, preferredResetAt: now - 1, switchedAt: now - 7200000 }
  f.restarts.length = 0
  holdTask(f)
  assert.equal(f.runtime.status('CMINE').decision.reason, 'preferred-recovered')
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0, 'no preference switch mid-task')
  assert.equal(f.session.account, 'second')
  delete f.session.teamActiveTaskId
  await f.runtime.tick()
  assert.equal(f.restarts.length, 1)
  assert.equal(f.restarts[0].usageLimit, false)
  assert.equal(f.session.account, null)
})

test('a usage-limit handover that is not yet safe is retried quietly on the next tick', async () => {
  const logs = []
  let reason = 'turn in progress'
  const f = await usageLimitFixture({ usageLimitBlockReason: async () => reason, log: (...args) => logs.push(args) })
  holdTask(f)
  for (let i = 0; i < 3; i++) await f.runtime.tick()
  assert.equal(f.restarts.length, 0)
  assert.deepEqual(f.notices, [])
  assert.equal(logs.length, 1, 'one log line per distinct refusal')
  reason = null
  await f.runtime.tick()
  assert.equal(f.restarts.length, 1)
})

test('an exhausted session moves on measured capacity when the reservation estimate is spent', async () => {
  const f = await usageLimitFixture()
  holdTask(f)
  for (let i = 0; i < 20; i++) {
    const busy = { id: `busy-${i}`, channel: `CBUSY${i}`, pid: 300 + i, tmux: `sab-busy-${i}`, cwd: '/busy', account: 'second', teamActiveTaskId: 'elsewhere' }
    f.state.sessions[busy.id] = busy; f.state.channels[busy.channel] = busy.id
  }
  assert.equal(f.runtime.status('CMINE').decision.accountId, null, 'the estimate alone finds no capacity')
  await f.runtime.tick()
  assert.equal(f.restarts.filter(r => r.usageLimit).length, 1)
  assert.equal(f.session.account, 'second')
})

test('a daemon restart during a usage-limit handover leaves it interrupted, fenced and never replayed', async () => {
  const f = await usageLimitFixture({ restart: async (current, alias, options) => {
    current.account = alias; current.pid = 200
    if (options.usageLimit) throw new Error('daemon stopped')
  } })
  const tasks = holdTask(f)
  await f.runtime.tick()
  const disk = structuredClone(f.events.findLast(e => e.accountPools?.switches?.CMINE?.phase === 'restarting'))
  assert.ok(disk, 'the restart phase was journaled before teardown')
  const settled = []
  const recovered = setup({ mode: 'auto', initialState: disk, readRegistry: () => f.registry, blockReason: heldWork,
    usageLimitBlockReason: async () => null, onSettled: (session, info) => settled.push(info),
    restart: async () => assert.fail('recovery must not restart') })
  recovered.session.account = 'second'; recovered.session.pid = 200
  await recovered.runtime.recover()
  assert.equal(recovered.state.accountPools.switches.CMINE.phase, 'interrupted')
  assert.throws(() => recovered.runtime.assertInputAllowed(recovered.session), /uncertain/)
  await recovered.runtime.tick()
  assert.deepEqual(recovered.state.teamTasks, tasks)
  const requestId = recovered.state.accountPools.switches.CMINE.requestId
  assert.equal((await recovered.runtime.reconcile(recovered.session, { requestId })).status, 'reconciled')
  assert.equal(settled.length, 1)
  assert.equal(settled[0].journal.usageLimit, true)
  assert.deepEqual(recovered.state.teamTasks, tasks)
})

test('only the monitor may declare a usage limit', async () => {
  const f = await usageLimitFixture()
  holdTask(f)
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'owner-claims-limit', usageLimit: true }), /blocked/)
  await assert.rejects(f.runtime.switchAccount(f.session, 'second', { requestId: 'owner-switch' }), /blocked/)
  assert.equal(f.restarts.length, 0)
})

test('a new launch starts on an account with capacity when the native login is exhausted', async () => {
  const f = await usageLimitFixture()
  const selection = f.runtime.launchSelection({ channelId: 'CNEW', provider: 'claude' })
  assert.deepEqual({ ...selection, accountId: undefined }, { account: 'second', accountKind: 'legacy-claude', accountId: undefined, email: 'secondary@example.test' })
  assert.match(selection.accountId, /^acct_/)
  assert.equal(f.runtime.launchSelection({ channelId: 'CNEW', provider: 'codex' }), null)
  const healthy = await usageLimitFixture({ quota: { primary: 40, secondary: 10 } })
  assert.equal(healthy.runtime.launchSelection({ channelId: 'CNEW', provider: 'claude' }), null, 'a ready native login is kept')
  const manual = setup({ mode: 'manual' })
  assert.equal(manual.runtime.launchSelection({ channelId: 'CNEW', provider: 'claude' }), null)
})

test('an uncertain usage-limit handover halts the others until it is reconciled', async () => {
  const logs = []
  const f = await usageLimitFixture({ log: (...args) => logs.push(args), restart: async (current, alias, options) => {
    current.account = alias; current.pid = 200
    if (options.usageLimit && current.channel === 'CMINE') throw new Error('resume never became ready')
  } })
  holdTask(f)
  const second = { id: 'native-two', channel: 'CTWO', pid: 102, tmux: 'sab-two', cwd: '/two', model: 'opus', effort: 'max', launchFlags: '--dsp' }
  f.state.sessions[second.id] = second; f.state.channels.CTWO = second.id
  f.state.accountPools.proofs = { ...f.state.accountPools.proofs }
  await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.phase, 'interrupted')
  assert.equal(f.state.accountPools.switches.CTWO, undefined, 'the next exhausted session waits')
  assert.ok(logs.some(args => /halted/.test(args[0])))
  await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CTWO, undefined)
  await f.runtime.reconcile(f.session, { requestId: f.state.accountPools.switches.CMINE.requestId })
  await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CTWO.phase, 'committed')
})

test('a usage limit, not the reservation estimate, decides whether held work moves', async () => {
  const f = await usageLimitFixture({ quota: { primary: 89, secondary: 10 } })
  holdTask(f)
  assert.equal(f.runtime.status('CMINE').decision.candidates.find(c => c.reason === 'headroom-exhausted') !== undefined, true,
    'the estimate calls the account exhausted')
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0, 'held work stays while the account itself still has headroom')
})

test('a rejected usage-limit handover retries after 2 min and is announced once', async () => {
  let time = now, idle = false
  const logs = []
  const f = await usageLimitFixture({ now: () => time, log: (...args) => logs.push(args),
    readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: time, identity: { email: account.email, principalId: account.id },
      quota: { five_hour: { utilization: account.key === 'primary' ? 99 : 10, resets_at: new Date(time + 3600000).toISOString() } } }),
    restart: async (current, alias, options) => {
      if (options.usageLimit && !idle) throw Object.assign(new Error('account_limit_menu_not_dismissed'), { accountPreflightRejected: true })
      current.account = alias; current.pid = 200
    } })
  holdTask(f)
  await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.phase, 'rejected')
  assert.deepEqual(f.notices.map(n => n.notice), ["Account handover was rejected before teardown: Claude's usage-limit chooser did not close. " +
    'The existing provider was not stopped. If it is still needed, SAB retries automatically in 2 min.'])
  time += 60000; await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.attempt, undefined, 'no attempt inside the window')
  time += 2 * 60000; await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.attempt, 2)
  assert.equal(f.notices.length, 1, 'a repeated usage-limit rejection is logged, not announced')
  assert.ok(logs.some(args => /rejected again/.test(args[0])))
  idle = true; time += 5 * 60000; await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.phase, 'committed')
})

test('the usage-limit halt is durable across a daemon restart and ends when the channel is reconciled', async () => {
  const f = await usageLimitFixture({ restart: async (current, alias, options) => {
    current.account = alias; current.pid = 200
    if (options.usageLimit && current.channel === 'CMINE') throw new Error('resume never became ready')
  } })
  holdTask(f)
  await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.phase, 'interrupted')
  const disk = structuredClone(f.state)
  const second = { id: 'native-two', channel: 'CTWO', pid: 102, tmux: 'sab-two', cwd: '/two', model: 'opus', effort: 'max', launchFlags: '--dsp' }
  disk.sessions[second.id] = second; disk.channels.CTWO = second.id
  const restarted = setup({ mode: 'auto', initialState: disk, readRegistry: () => f.registry, blockReason: heldWork, usageLimitBlockReason: async () => null,
    readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: now, identity: { email: account.email, principalId: account.id },
      quota: { five_hour: { utilization: account.key === 'primary' ? 99 : 10, resets_at: new Date(now + 3600000).toISOString() } } }) })
  await restarted.runtime.tick()
  assert.equal(restarted.state.accountPools.switches.CTWO, undefined, 'the halt survived the restart')
  await restarted.runtime.reconcile(restarted.session, { requestId: restarted.state.accountPools.switches.CMINE.requestId })
  await restarted.runtime.tick()
  assert.equal(restarted.state.accountPools.switches.CTWO.phase, 'committed')
})

test('concurrent reconciles of one handover settle it once', async () => {
  const f = await usageLimitFixture({ restart: async (current, alias, options) => {
    current.account = alias; current.pid = 200
    if (options.usageLimit) throw new Error('resume never became ready')
  } })
  holdTask(f)
  await f.runtime.tick()
  const requestId = f.state.accountPools.switches.CMINE.requestId
  f.settled.length = 0
  const results = await Promise.allSettled([1, 2].map(() => f.runtime.reconcile(f.session, { requestId })))
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(f.settled.length, 1)
})

const primaryId = f => publicAccountRegistry(f.registry).accounts.find(a => a.key === 'primary').id

test('a paused turn resumes in place only with a pause marker and a newer reading of its own account', async () => {
  const resumed = []
  const f = await usageLimitFixture({ quota: { primary: 40, secondary: 10 }, resumeAfterLimit: async session => { resumed.push(session.id); return true } })
  holdTask(f)
  await f.runtime.tick()
  assert.deepEqual(resumed, [], 'pane text alone never resumes: no marker, no resume')
  f.session.usageLimitPause = { at: now + 1, accountId: primaryId(f) }
  await f.runtime.tick()
  assert.deepEqual(resumed, [], 'the reading predates the pause')
  f.session.usageLimitPause = { at: now - 1, accountId: primaryId(f) }
  await f.runtime.tick()
  assert.deepEqual(resumed, [f.session.id])
  assert.equal(f.restarts.length, 0, 'an in-place resume restarts nothing')
  assert.equal(f.session.account, null)
})

test('a pause marker for another account is dropped, never acted on', async () => {
  const resumed = []
  const f = await usageLimitFixture({ quota: { primary: 40, secondary: 10 }, resumeAfterLimit: async session => { resumed.push(session.id); return true } })
  holdTask(f)
  f.session.usageLimitPause = { at: now - 1, accountId: 'acct_elsewhere' }
  await f.runtime.tick()
  assert.deepEqual(resumed, [])
  assert.equal(f.session.usageLimitPause, undefined)
})

test('an exhausted account records the pause and is handed over, never resumed in place', async () => {
  const resumed = [], marked = []
  const f = await usageLimitFixture({ resumeAfterLimit: async session => { resumed.push(session.id); return true },
    markLimitPause: async (session, accountId) => { marked.push(accountId); return true } })
  holdTask(f)
  await f.runtime.tick()
  assert.deepEqual(marked, [primaryId(f)])
  assert.deepEqual(resumed, [])
  assert.equal(f.restarts.length, 1)
  assert.equal(f.restarts[0].usageLimit, true)
})

test('the pool reports measured exhaustion only in auto mode and only for the session\'s own account', async () => {
  const f = await usageLimitFixture()
  assert.equal(f.runtime.measuredExhaustion(f.session).accountId, primaryId(f))
  const healthy = await usageLimitFixture({ quota: { primary: 40, secondary: 10 } })
  assert.equal(healthy.runtime.measuredExhaustion(healthy.session), null)
  assert.equal(setup({ mode: 'manual' }).runtime.measuredExhaustion(f.session), null)
  assert.equal(f.runtime.accountIdFor(f.session), primaryId(f))
})

test('a /sab-new launch, whose channel does not exist yet, starts on the default group\'s account with capacity', async () => {
  const f = await usageLimitFixture()
  const selection = f.runtime.launchSelection({ channelId: null, provider: 'claude' })
  assert.equal(selection.account, 'second')
  assert.equal(selection.email, 'secondary@example.test')
  assert.equal(f.runtime.launchSelection({ channelId: null, provider: 'codex' }), null, 'Codex reports no account to bind')
  const healthy = await usageLimitFixture({ quota: { primary: 40, secondary: 10 } })
  assert.equal(healthy.runtime.launchSelection({ channelId: null, provider: 'claude' }), null)
})

test('a new channel never starts on an account restricted to other channels', () => {
  const registry = compileAccountRegistry({ schemaVersion: 1, requestId: 'restricted-fixture', accounts: [
    { key: 'primary', provider: 'claude', email: 'primary@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
    { key: 'client', provider: 'claude', email: 'client@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'client' }], allowedChannels: ['CCLIENT'] },
  ], groups: [{ key: 'mine', name: 'Mine', members: ['primary', 'client'] }], routing: { defaultGroup: 'mine', channels: {} } }, { legacyAccounts: 'client=PRIVATE-CLIENT\n' })
  const view = publicAccountRegistry(registry)
  const observed = (key, utilization) => normalizeQuotaObservation({ provider: 'claude', observedAt: now,
    identity: { email: `${key}@example.test`, principalId: view.accounts.find(a => a.key === key).id },
    quota: { five_hour: { utilization, resets_at: new Date(now + 3600000).toISOString() } } })
  const observations = Object.fromEntries(view.accounts.map(a => [a.id, observed(a.key, a.key === 'primary' ? 99 : 10)]))
  const primary = view.accounts.find(a => a.key === 'primary').id
  assert.equal(choosePoolAccount(view, { channelId: null, provider: 'claude', currentAccountId: primary, observations, now, newChannel: true }).accountId, null)
  assert.throws(() => choosePoolAccount(view, { channelId: null, provider: 'claude', observations, now }), /invalid_pool_selection/)
  assert.throws(() => choosePoolAccount(view, { channelId: 'CNEW', provider: 'claude', observations, now, newChannel: true }), /invalid_pool_selection/)
})

test('a Codex session holding a task on an exhausted account is handed over like Claude', async () => {
  const record = compileAccountRegistry({ schemaVersion: 1, requestId: 'codex-limit-fixture', accounts: [
    { key: 'primary', provider: 'codex', email: 'primary@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
    { key: 'secondary', provider: 'codex', email: 'secondary@example.test', identityConfirmed: true, credentials: [{ kind: 'codex-profile', profile: 'second' }] },
  ], groups: [{ key: 'mine', name: 'Mine', members: ['primary', 'secondary'] }], routing: { defaultGroup: 'mine', channels: {} } })
  const session = { id: 'codex-native', channel: 'CMINE', provider: 'codex', pid: 500, tmux: 'sab-native', cwd: '/codex',
    model: 'gpt-6-sol', requestedModel: 'gpt-6-sol', effort: 'xhigh', requestedEffort: 'xhigh', launchFlags: '--yolo' }
  const state = { channels: { CMINE: session.id }, sessions: { [session.id]: session } }
  const restarts = []
  let quota = { primary: 10, secondary: 10 }
  const runtime = createAccountPoolRuntime({ state, mode: 'auto', readRegistry: () => record, persist: () => {}, now: () => now,
    blockReason: heldWork, usageLimitBlockReason: async () => null, verifyIdentity: async () => 'verified',
    readQuota: async account => normalizeQuotaObservation({ provider: 'codex', observedAt: now, identity: { email: account.email, principalId: account.id },
      quota: { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: quota[account.key], resetsAt: Math.floor((now + 3600000) / 1000) } } } }),
    restart: async (current, profile, options) => { restarts.push(options); current.account = profile; current.pid = 501 } })
  await runtime.switchAccount(session, 'secondary@example.test', { requestId: 'prove-outward' })
  await runtime.switchAccount(session, 'primary@example.test', { requestId: 'prove-return' })
  restarts.length = 0; quota = { primary: 99, secondary: 10 }
  const f = { state, session }
  const tasks = holdTask(f)
  state.teamTasks['task-held'].targetProvider = 'codex'
  await runtime.tick()
  assert.equal(restarts.length, 1)
  assert.equal(restarts[0].usageLimit, true)
  assert.equal(restarts[0].taskMaintenance.kind, 'usage-limit')
  assert.equal(session.account, 'second')
  tasks['task-held'].targetProvider = 'codex'
  assert.deepEqual(state.teamTasks, tasks)
})

test('an uncertain Codex usage-limit handover never halts Claude handovers', async () => {
  const f = await usageLimitFixture()
  holdTask(f)
  const codex = { id: 'codex-held', channel: 'CCODEXH', provider: 'codex', pid: 600, tmux: 'sab-codex', cwd: '/codex' }
  f.state.sessions[codex.id] = codex; f.state.channels.CCODEXH = codex.id
  f.state.accountPools.switches.CCODEXH = { requestId: 'automatic-codex', channelId: 'CCODEXH', sessionId: codex.id, usageLimit: true,
    phase: 'interrupted', at: now - 1, automatic: true }
  await f.runtime.tick()
  assert.equal(f.state.accountPools.switches.CMINE.phase, 'committed', 'the Claude session still moved')
})
