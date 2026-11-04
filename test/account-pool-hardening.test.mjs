import test from 'node:test'
import assert from 'node:assert/strict'
import { compileAccountRegistry } from '../daemon/account-registry.mjs'
import { normalizeQuotaObservation } from '../daemon/account-quota.mjs'
import { createAccountPoolRuntime, launchCheckNotice, nativeIdentityNotice } from '../daemon/account-pool-runtime.mjs'

const start = 1800000000000
// Both main accounts are full Claude profiles, as SAB's own logins are; the
// third is a legacy token, whose identity SAB cannot verify.
const enrollment = () => ({ schemaVersion: 1, requestId: 'hardening-fixture', accounts: [
  { key: 'busy', provider: 'claude', email: 'busy@example.test', identityConfirmed: true,
    credentials: [{ kind: 'native-default' }, { kind: 'claude-profile', profile: 'busy' }] },
  { key: 'spare', provider: 'claude', email: 'spare@example.test', identityConfirmed: true, credentials: [{ kind: 'claude-profile', profile: 'spare' }] },
  { key: 'token', provider: 'claude', email: 'token@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'token' }] },
], groups: [{ key: 'mine', name: 'Mine', members: ['busy', 'spare', 'token'], preferred: { claude: 'busy' } }],
routing: { defaultGroup: 'mine', channels: {} } })
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

function setup({ quota = { busy: 100, spare: 10, token: 100 }, ...overrides } = {}) {
  const registry = compileAccountRegistry(enrollment(), { legacyAccounts: 'token=PRIVATE-TOKEN\n' })
  let time = start
  const session = { id: 'native-one', channel: 'CMINE', cwd: '/work', tmux: 'sab-one', pid: 100, model: 'opus', effort: 'max',
    launchFlags: '--dsp', account: 'busy', accountKind: 'claude-profile' }
  // A second session, already on the spare profile: its start is evidence that login launches.
  const helper = { id: 'native-helper', channel: 'CHELP', cwd: '/help', tmux: 'sab-help', pid: null, model: 'opus', effort: 'max',
    launchFlags: '--dsp', account: 'spare', accountKind: 'claude-profile' }
  const state = { channels: { CMINE: session.id, CHELP: helper.id }, sessions: { [session.id]: session, [helper.id]: helper } }
  const restarts = [], owner = [], notices = [], logs = []
  const runtime = createAccountPoolRuntime({ state, mode: 'auto', readRegistry: () => registry, persist: () => {}, now: () => time,
    readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: time,
      identity: { email: account.email, principalId: account.id },
      quota: { five_hour: { utilization: quota[account.key] ?? 10, resets_at: new Date(time + 3600000).toISOString() } } }),
    blockReason: () => null, usageLimitBlockReason: async () => null, verifyIdentity: async () => 'verified',
    restart: async (current, alias, options) => {
      restarts.push({ channel: current.channel, alias, usageLimit: options.usageLimit, taskMaintenance: options.taskMaintenance })
      current.account = alias; current.accountKind = 'claude-profile'; current.pid = 200
    },
    notify: async (channel, notice) => { notices.push({ channel, notice }) },
    notifyOwner: async message => { owner.push(message) },
    log: (...args) => logs.push(args), ...overrides })
  const account = key => runtime.inventory().registry.accounts.find(a => a.key === key)
  return { runtime, state, session, helper, restarts, owner, notices, logs, account, advance: ms => { time += ms }, at: () => time }
}

function holdTask(f, { status = 'running' } = {}) {
  f.session.teamActiveTaskId = 'task-held'
  f.state.teams = { team: { id: 'team', coordinatorChannel: 'CCOORD', members: { CMINE: { role: 'worker' } } } }
  f.state.teamTasks = { 'task-held': { id: 'task-held', teamId: 'team', status, completionPolicy: 'coordinator-release',
    sourceChannel: 'CCOORD', targetSessionId: f.session.id, targetChannel: 'CMINE', targetProvider: 'claude',
    workGeneration: 2, providerWorkGeneration: 2, messages: [], replies: [], reports: [{ workGeneration: 2, deliveryStatus: 'delivered' }] } }
  return structuredClone(f.state.teamTasks)
}

