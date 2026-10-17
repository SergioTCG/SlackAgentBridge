// Subscription capacity is independent of transcript token/cost telemetry.
// Unknown, stale, or past-reset evidence never grants capacity.
const finite = n => typeof n === 'number' && Number.isFinite(n)
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_.:@/-]{1,256}$/.test(value)
const fail = code => { throw new Error(code) }

export function normalizeQuotaObservation({ provider, identity, quota, observedAt = Date.now() }) {
  if (!['claude', 'codex'].includes(provider) || !finite(observedAt) || !identity ||
      typeof identity.email !== 'string' || identity.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(identity.email) ||
      !safeId(identity.principalId) || !quota || typeof quota !== 'object' || Array.isArray(quota)) fail('invalid_quota')
  if (provider === 'codex' && quota.accountId != null && quota.accountId !== identity.principalId) fail('quota_identity_mismatch')
  const windows = []
  const add = (bucket, name, usedPercent, resetsAt, inactive = false) => {
    if (!safeId(bucket) || !finite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
        !(inactive && usedPercent === 0 && resetsAt === null) && (!finite(resetsAt) || resetsAt <= 0) || windows.length >= 64) fail('invalid_quota')
    windows.push({ bucket, name, usedPercent, resetsAt, ...(inactive ? { inactive: true } : {}) })
  }
  let denied = false
  if (provider === 'claude') {
    for (const name of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet']) {
      const value = quota[name]
      if (value == null) continue
      if (value.locked_reason) denied = true
      const inactive = value.utilization === 0 && value.resets_at === null
      add('claude', name, value.utilization, inactive ? null : typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN, inactive)
    }
  } else {
    const buckets = { ...(quota.rateLimitsByLimitId || {}) }
    if (quota.rateLimits) buckets[quota.rateLimits.limitId || 'codex'] = quota.rateLimits
    if (Object.keys(buckets).length > 32) fail('invalid_quota')
    for (const [name, bucket] of Object.entries(buckets)) {
      if (!bucket || typeof bucket !== 'object') fail('invalid_quota')
      if (bucket.rateLimitReachedType) denied = true
      for (const window of ['primary', 'secondary']) {
        const value = bucket[window]
        if (value == null) continue
        add(name, window, value.usedPercent, finite(value.resetsAt) ? value.resetsAt * 1000 : NaN)
      }
    }
  }
  return { provider, observedAt, status: 'observed', identity: { email: identity.email.toLowerCase(), principalId: identity.principalId },
    ordinaryUsageAllowed: provider === 'claude' ? true : (typeof quota.ordinaryUsageAllowed === 'boolean' ? quota.ordinaryUsageAllowed : null),
    backendDenied: denied, windows }
}

