import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeQuotaObservation, quotaReadiness, choosePoolAccount, nextQuotaPollAt } from '../daemon/account-quota.mjs'
import { compileAccountRegistry, publicAccountRegistry } from '../daemon/account-registry.mjs'

const now = 1800000000000
test('an explicitly unused Claude window has no reset yet; missing or nonzero reset evidence still fails closed', () => {
  const parse = (utilization, resets_at) => normalizeQuotaObservation({ provider: 'claude', observedAt: now,
    identity: { email: 'one@example.test', principalId: 'principal' }, quota: { five_hour: { utilization, resets_at } } })
  const cold = parse(0, null)
  assert.equal(cold.windows[0].inactive, true)
  assert.equal(cold.windows[0].resetsAt, null)
  assert.equal(quotaReadiness(cold, { now }).ready, true)
  assert.equal(quotaReadiness(cold, { now: now + 600001 }).reason, 'stale')
  assert.throws(() => parse(1, null), /invalid_quota/)
  assert.throws(() => parse(0, undefined), /invalid_quota/)
  const malformed = structuredClone(cold); delete malformed.windows[0].inactive
  assert.equal(quotaReadiness(malformed, { now }).ready, false)
  const denied = normalizeQuotaObservation({ provider: 'claude', observedAt: now, identity: cold.identity,
    quota: { five_hour: { utilization: 0, resets_at: null, locked_reason: 'subscription_locked' } } })
  assert.equal(quotaReadiness(denied, { now }).reason, 'backend-denied')
})
const registry = () => publicAccountRegistry(compileAccountRegistry({
  schemaVersion: 1, requestId: 'quota-fixture',
  accounts: [
    { key: 'one', provider: 'claude', email: 'one@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
    { key: 'two', provider: 'claude', email: 'two@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'second' }] },
    { key: 'client', provider: 'claude', email: 'client@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'client' }], allowedChannels: ['CCLIENT'] },
  ],
  groups: [ { key: 'mine', name: 'Mine', members: ['one', 'two'], preferred: { claude: 'one' } },
    { key: 'client', name: 'Client', members: ['client'] } ],
  routing: { defaultGroup: 'mine', channels: { CCLIENT: 'client' } },
}, { legacyAccounts: 'second=fixture-second\nclient=fixture-client\n' }))
const sample = (provider = 'claude', used = 10, overrides = {}) => normalizeQuotaObservation({
  provider, observedAt: now, identity: { email: 'one@example.test', principalId: 'principal-one' },
  quota: provider === 'claude' ? { five_hour: { utilization: used, resets_at: new Date(now + 3600000).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(now + 86400000).toISOString() } }
    : { accountId: 'principal-one', ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: used, resetsAt: (now + 3600000) / 1000, windowDurationMins: 300 } } },
  ...overrides,
})

test('quota normalization retains every window and never stores tokens or arbitrary response fields', () => {
  const observation = sample('claude', 22, { identity: { email: 'one@example.test', principalId: 'principal-one', token: 'NEVER-OUTPUT' },
    quota: { five_hour: { utilization: 22, resets_at: new Date(now + 3600000).toISOString(), token: 'NEVER-OUTPUT' },
      seven_day: { utilization: 99, resets_at: new Date(now + 86400000).toISOString() },
      extra_usage: { is_enabled: true, used_credits: 22, monthly_limit: 100 } } })
  assert.equal(observation.windows.length, 2)
  assert.equal(quotaReadiness(observation, { now }).reason, 'headroom-exhausted')
  assert.doesNotMatch(JSON.stringify(observation), /NEVER-OUTPUT|credits|token/)
  assert.equal(observation.identity.email, 'one@example.test')
})

test('Codex backend denial wins over percentages, and multiple buckets cannot be silently ignored', () => {
  const denied = sample('codex', 1, { quota: { ordinaryUsageAllowed: false, accountId: 'principal-one', rateLimits: { limitId: 'codex', primary: { usedPercent: 1, resetsAt: (now + 3600000) / 1000 } } } })
  assert.equal(quotaReadiness(denied, { now }).reason, 'backend-denied')
  const multiple = sample('codex', 1, { quota: { accountId: 'principal-one', ordinaryUsageAllowed: true,
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 1, resetsAt: (now + 3600000) / 1000 } },
      unknown: { limitId: 'unknown', primary: { usedPercent: 100, resetsAt: (now + 3600000) / 1000 } } } } })
  assert.equal(quotaReadiness(multiple, { now }).ready, false)
  assert.equal(multiple.windows.length, 2)
  assert.throws(() => sample('codex', 1, { quota: { accountId: 'different-account', rateLimits: {} } }), /quota_identity_mismatch/)
})