test('an automatic usage-limit move needs no proof for its pair of accounts, only evidence that the target login starts', async () => {
  const f = setup()
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0, 'nothing has shown that the spare login starts')
  assert.equal(f.runtime.status('CMINE').waiting, 'launch-check:pending')
  f.runtime.noteLaunch(f.helper)
  await f.runtime.tick()
  assert.equal(f.restarts.length, 1)
  assert.equal(f.restarts[0].usageLimit, true)
  assert.equal(f.session.account, 'spare')
  assert.deepEqual(f.state.accountPools.proofs, {}, 'no pair proof was involved')
  assert.equal(f.runtime.status('CMINE').waiting, null)
})

test('a committed, verified switch onto a login is its launch evidence too', async () => {
  const f = setup({ quota: { busy: 50, spare: 10, token: 100 } })
  await f.runtime.ownerSwitch(f.session, 'spare', { requestId: 'by-hand' })
  assert.equal(f.state.accountPools.launchChecks[f.account('spare').id].ok, true)
  assert.equal(f.state.accountPools.launchChecks[f.account('spare').id].source, 'switch')
})

test('launch evidence older than a day is renewed by SAB\'s own hidden launch before a move', async () => {
  const probes = []
  const f = setup({ probeLaunch: async account => { probes.push(account.key); return { ok: true } } })
  f.runtime.noteLaunch(f.helper)
  f.advance(25 * 3600000)
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0, 'day-old evidence does not move anything')
  for (let i = 0; i < 4 && !f.restarts.length; i++) { await settle(); await f.runtime.tick() }
  assert.ok(probes.includes('spare'))
  assert.ok(!probes.includes('token'), 'a legacy token is never launched by SAB')
  assert.equal(new Set(probes).size, probes.length, 'each login is checked once')
  assert.equal(f.restarts.length, 1)
})

test('a login that fails its launch check is reported once, keeps sessions off it, and is checked again after 30 minutes', async () => {
  const probes = []
  let answer = { ok: false, reason: 'terms' }
  const f = setup({ probeLaunch: async account => { probes.push(account.key); return account.key === 'spare' ? answer : { ok: true } } })
  for (let i = 0; i < 3; i++) { await f.runtime.tick(); await settle() }
  assert.equal(f.restarts.length, 0)
  const failures = () => f.owner.filter(message => message.startsWith("⚠️ SAB couldn't start Claude"))
  assert.deepEqual(failures(), [launchCheckNotice(f.account('spare'), 'terms')])
  assert.match(failures()[0], /asked to accept updated terms/)
  assert.match(failures()[0], /CLAUDE_CONFIG_DIR=~\/\.config\/ccs\/account-auth\/claude\/spare claude/)
  assert.equal(f.runtime.status('CMINE').waiting, 'launch-check:terms')
  const checked = () => probes.filter(key => key === 'spare').length, before = checked()
  f.advance(10 * 60000); await f.runtime.tick(); await settle()
  assert.equal(checked(), before, 'no new check inside 30 minutes')
  f.advance(25 * 60000); await f.runtime.tick(); await settle()
  assert.equal(checked(), before + 1)
  assert.equal(failures().length, 1, 'the same failure is not announced again')
  answer = { ok: true }
  f.advance(31 * 60000); await f.runtime.tick(); await settle(); await f.runtime.tick()
  assert.equal(f.restarts.length, 1)
})

test('a check skipped while the login is busy records nothing and runs again', async () => {
  let skip = true
  const f = setup({ probeLaunch: async account => account.key === 'spare' && skip ? { skipped: true } : { ok: true } })
  for (let i = 0; i < 3; i++) { await f.runtime.tick(); await settle() }
  assert.equal(f.state.accountPools.launchChecks[f.account('spare').id], undefined)
  assert.equal(f.owner.filter(message => message.startsWith("⚠️ SAB couldn't")).length, 0)
  skip = false
  for (let i = 0; i < 3 && !f.restarts.length; i++) { await f.runtime.tick(); await settle() }
  assert.equal(f.restarts.length, 1)
})