export function quotaReadiness(observation, { now = Date.now(), maxAgeMs = 600000, headroomPercent = 10, reservedPercent = 0 } = {}) {
  const result = reason => ({ ready: false, reason, headroom: null })
  if (!observation) return result('unknown')
  if (observation.status !== 'observed') return result(observation.status || 'unknown')
  if (!finite(observation.observedAt) || observation.observedAt > now) return result('future-observation')
  if (now - observation.observedAt > maxAgeMs) return result('stale')
  if (observation.ordinaryUsageAllowed === false || observation.backendDenied) return result('backend-denied')
  if (observation.ordinaryUsageAllowed !== true) return result('backend-permission-unknown')
  if (!Array.isArray(observation.windows) || !observation.windows.length) return result('quota-unavailable')
  if (!finite(reservedPercent) || reservedPercent < 0) return result('invalid-reservation')
  if (observation.windows.some(w => !(w.inactive === true && w.usedPercent === 0 && w.resetsAt === null) && (!finite(w.resetsAt) || w.resetsAt <= now))) return result('reset-needs-refresh')
  if (observation.windows.some(w => !finite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) return result('invalid-quota')
  const headroom = Math.min(...observation.windows.map(w => 100 - w.usedPercent)) - reservedPercent
  return headroom > headroomPercent ? { ready: true, reason: 'capacity', headroom }
    : { ready: false, reason: 'headroom-exhausted', headroom }
}

export function choosePoolAccount(registry, { channelId, provider, currentAccountId = null, preferredAccountId = null,
  observations = {}, reservations = {}, now = Date.now(), lastSwitchedAt = 0,
  resetConfirmedAfter = Infinity, cooldownMs = 900000, minBenefitPercent = 20,
} = {}) {
  if (!/^[CG][A-Z0-9]{1,32}$/.test(channelId || '') || !['claude', 'codex'].includes(provider)) fail('invalid_pool_selection')
  const groupId = registry.routing.channels[channelId] || registry.routing.defaultGroupId
  const group = registry.groups.find(g => g.id === groupId)
  if (!group) fail('invalid_pool_selection')
  const candidates = registry.accounts.filter(a => group.members.includes(a.id) && a.provider === provider &&
    (a.allowedChannels === null || a.allowedChannels.includes(channelId)))
  const principalReservations = new Map()
  for (const [id, percent] of Object.entries(reservations)) {
    if (!finite(percent) || percent < 0) fail('invalid_pool_reservation')
    const principal = observations[id]?.identity?.principalId
    if (principal) principalReservations.set(principal, (principalReservations.get(principal) || 0) + percent)
  }
  const choices = candidates.map(a => {
    const observation = observations[a.id]
    const expectedIdentity = observation?.provider === provider && observation.identity?.email?.toLowerCase() === a.email.toLowerCase() &&
      (!a.workspaceId || observation.identity?.principalId === a.workspaceId)
    const draining = a.lifecycle && a.lifecycle !== 'active' || group.drainingMembers?.includes(a.id)
    const readiness = draining ? { ready: false, reason: 'account-draining', headroom: null } : expectedIdentity ? quotaReadiness(observation, { now,
      reservedPercent: principalReservations.get(observation.identity.principalId) || 0 })
      : { ready: false, reason: observation ? 'identity-mismatch' : 'unknown', headroom: null }
    return { account: a, observation, ...readiness }
  })
  const current = choices.find(c => c.account.id === currentAccountId)
  const preferred = choices.find(c => c.account.id === (preferredAccountId || group.preferred[provider]))
  const eligible = choices.filter(c => c.ready).sort((a, b) => b.headroom - a.headroom || a.account.id.localeCompare(b.account.id))
  let chosen = current?.ready ? current : eligible[0]
  let reason = current?.ready ? 'sticky-current' : 'capacity-handover'
  if (current?.ready && preferred?.ready && preferred !== current && preferred.observation.observedAt > resetConfirmedAfter &&
      now - lastSwitchedAt >= cooldownMs && preferred.headroom - current.headroom >= minBenefitPercent) {
    chosen = preferred; reason = 'preferred-recovered'
  }
  const nextResetAt = Math.min(...choices.flatMap(c => c.observation?.windows?.map(w => w.resetsAt).filter(t => finite(t) && t > now) || []))
  return { status: chosen ? 'selected' : choices.some(c => c.reason === 'headroom-exhausted' || c.reason === 'backend-denied') ? 'exhausted' : 'unknown',
    accountId: chosen?.account.id || null, groupId, reason: chosen ? reason : 'no-proven-capacity',
    nextResetAt: Number.isFinite(nextResetAt) ? nextResetAt : null,
    candidates: choices.map(c => ({ accountId: c.account.id, ready: c.ready, reason: c.reason, headroom: c.headroom })) }
}

export function nextQuotaPollAt(observation, { now = Date.now(), failures = 0, jitter = Math.random() } = {}) {
  const interval = Math.min(3600000, 300000 * 2 ** Math.min(Math.max(0, failures), 4))
  const resets = observation?.windows?.map(w => w.resetsAt).filter(finite) || []
  const untilReset = resets.length ? Math.min(...resets) - now + 5000 : Infinity
  const delay = failures ? interval : Math.min(interval, untilReset)
  return now + Math.max(60000, Math.min(3600000, delay + Math.max(0, Math.min(1, jitter)) * 30000))
}