test('missing, stale, invalid, and past-reset quota observations never imply recovered capacity', () => {
  assert.equal(quotaReadiness(null, { now }).reason, 'unknown')
  assert.equal(quotaReadiness(sample(), { now: now + 600001 }).reason, 'stale')
  assert.equal(quotaReadiness(sample(), { now: now - 1000 }).reason, 'future-observation')
  const expired = sample('claude', 1, { quota: { five_hour: { utilization: 1, resets_at: new Date(now - 1).toISOString() } } })
  assert.equal(quotaReadiness(expired, { now }).reason, 'reset-needs-refresh')
  for (const utilization of [NaN, Infinity, -1, 101, '20']) {
    assert.throws(() => sample('claude', 1, { quota: { five_hour: { utilization, resets_at: new Date(now + 1000).toISOString() } } }), /invalid_quota/)
  }
  const noData = sample('claude', 0, { quota: {} })
  assert.equal(quotaReadiness(noData, { now }).reason, 'quota-unavailable')
})

test('selection is sticky, capacity-aware, and cannot escape exact group/channel policy', () => {
  const view = registry(), [client, one, two] = ['client', 'one', 'two'].map(key => view.accounts.find(a => a.key === key))
  const quota = (account, used) => sample('claude', used, { identity: { email: account.email, principalId: account.id } })
  const observations = { [one.id]: quota(one, 70), [two.id]: quota(two, 10), [client.id]: quota(client, 0) }
  const options = { channelId: 'CMINE', provider: 'claude', currentAccountId: one.id, observations, now }
  assert.equal(choosePoolAccount(view, options).accountId, one.id)
  observations[one.id] = quota(one, 99)
  const decision = choosePoolAccount(view, options)
  assert.equal(decision.accountId, two.id)
  assert.equal(decision.reason, 'capacity-handover')
  assert.equal(choosePoolAccount(view, { ...options, channelId: 'CCLIENT', currentAccountId: client.id }).accountId, client.id)
  assert.notEqual(decision.accountId, client.id)
  observations[two.id] = quota(two, 100)
  assert.equal(choosePoolAccount(view, options).status, 'exhausted')
  assert.equal(choosePoolAccount(view, options).nextResetAt, now + 3600000)
})

test('switch-back requires a fresh reset, minimum benefit, and cooldown; concurrent reservations consume headroom', () => {
  const view = registry(), one = view.accounts.find(a => a.key === 'one'), two = view.accounts.find(a => a.key === 'two')
  const observations = Object.fromEntries([one, two].map(a => [a.id, sample('claude', a === one ? 0 : 60, { identity: { email: a.email, principalId: a.id } })]))
  const options = { channelId: 'CMINE', provider: 'claude', currentAccountId: two.id, observations, now,
    preferredAccountId: one.id, resetConfirmedAfter: now - 100, lastSwitchedAt: now - 3600000 }
  assert.equal(choosePoolAccount(view, options).reason, 'preferred-recovered')
  assert.equal(choosePoolAccount(view, { ...options, lastSwitchedAt: now - 100 }).accountId, two.id)
  assert.equal(choosePoolAccount(view, { ...options, resetConfirmedAfter: now + 100 }).accountId, two.id)
  assert.equal(choosePoolAccount(view, { ...options, reservations: { [one.id]: 90 } }).accountId, two.id)
  observations[one.id].identity.email = 'wrong@example.test'
  assert.equal(choosePoolAccount(view, options).accountId, two.id)
})

test('shared quota principals share reservations; missing proof cannot become an automatic candidate', () => {
  const view = registry(), one = view.accounts.find(a => a.key === 'one'), two = view.accounts.find(a => a.key === 'two')
  const observations = Object.fromEntries([one, two].map(a => [a.id, sample('claude', 10, { identity: { email: a.email, principalId: 'shared-subscription' } })]))
  const options = { channelId: 'CMINE', provider: 'claude', observations, now, reservations: { [one.id]: 90 } }
  assert.equal(choosePoolAccount(view, options).status, 'exhausted')
  observations[one.id].status = 'scope-unavailable'
  delete observations[two.id]
  assert.equal(choosePoolAccount(view, { ...options, reservations: {} }).status, 'unknown')
})

test('poll schedule is bounded, backs off failures, and rechecks actual reset instead of guessing', () => {
  const observation = sample()
  assert.ok(nextQuotaPollAt(observation, { now, jitter: 0 }) > now)
  assert.ok(nextQuotaPollAt(observation, { now, failures: 10, jitter: 0 }) <= now + 3600000)
  assert.equal(nextQuotaPollAt({ ...observation, windows: [{ usedPercent: 100, resetsAt: now - 1 }] }, { now, jitter: 0 }), now + 60000)
})