test('an upgrade counts committed, verified switches at the current registry revision as launch evidence, and no older ones', async () => {
  for (const current of [true, false]) {
    const f = setup()
    const revision = f.runtime.inventory().registryRevision
    f.state.accountPools = { schemaVersion: 1, observations: {}, bindings: {}, switches: {}, proofs: {}, receipts: { earlier: {
      phase: 'committed', identityVerified: true, registryRevision: current ? revision : revision - 1, targetAccountId: f.account('spare').id,
      completedAt: f.at() - 3600000, channelId: 'COLD', sessionId: 'old', requestId: 'old', digest: 'x' } } }
    await f.runtime.tick()
    assert.equal(f.restarts.length, current ? 1 : 0)
  }
})

test('a legacy token login never earns automatic moves from a session start, as before', async () => {
  const f = setup({ quota: { busy: 100, spare: 100, token: 10 } })
  const tokenSession = { id: 'native-token', channel: 'CTOK', cwd: '/t', tmux: 'sab-tok', pid: null, model: 'opus', effort: 'max',
    launchFlags: '--dsp', account: 'token', accountKind: 'legacy-claude' }
  f.state.sessions[tokenSession.id] = tokenSession; f.state.channels.CTOK = tokenSession.id
  f.runtime.noteLaunch(tokenSession)
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0)
  assert.equal(f.state.accountPools.launchChecks[f.account('token').id], undefined)
})

test('evidence for another credential reference of the account does not count', async () => {
  const f = setup()
  f.runtime.noteLaunch(f.helper)
  f.state.accountPools.launchChecks[f.account('spare').id].credential = 'claude-profile:retired'
  await f.runtime.tick()
  assert.equal(f.restarts.length, 0)
})

test('sessions with nowhere to go are reported once, with the next reset, after two minutes', async () => {
  const f = setup({ quota: { busy: 100, spare: 100, token: 100 } })
  await f.runtime.tick(); await settle()
  assert.equal(f.runtime.status('CMINE').waiting, 'no-capacity')
  assert.equal(f.owner.length, 0, 'a brief wait stays quiet')
  f.advance(3 * 60000); await f.runtime.tick(); await settle()
  assert.equal(f.owner.length, 1)
  assert.match(f.owner[0], /^⏳ 1 session on \*busy@example\.test\* is at its usage limit, and no account in the group has capacity left\. The next reset is <!date\^\d+\^\{date_short_pretty\} at \{time\}\|[^>]+>; SAB moves it then\.$/)
  f.advance(10 * 60000); await f.runtime.tick(); await settle()
  assert.equal(f.owner.length, 1, 'once per episode')
  assert.equal(f.logs.filter(args => args[0] === 'usage-limit move waiting').length, 1, 'one log line per change')
})

test('a stuck episode ends when its sessions move, so a later one is reported again', async () => {
  let quota = { busy: 100, spare: 100, token: 100 }
  const g = setup({ quota: undefined, readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: g.at(),
    identity: { email: account.email, principalId: account.id },
    quota: { five_hour: { utilization: quota[account.key], resets_at: new Date(g.at() + 3600000).toISOString() } } }) })
  g.runtime.noteLaunch(g.helper)
  g.advance(3 * 60000); await g.runtime.tick(); g.advance(3 * 60000); await g.runtime.tick(); await settle()
  assert.equal(g.owner.length, 1)
  quota = { busy: 100, spare: 10, token: 100 }
  g.advance(6 * 60000); await g.runtime.tick(); await settle()
  assert.equal(g.restarts.length, 1)
  assert.deepEqual(g.state.accountPools.waitingNotices, {}, 'the episode is over')
})

test('a session at its limit that stays blocked is reported after 15 minutes; a turn still running below 100% is a normal wait', async () => {
  const blocked = setup({ usageLimitBlockReason: async () => 'automation setup in progress' })
  blocked.runtime.noteLaunch(blocked.helper)
  await blocked.runtime.tick()
  assert.equal(blocked.runtime.status('CMINE').waiting, 'blocked:automation setup in progress')
  blocked.advance(10 * 60000); await blocked.runtime.tick(); await settle()
  assert.equal(blocked.owner.length, 0)
  blocked.advance(6 * 60000); await blocked.runtime.tick(); await settle()
  assert.deepEqual(blocked.owner, ['⏳ 1 session on *busy@example.test* is at its usage limit but can\'t move yet: <#CMINE> (automation setup in progress).'])

  const below = setup({ quota: { busy: 95, spare: 10, token: 100 }, usageLimitBlockReason: async () => 'turn in progress' })
  below.runtime.noteLaunch(below.helper)
  for (const minutes of [0, 20, 20]) { below.advance(minutes * 60000); await below.runtime.tick(); await settle() }
  assert.equal(below.runtime.status('CMINE').waiting, 'blocked:turn in progress')
  assert.equal(below.owner.length, 0, 'a turn still working below the hard limit is not news')

  const stuck = setup({ usageLimitBlockReason: async () => 'turn in progress' })
  stuck.runtime.noteLaunch(stuck.helper)
  for (const minutes of [0, 20]) { stuck.advance(minutes * 60000); await stuck.runtime.tick(); await settle() }
  assert.equal(stuck.owner.length, 1, 'a turn "running" on an account at 100% is reported')
})

test('the status names the measured-capacity target once the current account is out and the estimate is spent', async () => {
  const f = setup({ blockReason: session => session.teamActiveTaskId ? 'delegated team task in progress' : null })
  for (let i = 0; i < 20; i++) {
    const other = { id: `other-${i}`, channel: `COTHER${i}`, pid: 300 + i, tmux: `sab-other-${i}`, cwd: '/o', account: 'spare', accountKind: 'claude-profile', teamActiveTaskId: 'elsewhere' }
    f.state.sessions[other.id] = other; f.state.channels[other.channel] = other.id
  }
  await f.runtime.refresh('busy'); await f.runtime.refresh('spare')
  const info = f.runtime.status('CMINE')
  assert.equal(info.decision.accountId, null, 'the estimate alone finds no capacity')
  assert.equal(info.measured.accountId, f.account('spare').id)
  assert.equal(info.accounts.find(a => a.id === f.account('spare').id).launch.ready, false)
})

test("a Mac login signed in to another account is reported once and is never used for new sessions", async () => {
  let email = 'stranger@example.test'
  const f = setup({ quota: { busy: 10, spare: 10, token: 100 }, nativeLoginIdentity: async () => ({ email }) })
  assert.equal(f.runtime.launchSelection({ channelId: 'CNEW', provider: 'claude' }), null, 'before the check, a ready native login is kept')
  await f.runtime.tick(); await settle()
  assert.deepEqual(f.owner, [nativeIdentityNotice({ observed: 'stranger@example.test', expected: 'busy@example.test' })])
  const selection = f.runtime.launchSelection({ channelId: 'CNEW', provider: 'claude' })
  assert.equal(selection.accountKind, 'claude-profile', 'a new session starts through a profile, not the Mac login')
  await f.runtime.tick(); await settle()
  assert.equal(f.owner.length, 1, 'once per episode')
  email = 'BUSY@example.test'
  await f.runtime.tick()
  assert.equal(f.state.accountPools.nativeIdentity, undefined)
  assert.equal(f.runtime.launchSelection({ channelId: 'CNEW', provider: 'claude' }), null)
  assert.ok(f.logs.some(args => args[0] === 'native Claude login matches the registry again'))
})

test('an unreadable Mac login changes nothing', async () => {
  const f = setup({ quota: { busy: 10, spare: 10, token: 100 }, nativeLoginIdentity: async () => { throw new Error('unreadable') } })
  await f.runtime.tick(); await settle()
  assert.equal(f.state.accountPools.nativeIdentity, undefined)
  assert.equal(f.owner.length, 0)
})

test("an owner's switch of a session stopped at its usage limit takes the usage-limit path; otherwise it names the rule that blocks it", async () => {
  let atLimit = false
  const f = setup({ blockReason: session => session.teamActiveTaskId ? 'delegated team task in progress' : null, atUsageLimit: async () => atLimit })
  const tasks = holdTask(f)
  await f.runtime.refresh('busy'); await f.runtime.refresh('spare')
  await assert.rejects(f.runtime.ownerSwitch(f.session, 'spare', { requestId: 'plain' }),
    error => error.message === 'account_switch_blocked' && error.blockReason === 'delegated team task in progress')
  assert.equal(f.restarts.length, 0)
  atLimit = true
  const result = await f.runtime.ownerSwitch(f.session, 'spare', { requestId: 'at-limit' })
  assert.equal(result.status, 'committed')
  assert.equal(f.restarts[0].usageLimit, true)
  assert.equal(f.restarts[0].taskMaintenance.kind, 'usage-limit')
  assert.deepEqual(f.state.teamTasks, tasks, 'the task is unchanged')
})

test("an owner's switch on an account that still has capacity keeps the ordinary safe boundary", async () => {
  const f = setup({ quota: { busy: 50, spare: 10, token: 100 }, blockReason: () => 'turn in progress', atUsageLimit: async () => true })
  await f.runtime.refresh('busy'); await f.runtime.refresh('spare')
  await assert.rejects(f.runtime.ownerSwitch(f.session, 'spare', { requestId: 'busy-turn' }), error => error.blockReason === 'turn in progress')
  await assert.rejects(f.runtime.switchAccount(f.session, 'spare', { requestId: 'claimed-limit', usageLimit: true }),
    error => error.blockReason === 'the turn has not stopped at a measured usage limit')
  assert.equal(f.restarts.length, 0)
})

test('a refusal from the usage-limit rule names its reason', async () => {
  const f = setup({ usageLimitBlockReason: async () => 'question awaiting an answer', atUsageLimit: async () => true })
  await f.runtime.refresh('busy'); await f.runtime.refresh('spare')
  await assert.rejects(f.runtime.ownerSwitch(f.session, 'spare', { requestId: 'question' }), error => error.blockReason === 'question awaiting an answer')
})

test('a session start on the Mac login is evidence for its account only while that login is the expected account', async () => {
  for (const mismatch of [false, true]) {
    const registry = compileAccountRegistry({ ...enrollment(), accounts: enrollment().accounts.map(a => a.key === 'busy'
      ? { ...a, credentials: [{ kind: 'native-default' }] } : a) }, { legacyAccounts: 'token=PRIVATE-TOKEN\n' })
    const native = { id: 'native-mac', channel: 'CMAC', cwd: '/m', tmux: 'sab-mac', pid: null, model: 'opus', effort: 'max', launchFlags: '--dsp' }
    const state = { channels: { CMAC: native.id }, sessions: { [native.id]: native } }
    const runtime = createAccountPoolRuntime({ state, mode: 'auto', readRegistry: () => registry, persist: () => {}, now: () => start,
      readQuota: async account => normalizeQuotaObservation({ provider: 'claude', observedAt: start, identity: { email: account.email, principalId: account.id },
        quota: { five_hour: { utilization: 10, resets_at: new Date(start + 3600000).toISOString() } } }),
      nativeLoginIdentity: async () => ({ email: mismatch ? 'stranger@example.test' : 'busy@example.test' }) })
    await runtime.tick()
    runtime.noteLaunch(native)
    const busy = runtime.inventory().registry.accounts.find(a => a.key === 'busy')
    assert.equal(Boolean(state.accountPools.launchChecks?.[busy.id]), !mismatch, mismatch ? 'another account\'s login proves nothing' : 'the expected login counts')
  }
})

test('an automatic switch is refused before any journal when the target login has no launch evidence', async () => {
  const f = setup()
  await f.runtime.refresh('busy'); await f.runtime.refresh('spare')
  await assert.rejects(f.runtime.switchAccount(f.session, 'spare', { requestId: 'automatic-direct', automatic: true, usageLimit: true }),
    error => error.message === 'account_launch_unchecked')
  assert.deepEqual(f.state.accountPools.receipts, {}, 'nothing was journaled')
  assert.equal(f.restarts.length, 0)
})

test('the monitor does not inspect a session it cannot move for want of launch evidence', async () => {
  let inspected = 0
  const f = setup({ usageLimitBlockReason: async () => { inspected++; return null } })
  await f.runtime.tick(); await f.runtime.tick()
  assert.equal(inspected, 0, 'no pane check for a move that cannot happen')
  f.runtime.noteLaunch(f.helper)
  await f.runtime.tick()
  assert.equal(inspected, 1)
  assert.equal(f.restarts.length, 1)
})
