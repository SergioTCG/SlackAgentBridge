// Off by default. The daemon supplies exact live authority, restart/input
// fencing, and native readiness; quota readers never control session lifetime.
import crypto from 'node:crypto'
import { channelNodeId, LOCAL_NODE_ID } from './nodes.mjs'
import { providerOf, resumeArgsFor } from './providers.mjs'
import { captureTaskMaintenance, captureUsageLimitTaskMaintenance, assertTaskMaintenance } from './account-task-maintenance.mjs'
import { accountRegistryDigest, previewPoolAccountSelection, publicAccountRegistry } from './account-registry.mjs'
import { choosePoolAccount, nextQuotaPollAt, quotaReadiness } from './account-quota.mjs'
import { accountCredentialReference } from './account-profiles.mjs'

const fail = code => { throw new Error(code) }
// A refusal that names the safe-boundary rule it hit, so the owner reads why.
const failBlocked = reason => {
  throw Object.assign(new Error('account_switch_blocked'), { blockReason: String(reason || 'work or input was pending').slice(0, 160) })
}
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
// Proofs are kept as history only: an automatic move no longer needs one for
// its exact pair of accounts at the current registry revision. That rule broke
// every move whenever the registry changed, and nothing reported it.
const proofKey = (from, to) => `${from}:${to}`
// What protects a move instead is evidence that the target's login starts:
// a committed switch onto it, a session starting on it, or SAB's own hidden
// launch check. A login whose first-run, sign-in or terms screen blocks Claude
// before SessionStart would otherwise strand the session it was moved to.
const LAUNCH_CHECK_TTL_MS = 24 * 3600000
const LAUNCH_CHECK_RETRY_MS = 30 * 60000
const credentialKey = ref => ref ? `${ref.kind}:${ref.profile || ref.alias || ''}` : null
const sessionCredentialKey = session => !session.account ? 'native-default:'
  : providerOf(session) === 'codex' ? `codex-profile:${session.account}`
    : session.accountKind === 'claude-profile' ? `claude-profile:${session.account}` : `legacy-claude:${session.account}`
const launchCheckReasons = {
  login: 'it asked for a sign-in',
  terms: 'it asked to accept updated terms',
  onboarding: 'it showed its first-run screens',
  chrome: 'it asked about the Claude in Chrome extension',
  permissions: 'it asked to accept bypass-permissions mode',
  trust: 'it asked to trust its folder in a way SAB could not answer',
  timeout: 'it did not reach its prompt within a minute',
  failed: 'the check could not run',
}
export function launchCheckNotice(account, reason) {
  const ref = accountCredentialReference(account)
  const command = ref?.kind === 'claude-profile' ? `CLAUDE_CONFIG_DIR=~/.config/ccs/account-auth/claude/${ref.profile} claude` : 'claude'
  return `⚠️ SAB couldn't start Claude on *${account.email}*'s login: ${launchCheckReasons[reason] || launchCheckReasons.failed}. ` +
    `Until it can, SAB won't move sessions to that account. Run \`${command}\` on this Mac once to see the screen and answer it; ` +
    'SAB checks again within 30 minutes.'
}
// The Mac's own login signed in to an account the registry does not expect.
export function nativeIdentityNotice({ observed, expected }) {
  return `⚠️ This Mac's own Claude login is signed in to *${observed}*, but SAB's account registry says it is *${expected}*. ` +
    `SAB no longer starts new sessions on it, and counts sessions already on it as *${expected}*, which may be wrong. ` +
    `Sign the Mac back in as ${expected} with \`claude auth login\`, or have the registry updated to follow the Mac.`
}
// Owner notices for sessions an exhausted account cannot hand over. Brief
// waits stay quiet: a turn finishing, or the reset a few minutes away.
const WAITING_NOTICE_AFTER_MS = { 'no-capacity': 2 * 60000, 'launch-check': 5 * 60000, halted: 0, interrupted: 0, blocked: 15 * 60000 }
const slackTime = ms => `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} at {time}|${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC>`
const plural = (n, one, many) => n === 1 ? one : many
const waitingReasonText = reason => {
  const [kind, ...rest] = String(reason).split(':'), detail = rest.join(':')
  if (kind === 'blocked') return detail || 'work or input pending'
  if (kind === 'rejected') return `a handover was rejected (${detail || 'see the channel'}), retrying later`
  if (kind === 'launch-check') return `launch check of the target ${detail === 'running' ? 'running' : detail === 'pending' ? 'not done yet' : `failed: ${launchCheckReasons[detail] || detail}`}`
  if (kind === 'halted') return 'usage-limit moves are halted'
  if (kind === 'interrupted') return 'an earlier handover ended uncertain'
  if (kind === 'no-capacity') return 'no account has capacity'
  return kind.replace(/_/g, ' ')
}
export function waitingNotice({ kind, source, target, items, nextResetAt }) {
  const n = items.length, sessions = `${n} ${plural(n, 'session', 'sessions')}`, are = plural(n, 'is', 'are')
  const channels = items.slice(0, 8).map(item => `<#${item.session.channel}> (${waitingReasonText(item.reason)})`).join(', ') + (n > 8 ? `, and ${n - 8} more` : '')
  if (kind === 'no-capacity') {
    return `⏳ ${sessions} on *${source.email}* ${are} at its usage limit, and no account in the group has capacity left.` +
      (nextResetAt ? ` The next reset is ${slackTime(nextResetAt)}; SAB moves ${plural(n, 'it', 'them')} then.` : '')
  }
  if (kind === 'launch-check') {
    return `⚠️ ${sessions} on *${source.email}* ${are} at its usage limit and would move to *${target?.email || 'another account'}*, ` +
      `but SAB has not confirmed that Claude starts on that login: ${waitingReasonText(items[0].reason)}.`
  }
  if (kind === 'halted') return `⚠️ Usage-limit moves are halted, so ${sessions} on *${source.email}* wait: a handover ended uncertain in ` +
    `<#${String(items[0].reason).split(':')[1]}>. Check it with /sab-status, then reconcile it from /sab-account there.`
  return `⏳ ${sessions} on *${source.email}* ${are} at its usage limit but can't move yet: ${channels}.`
}
// Plain causes for the pre-teardown rejections an owner can act on.
const rejectionCauses = {
  account_identity_unverified: 'the target login could not be verified',
  account_switch_blocked: 'the session had work or input pending',
  account_switch_not_proven_idle: 'its terminal was not proven idle',
  account_registry_changed: 'the account registry changed',
  account_background_process_changed: 'a background process changed',
  account_background_panes: 'its terminal has more than one pane',
  account_limit_menu_not_dismissed: "Claude's usage-limit chooser did not close",
}
// A rejected automatic handover is retried after 15 min, doubling per
// consecutive rejection up to 4 h, never on every monitor tick. Held work on an
// exhausted account cannot progress meanwhile, so it retries after 2 min,
// doubling up to 15 min.
const automaticRetryDelay = journal => journal.usageLimit
  ? Math.min(900000, 120000 * 2 ** Math.min(3, (journal.attempt || 1) - 1))
  : Math.min(4 * 3600000, 900000 * 2 ** Math.min(4, (journal.attempt || 1) - 1))
const retryLabel = ms => ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 3600000)} h`
const renewalFailures = {
  timeout: "SAB's automatic renewal of its sign-in did not finish in time.",
  rejected: 'The provider refused to renew its saved sign-in.',
  failed: "SAB's automatic renewal of its sign-in failed.",
  'not-renewed': "SAB's automatic renewal saved no new sign-in.",
  abandoned: "A renewal or sign-in of it stopped before it finished.",
  'wrong-account': 'Its last sign-in was a different account.',
}
// `inUse`: sessions that refuse a new sign-in of this profile (any for Codex,
// a running one for Claude), so the owner needs a newly named profile.
export function signInNotice(account, observation, { inUse = false } = {}) {
  const ref = accountCredentialReference(account)
  const command = ref?.kind === 'claude-profile' ? `sab account login-claude ${ref.profile}`
    : ref?.kind === 'codex-profile' ? `sab account login-codex ${ref.profile}`
      : ref?.kind === 'native-default' && account.provider === 'claude' ? 'claude auth login' : null
  const next = !command ? '' : inUse
    ? ` Sessions still use profile ${ref.profile}, so sign in under a new profile name and attach it to this account (docs/account-pools.md).`
    : ` Run \`${command}\` on this Mac and open the link it prints.`
  return `🔑 *${account.email}* needs a new sign-in. ${renewalFailures[observation.reason] || 'The provider no longer accepts its saved sign-in.'} ` +
    `Until then SAB cannot read its usage or move sessions to it.${next}`
}
// Two renewals in a row that Claude neither confirmed nor refused. The sign-in
// itself may be fine, so no command: a refusal later gets its own notice.
export function renewalStuckNotice(account) {
  return `⚠️ SAB could not renew *${account.email}*'s sign-in twice in a row. It keeps trying, and the saved sign-in ` +
    'may still be fine. Until a renewal works, SAB cannot read its usage or move sessions to it. ' +
    'If the provider refuses the sign-in, you will get a notice with the command to run.'
}
// The Mac's own Claude login, when SAB reads its account through a profile.
export function nativeSignInNotice(account) {
  return `🔑 This Mac's own Claude login (*${account.email}*) needs a new sign-in. The provider refused to renew it, so ` +
    'Claude sessions that use no profile cannot run. Run `claude auth login` on this Mac, sign in as that account, ' +
    'and open the link it prints.'
}
// Readings that show the provider accepted the credential end a needs-login
// episode: a 403 or another account's profile still needed a valid token.
const CREDENTIAL_ACCEPTED = ['observed', 'scope-unavailable', 'identity-mismatch']
// The owner hears about a sign-in that needs them, and about a renewal that
// failed twice in a row without the provider refusing it.
const noticeKind = observation => observation?.status === 'needs-login' ? 'needs-login'
  : observation?.reason === 'not-renewed' ? 'not-renewed' : null
const needsOwner = (observation, previous) => noticeKind(observation) === 'needs-login' ||
  noticeKind(observation) === 'not-renewed' && previous?.reason === 'not-renewed'

export function accountPoolMode(value) {
  const mode = value || 'off'
  if (!['off', 'shadow', 'manual', 'auto'].includes(mode)) fail('invalid_account_pool_mode')
  return mode
}

export function createAccountPoolRuntime({ state, mode = 'off', readRegistry, persist, readQuota,
  blockReason = () => null, restart, writeRegistry, verifyIdentity = async () => 'credential-unavailable',
  onSettled = () => {}, notify = async () => {}, notifyOwner = async () => {}, now = Date.now, log = () => {},
  isDormant = async session => !session.pid && !session.tmux, adoptReplacement = async () => null,
  usageLimitBlockReason = async () => 'usage-limit maintenance unavailable',
  resumeAfterLimit = async () => false, markLimitPause = async () => false, nativeLoginState = async () => 'unknown',
  // SAB's own hidden launch of a login, with no prompt: { ok, reason }. Absent, logins earn evidence only from real starts.
  probeLaunch = null,
  // Whether the session's turn visibly ended at a usage limit (pane notice or pause marker).
  atUsageLimit = async () => false,
  // The account the Mac's own Claude login is signed in to: { email } or null when unreadable.
  nativeLoginIdentity = async () => null,
}) {
  mode = accountPoolMode(mode)
  const enabled = mode !== 'off', enforcing = ['manual', 'auto'].includes(mode), flights = new Map(), switching = new Set()
  let tickRunning = false, serialRead = Promise.resolve(), persistenceFailed = false
  const deferred = new Map() // channel → last usage-limit refusal, logged once per change
  const noticesPosting = new Set() // accounts whose sign-in notice is still being posted
  // A usage-limit handover that ends uncertain halts the others until that
  // channel is reconciled, so a systematic failure strands one session, not all.
  // The journal is the record, so the halt also survives a daemon restart.
  // Scoped by provider: a Codex path that ends uncertain never halts Claude's.
  const usageLimitHalt = provider => Object.values(poolState().switches).find(journal => journal?.usageLimit &&
    journal.phase === 'interrupted' && authoritative(state.sessions?.[journal.sessionId]) &&
    providerOf(state.sessions[journal.sessionId]) === provider) || null
  let haltLogged = null
  const save = () => {
    try { persist() }
    catch { persistenceFailed = true; fail('account_pool_persistence_failed') }
  }
  const registry = () => {
    if (!enabled) fail('account_pools_disabled')
    const record = readRegistry()
    if (!record) fail('registry_not_staged')
    return { record, view: publicAccountRegistry(record) }
  }
  const poolState = () => {
    if (!state.accountPools) state.accountPools = { schemaVersion: 1, observations: {}, bindings: {}, switches: {}, receipts: {}, proofs: {} }
    if (state.accountPools.schemaVersion !== 1 || !['observations', 'bindings', 'switches', 'receipts', 'proofs'].every(k =>
      state.accountPools[k] && typeof state.accountPools[k] === 'object' && !Array.isArray(state.accountPools[k]))) fail('invalid_pool_state')
    return state.accountPools
  }
  const currentAccount = (view, session) => view.accounts.find(a => a.provider === providerOf(session) && a.credentials.some(ref =>
    session.account ? ref.kind === 'legacy-claude' && !session.accountKind?.endsWith('-profile') && ref.alias === session.account ||
      ref.kind.endsWith('-profile') && ref.profile === session.account && (providerOf(session) === 'codex' || session.accountKind === 'claude-profile')
      : ref.kind === 'native-default')) || null
  const maintenanceBlockReason = (session, snapshot) => {
    if (!snapshot) return blockReason(session)
    assertTaskMaintenance(state, session, snapshot)
    return blockReason({ ...session, teamActiveTaskId: null })
  }
  // A usage-limit handover is checked by the daemon's own rule, which waives
  // only the protections that exist for the held work itself.
  const settledBlockReason = (session, journal) => journal?.usageLimit
    ? usageLimitBlockReason(session, journal.taskMaintenance || null)
    : maintenanceBlockReason(session, journal?.taskMaintenance)
  const authoritative = (session, sid = session?.id) => Boolean(session?.id === sid && session.channel &&
    state.channels?.[session.channel] === sid && state.sessions?.[sid] === session && channelNodeId(state, session.channel) === LOCAL_NODE_ID)
  const assertLaunchAllowed = session => {
    if (!enforcing || providerOf(session) === 'pi') return
    if (!authoritative(session)) fail('stale_account_session')
    const journal = state.accountPools?.switches?.[session.channel]
    if (journal && (journal.phase === 'interrupted' || ['prepared', 'restarting'].includes(journal.phase) && !switching.has(session.channel))) fail('account_handover_uncertain')
    const { record, view } = registry(), account = currentAccount(view, session)
    if (!account) fail('unknown_account')
    previewPoolAccountSelection(record, { channelId: session.channel, provider: providerOf(session), account: account.id })
  }
  const assertInputAllowed = session => {
    if (!enforcing || providerOf(session) === 'pi') return
    if (!authoritative(session)) fail('stale_account_session')
    const journal = state.accountPools?.switches?.[session.channel]
    if (journal && ['prepared', 'restarting', 'interrupted'].includes(journal.phase)) fail('account_handover_uncertain')
    const { view } = registry(), account = currentAccount(view, session)
    const groupId = view.routing.channels[session.channel] || view.routing.defaultGroupId
    if (!account || !view.groups.find(g => g.id === groupId)?.members.includes(account.id) || account.lifecycle === 'retired') fail('account_outside_group')
    if (account.allowedChannels && !account.allowedChannels.includes(session.channel)) fail('account_channel_forbidden')
  }
  const assertProviderLaunchAllowed = (channelId, provider, account = null, accountKind = null) => {
    if (!enforcing || provider === 'pi') return
    if (channelNodeId(state, channelId) !== LOCAL_NODE_ID) fail('stale_account_session')
    const { record, view } = registry()
    const selected = currentAccount(view, { provider, account, accountKind })
    if (!selected) fail('unknown_account')
    previewPoolAccountSelection(record, { channelId, provider, account: selected.id })
  }
  const data = revision => Object.fromEntries(Object.entries(poolState().observations)
    .filter(([, value]) => value.registryRevision === revision).map(([id, value]) => [id, value.observation]))
  const reservations = view => {
    const result = {}
    for (const session of Object.values(state.sessions || {})) {
      if (!authoritative(session) || !(session.pid && session.tmux)) continue
      const account = currentAccount(view, session)
      if (account) result[account.id] = (result[account.id] || 0) + (blockReason(session) ? 5 : 1)
    }
    return result
  }
  // Launch evidence per account, for the credential reference a move would use.
  // An upgrade starts from the committed, identity-verified switches onto each
  // account at the current revision, whose credential references cannot have
  // changed since.
  const launchChecks = () => {
    const pools = poolState()
    if (!pools.launchChecks || typeof pools.launchChecks !== 'object' || Array.isArray(pools.launchChecks)) {
      pools.launchChecks = {}
      try {
        const { record, view } = registry()
        for (const receipt of Object.values(pools.receipts)) {
          if (!['committed', 'reconciled'].includes(receipt?.phase) || !receipt.identityVerified || receipt.registryRevision !== record.revision) continue
          const account = view.accounts.find(a => a.id === receipt.targetAccountId)
          const at = Number(receipt.completedAt || receipt.reconciledAt || receipt.at) || 0
          if (account && !(pools.launchChecks[account.id]?.at >= at)) {
            pools.launchChecks[account.id] = { credential: credentialKey(accountCredentialReference(account)), ok: true, at, source: 'switch' }
          }
        }
      } catch { /* no registry: no evidence */ }
    }
    return pools.launchChecks
  }
  const launchCheck = account => {
    const check = account && launchChecks()[account.id]
    return check && check.credential === credentialKey(accountCredentialReference(account)) ? check : null
  }
  const launchReady = account => {
    const check = launchCheck(account)
    return Boolean(check?.ok && now() - check.at < LAUNCH_CHECK_TTL_MS)
  }
  const recordLaunch = (account, ok, source, reason = null) => {
    const checks = launchChecks(), previous = checks[account.id], credential = credentialKey(accountCredentialReference(account))
    const sameFailure = previous && !previous.ok && previous.credential === credential
    checks[account.id] = ok ? { credential, ok: true, at: now(), source }
      : { credential, ok: false, at: now(), source, reason, failures: (sameFailure ? previous.failures || 1 : 0) + 1,
        ...(sameFailure && previous.reason === reason && previous.notifiedAt ? { notifiedAt: previous.notifiedAt } : {}) }
  }
  // The daemon reports each session start: a session that reached SessionStart
  // on an account's own credential reference proves that login launches.
  const noteLaunch = session => {
    if (!enabled || persistenceFailed) return
    try {
      if (!authoritative(session) || !['claude', 'codex'].includes(providerOf(session))) return
      const { view } = registry(), account = currentAccount(view, session), ref = account && accountCredentialReference(account)
      if (!ref || credentialKey(ref) !== sessionCredentialKey(session)) return
      // A legacy token's identity cannot be verified, so it never earns
      // automatic moves; nor does a Mac login signed in to another account.
      if (!['claude-profile', 'codex-profile', 'native-default'].includes(ref.kind) ||
          ref.kind === 'native-default' && poolState().nativeIdentity) return
      recordLaunch(account, true, 'session')
      save()
    } catch { /* evidence is best-effort */ }
  }
  let probing = null
  const settleLaunchCheck = (account, result) => {
    if (result?.skipped) return // the login was busy (a renewal or sign-in); the next tick tries again
    try {
      const { view } = registry(), current = view.accounts.find(a => a.id === account.id)
      // A registry edit during the launch: the result may describe another reference.
      if (!current || credentialKey(accountCredentialReference(current)) !== credentialKey(accountCredentialReference(account))) return
      const ok = result?.ok === true, reason = ok ? null : /^[a-z-]{1,40}$/.test(result?.reason || '') ? result.reason : 'failed'
      recordLaunch(current, ok, 'probe', reason)
      save()
      if (ok) { log('account launch check passed', current.key); return }
      log('account launch check failed', current.key, reason)
      if (launchChecks()[current.id]?.notifiedAt || noticesPosting.has(`launch:${current.id}`)) return
      noticesPosting.add(`launch:${current.id}`)
      Promise.resolve().then(() => notifyOwner(launchCheckNotice(current, reason))).then(() => {
        const latest = launchChecks()[current.id]
        if (latest && !latest.ok && latest.reason === reason && !latest.notifiedAt) { latest.notifiedAt = now(); save() }
      }).catch(() => {}).finally(() => noticesPosting.delete(`launch:${current.id}`))
    } catch { /* retried at the next due check */ }
  }
  // One hidden launch at a time, for an active Claude login whose reading works
  // but whose launch evidence is missing or older than a day. Failures retry
  // after 30 minutes. Codex logins earn evidence from real starts only.
  const startDueLaunchCheck = view => {
    if (!probeLaunch || probing || persistenceFailed) return
    for (const account of view.accounts) {
      if (account.lifecycle !== 'active' || account.provider !== 'claude') continue
      const ref = accountCredentialReference(account)
      if (!['claude-profile', 'native-default'].includes(ref?.kind) || launchReady(account)) continue
      const check = launchCheck(account)
      if (check && !check.ok && now() - check.at < LAUNCH_CHECK_RETRY_MS) continue
      if (poolState().observations[account.id]?.observation?.status !== 'observed') continue
      // The Mac's login is another account's: launching it proves nothing about this one.
      if (ref.kind === 'native-default' && poolState().nativeIdentity) continue
      probing = account.id
      Promise.resolve().then(() => probeLaunch(account))
        .then(result => settleLaunchCheck(account, result), () => settleLaunchCheck(account, { ok: false, reason: 'failed' }))
        .finally(() => { probing = null })
      return
    }
  }
  const launchState = account => {
    const check = launchCheck(account)
    if (launchReady(account)) return { ready: true, at: check.at, source: check.source }
    return { ready: false, at: check?.at || null, reason: probing === account?.id ? 'running' : check && !check.ok ? check.reason : check ? 'stale' : 'pending' }
  }
  const status = channelId => {
    const { record, view } = registry()
    const session = state.sessions?.[state.channels?.[channelId]]
    if (!authoritative(session) || session.channel !== channelId) fail('stale_account_session')
    const current = currentAccount(view, session), binding = state.accountPools?.bindings?.[channelId]
    const snapshots = state.accountPools ? data(record.revision) : {}
    const decision = choosePoolAccount(view, { channelId, provider: providerOf(session), currentAccountId: current?.id,
      observations: snapshots, now: now(), preferredAccountId: binding?.preferredAccountId,
      resetConfirmedAfter: binding?.preferredResetAt ?? Infinity, lastSwitchedAt: binding?.switchedAt || 0,
      reservations: state.accountPools ? reservations(view) : {},
    })
    const group = view.groups.find(g => g.id === decision.groupId)
    // The reservation estimate balances accounts that can all still work. Once
    // the current account's own usage is exhausted, the move goes by measured
    // capacity, and the status says so instead of "no capacity".
    const ownReason = current && quotaReadiness(snapshots[current.id], { now: now() }).reason
    const exhausted = ownReason === 'headroom-exhausted' || ownReason === 'backend-denied' &&
      snapshots[current.id]?.windows?.some(w => w.usedPercent >= 90)
    const measured = exhausted && !decision.accountId ? choosePoolAccount(view, { channelId, provider: providerOf(session), currentAccountId: current.id,
      observations: snapshots, now: now(), preferredAccountId: binding?.preferredAccountId, reservations: {} }) : null
    return { mode, automaticSwitching: mode === 'auto' && !persistenceFailed, persistenceFailed, registryRevision: record.revision, group,
      currentAccount: current, decision, pendingSwitch: state.accountPools?.switches?.[channelId] || null,
      measured: measured?.accountId ? { accountId: measured.accountId, reason: measured.reason } : null,
      waiting: deferred.get(channelId) || null,
      accounts: view.accounts.filter(a => group.members.includes(a.id) && a.provider === providerOf(session)).map(account => ({
        id: account.id, email: account.email, observation: snapshots[account.id] || null,
        lastKnownQuota: state.accountPools?.observations?.[account.id]?.lastSuccessful || null,
        readiness: quotaReadiness(snapshots[account.id], { now: now() }),
        launch: state.accountPools ? launchState(account) : null,
      })) }
  }
  const inventory = () => {
    const { record, view } = registry()
    const usage = {}
    // Include standby/dormant references: retirement cannot silently strand
    // those conversations either. A credential is never deleted by this API.
    for (const session of Object.values(state.sessions || {})) {
      const account = currentAccount(view, session)
      if (account) (usage[account.id] ||= []).push(session.channel || `standby:${session.id}`)
    }
    return { mode, registryRevision: record.revision, registry: view, usage }
  }
  const manage = input => {
    if (!['manual', 'auto'].includes(mode) || persistenceFailed) fail('account_pool_read_only')
    if (switching.size || flights.size) fail('account_pool_operation_in_progress')
    if (!writeRegistry) fail('account_management_unavailable')
    const result = writeRegistry(input, inventory().usage)
    return result
  }
  const refresh = selector => {
    if (persistenceFailed) return Promise.reject(new Error('account_pool_persistence_failed'))
    const { record, view } = registry()
    const account = view.accounts.find(a => a.id === selector || a.key === selector)
    if (!account) return Promise.reject(new Error('unknown_account'))
    if (flights.has(account.id)) return flights.get(account.id)
    const previous = poolState().observations[account.id]
    if (previous?.registryRevision === record.revision && previous?.nextPollAt > now()) return Promise.resolve(previous.observation)
    // A single serialized sampler bounds process/network pressure even when
    // many sessions share one account or callers refresh concurrently.
    const flight = serialRead.then(async () => {
      let observation
      try { observation = await readQuota(account) }
      catch { observation = { provider: account.provider, observedAt: now(), status: 'provider-unavailable', windows: [] } }
      if (readRegistry()?.revision !== record.revision) return null // enrollment changed during I/O
      const latest = poolState().observations[account.id]
      if (latest?.registryRevision === record.revision && latest?.observation?.observedAt > observation.observedAt) return latest.observation
      const failures = observation.status === 'observed' ? 0 : Math.min(10, (latest?.failures || 0) + 1)
      const lastSuccessful = observation.status === 'observed' ? observation : latest?.registryRevision === record.revision
        ? latest.lastSuccessful || (latest.observation?.status === 'observed' ? latest.observation : null) : null
      // Polling cannot recover a sign-in, so the owner hears about it once per
      // episode; only a good reading re-arms the notice. One that could not be
      // posted is tried again at the next reading.
      const ownerNotifiedAt = CREDENTIAL_ACCEPTED.includes(observation.status) ? null : latest?.ownerNotifiedAt || null
      // A sign-in notice covers the rest of its episode. An earlier renewal
      // warning does not cover a sign-in that became necessary since.
      const ownerNotifiedFor = ownerNotifiedAt ? latest?.ownerNotifiedFor || 'needs-login' : null
      const covered = Boolean(ownerNotifiedAt) && (ownerNotifiedFor === 'needs-login' || noticeKind(observation) === 'not-renewed')
      // A new sign-in shows within minutes, whatever the failure backoff says.
      const scheduled = nextQuotaPollAt(observation.status === 'observed' ? observation : lastSuccessful, { now: now(), failures })
      poolState().observations[account.id] = { observation, lastSuccessful, registryRevision: record.revision, failures,
        nextPollAt: observation.status === 'needs-login' ? Math.min(scheduled, now() + 300000) : scheduled,
        ...(ownerNotifiedAt && { ownerNotifiedAt, ownerNotifiedFor }) }
      save()
      if (observation.status === 'needs-login' && latest?.observation?.status !== 'needs-login') {
        log('account sign-in needs renewing', account.key, observation.reason || 'provider')
      }
      if (observation.reason === 'not-renewed' && observation.status !== 'needs-login') log('account sign-in renewal unconfirmed', account.key)
      const previous = latest?.registryRevision === record.revision ? latest.observation : null
      if (needsOwner(observation, previous) && !covered && !noticesPosting.has(account.id)) {
        noticesPosting.add(account.id)
        const kind = noticeKind(observation)
        Promise.resolve().then(async () => {
          if (kind === 'not-renewed') await notifyOwner(renewalStuckNotice(account))
          else {
            const ref = accountCredentialReference(account)
            const users = ref?.profile ? Object.values(state.sessions || {}).filter(s => providerOf(s) === account.provider &&
              s.account === ref.profile && (account.provider === 'codex' || s.accountKind === 'claude-profile')) : []
            const inUse = users.length > 0 && (account.provider !== 'claude' || (await Promise.all(users.map(isDormant))).some(dormant => !dormant))
            await notifyOwner(signInNotice(account, observation, { inUse }))
          }
          const current = poolState().observations[account.id]
          if (noticeKind(current?.observation) && current.ownerNotifiedFor !== 'needs-login') {
            current.ownerNotifiedAt = now(); current.ownerNotifiedFor = kind; save()
          }
        }).catch(() => {}).finally(() => noticesPosting.delete(account.id))
      }
      return observation
    }).finally(() => flights.delete(account.id))
    flights.set(account.id, flight)
    serialRead = flight.catch(() => {})
    return flight
  }
  const switchAccount = async (session, selector, { requestId, expectedSessionId = session?.id, automatic = false, preserveTask = null, usageLimit = false } = {}) => {
    if (persistenceFailed) fail('account_pool_persistence_failed')
    if (!['manual', 'auto'].includes(mode)) fail('account_pool_read_only')
    if (!requestPattern.test(requestId || '')) fail('invalid_account_request')
    if (!authoritative(session, expectedSessionId)) fail('stale_account_session')
    // A usage limit is declared for a Claude or Codex session the pool measured
    // on an exhausted account: by the monitor, or by the owner's own switch
    // once the turn visibly ended at that limit. That switch then waives the
    // same protections the automatic one does, instead of refusing as "busy".
    if (usageLimit && (preserveTask || !['claude', 'codex'].includes(providerOf(session)))) fail('account_switch_blocked')
    if (usageLimit && !automatic && !(measuredExhaustion(session) && await atUsageLimit(session))) {
      failBlocked('the turn has not stopped at a measured usage limit')
    }
    if (!authoritative(session, expectedSessionId)) fail('stale_account_session')
    const channelId = session.channel
    if (switching.has(channelId)) fail('account_switch_in_progress')
    const { record, view } = registry()
    const selected = previewPoolAccountSelection(record, { channelId, provider: providerOf(session), account: selector })
    const target = selected.account, source = currentAccount(view, session)
    const key = accountRegistryDigest([channelId, requestId]), digest = accountRegistryDigest(preserveTask
      ? [expectedSessionId, target.id, automatic, preserveTask]
      : usageLimit ? [expectedSessionId, target.id, automatic, 'usage-limit'] : [expectedSessionId, target.id, automatic])
    const previous = poolState().receipts[key]
    if (previous) {
      if (previous.digest !== digest) fail('account_request_conflict')
      if (!['committed', 'selected', 'reconciled'].includes(previous.phase)) fail('account_handover_uncertain')
      return { status: previous.phase, accountId: previous.targetAccountId, requestId }
    }
    const ref = accountCredentialReference(target)
    const alias = ref?.kind === 'legacy-claude' ? ref.alias : ref?.kind.endsWith('-profile') ? ref.profile : null
    if (source?.id === target.id && (session.account || null) === alias &&
        poolState().switches[channelId]?.phase !== 'interrupted' &&
        (ref.kind !== 'claude-profile' || session.accountKind === 'claude-profile')) return { status: 'unchanged', accountId: target.id, requestId }
    if (Object.keys(poolState().receipts).length >= 4096) fail('account_receipt_history_full')
    if (automatic && preserveTask) fail('account_task_maintenance_blocked')
    const taskMaintenance = preserveTask ? captureTaskMaintenance(state, session, preserveTask)
      : usageLimit && (session.teamActiveTaskId || session.teamStandingTaskId) ? captureUsageLimitTaskMaintenance(state, session) : null
    if (usageLimit) {
      // The daemon's proof inspects the pane. Hold the channel while it runs so
      // no other handover can start, then repeat the synchronous checks.
      switching.add(channelId)
      let reason
      try { reason = await usageLimitBlockReason(session, taskMaintenance) } finally { switching.delete(channelId) }
      if (reason) failBlocked(reason)
      if (!authoritative(session, expectedSessionId) || switching.has(channelId) || poolState().receipts[key] ||
          currentAccount(registry().view, session)?.id !== source?.id || readRegistry()?.revision !== record.revision) fail('account_switch_blocked')
      if (taskMaintenance) assertTaskMaintenance(state, session, taskMaintenance)
    }
    const blocked = usageLimit ? null : maintenanceBlockReason(session, taskMaintenance)
    const dormant = !session.pid || blocked === 'provider is dormant'
    if (taskMaintenance && dormant) fail('account_task_maintenance_blocked')
    if (blocked && !(dormant && blocked === 'provider is dormant')) failBlocked(blocked)
    if (!dormant && (!session.pid || !session.tmux)) failBlocked('the provider process is not running')
    if (automatic) {
      // Fresh measured capacity on the target, and evidence its login starts.
      // No per-pair proof: the identity of the target login is checked before
      // teardown and again on the replacement, as for any switch.
      if (mode !== 'auto' || !source || poolState().observations[target.id]?.registryRevision !== record.revision ||
          !quotaReadiness(poolState().observations[target.id]?.observation, { now: now() }).ready) fail('automatic_handover_unproven')
      if (!launchReady(target)) fail('account_launch_unchecked')
    }
    if (!ref || (ref.kind !== 'native-default' && !(target.provider === 'claude' && ['legacy-claude', 'claude-profile'].includes(ref.kind)) && !(target.provider === 'codex' && ref.kind === 'codex-profile'))) fail('account_credential_unsupported')
    const before = { id: session.id, channel: session.channel, cwd: session.cwd, provider: providerOf(session),
      pid: session.pid, tmux: session.tmux, model: session.model, effort: session.effort,
      requestedModel: session.requestedModel, requestedEffort: session.requestedEffort, launchFlags: session.launchFlags }
    const beforeResumeArgs = JSON.stringify(resumeArgsFor(session))
    const journal = { requestId, digest, channelId, sessionId: session.id, sourceAccountId: source?.id || null, targetAccountId: target.id,
      registryRevision: record.revision, phase: 'prepared', at: now(), automatic }
    if (usageLimit) journal.usageLimit = true
    if (taskMaintenance) journal.taskMaintenance = taskMaintenance
    const prior = poolState().switches[channelId]
    if (automatic && prior?.automatic && prior.phase === 'rejected' && prior.sessionId === session.id &&
        prior.targetAccountId === target.id) journal.attempt = (prior.attempt || 1) + 1
    switching.add(channelId)
    try {
      poolState().receipts[key] = journal
      poolState().switches[channelId] = journal
      save()
      if (dormant && !automatic) {
        // This is explicit saved intent, NOT a native resume/canary proof. It
        // lets an owner correct a dormant misbinding without launching work.
        if (!await isDormant(session) || !authoritative(session, before.id) || session.pid !== before.pid || session.tmux !== before.tmux ||
            readRegistry()?.revision !== record.revision) fail('account_switch_blocked')
        session.account = alias
        if (ref.kind === 'claude-profile') session.accountKind = ref.kind
        else delete session.accountKind
        journal.phase = 'selected'; journal.completedAt = now(); save()
        await notify(channelId, `Account selection saved: ${target.email}. It will apply on the next owner-requested resume.`).catch(() => {})
        return { status: 'selected', accountId: target.id, requestId }
      }
      const identityBefore = await verifyIdentity(session, target, { stage: 'credential' })
      const legacyUnverified = !automatic && ref.kind === 'legacy-claude' && identityBefore === 'scope-unavailable'
      if (identityBefore !== 'verified' && !legacyUnverified) fail('account_identity_unverified')
      if (taskMaintenance) assertTaskMaintenance(state, session, taskMaintenance)
      // The callback reserves the daemon's input fence synchronously, then
      // repeats authority/idle checks after any awaited notice before teardown.
      journal.phase = 'restarting'; save()
      const restarted = await restart(session, alias, { expectedSessionId, account: target, source, automatic, taskMaintenance, usageLimit,
        authorize: () => { if (readRegistry()?.revision !== record.revision) fail('account_registry_changed') },
      })
      const note = typeof restarted?.note === 'string' ? restarted.note.slice(0, 600) : ''
      if (readRegistry()?.revision !== record.revision || !authoritative(session, before.id) || session.cwd !== before.cwd || providerOf(session) !== before.provider ||
          ['model', 'effort', 'requestedModel', 'requestedEffort'].some(k => session[k] !== before[k]) ||
          JSON.stringify(resumeArgsFor(session)) !== beforeResumeArgs ||
          (session.account || null) !== alias || !session.pid || !session.tmux) fail('account_handover_verification_failed')
      const replacement = { pid: session.pid, tmux: session.tmux }
      const identityAfter = await verifyIdentity(session, target, { stage: 'replacement' })
      if (identityAfter !== 'verified' && !(legacyUnverified && identityAfter === 'scope-unavailable') ||
          !authoritative(session, before.id) || session.pid !== replacement.pid || session.tmux !== replacement.tmux ||
          readRegistry()?.revision !== record.revision) fail('account_identity_unverified')
      if (taskMaintenance) assertTaskMaintenance(state, session, taskMaintenance)
      journal.identityVerified = identityAfter === 'verified'
      const fromQuota = source && poolState().observations[source.id]?.observation
      const limitingResets = fromQuota?.windows?.filter(w => w.usedPercent >= 90 && w.resetsAt > now()).map(w => w.resetsAt) || []
      const oldBinding = poolState().bindings[channelId]
      poolState().bindings[channelId] = { sessionId: session.id, provider: providerOf(session), groupId: selected.group.id,
        accountId: target.id, preferredAccountId: selected.group.id && view.groups.find(g => g.id === selected.group.id)?.preferred[providerOf(session)] || null,
        preferredResetAt: limitingResets.length ? Math.max(...limitingResets) : oldBinding?.preferredResetAt || null, switchedAt: now() }
      journal.phase = 'committed'; journal.completedAt = now()
      if (source && source.id !== target.id && !automatic && journal.identityVerified && !taskMaintenance) poolState().proofs[proofKey(source.id, target.id)] = { registryRevision: record.revision, at: now() }
      // A verified replacement started on the target's own reference: its login launches.
      if (journal.identityVerified) recordLaunch(target, true, 'switch')
      save()
      try { onSettled(session, { journal, source, target }) } catch { /* input recovery is separately fenced */ }
      const limit = usageLimit ? ` ${source?.email || 'The previous account'} had reached its usage limit${taskMaintenance
        ? `; team task \`${taskMaintenance.taskId}\` continues unchanged` : ''}.` : ''
      await notify(channelId, `Account handover complete: ${target.email} (${selected.group.name}).${limit}${note ? ` ${note}` : ''}${journal.identityVerified ? '' : ' Legacy token identity is owner-attested only; this does not authorize automatic switching.'}`).catch(() => {})
      return { status: 'committed', accountId: target.id, requestId }
    } catch (error) {
      const rejected = journal.phase === 'prepared' || error.accountPreflightRejected === true
      journal.phase = rejected ? 'rejected' : 'interrupted'
      if (rejected && /^account_[a-z_]{1,60}$/.test(error.message)) journal.reason = error.message
      journal.failure = rejected ? 'Rejected before provider teardown; verify credentials, idle state and pending work, then use a new request ID.'
        : 'Verify this exact session with /sab-status before requesting another handover; the restart will not be replayed.'
      if (!persistenceFailed) save()
      const cause = rejectionCauses[journal.reason] ? `: ${rejectionCauses[journal.reason]}` : ''
      const retry = automatic ? ` If it is still needed, SAB retries automatically in ${retryLabel(automaticRetryDelay(journal))}.` : ''
      if (rejected && journal.usageLimit && journal.attempt > 1) log('usage-limit handover rejected again', channelId, journal.reason || error.message)
      else await notify(channelId, rejected ? `Account handover was rejected before teardown${cause}. The existing provider was not stopped.${retry}`
        : 'Account handover did not establish a verified resume. No automatic retry will occur; inspect /sab-status.').catch(() => {})
      fail(rejected ? 'account_handover_rejected' : 'account_handover_uncertain')
    } finally { switching.delete(channelId) }
  }
  // A daemon restart between the replacement launch and its SessionStart loses
  // the only hook that binds its PID, and the interrupted journal fences the
  // Slack input that would bind it next. Adopt only the exact provider root the
  // daemon proves inside the journaled replacement tmux; never launch or replay.
  const adoptLostReplacement = async (session, journal, expectedSessionId) => {
    const tmux = session.tmux
    let pid
    switching.add(session.channel)
    try { pid = await adoptReplacement(session) } finally { switching.delete(session.channel) }
    if (session.pid || !pid || session.tmux !== tmux || !authoritative(session, expectedSessionId) ||
        poolState().switches[session.channel] !== journal) return
    session.pid = pid
    save()
  }
  const reconcile = async (session, { requestId, expectedSessionId = session?.id } = {}) => {
    if (!enforcing || persistenceFailed) fail('account_pool_read_only')
    if (!authoritative(session, expectedSessionId) || switching.has(session.channel)) fail('stale_account_session')
    const journal = poolState().switches[session.channel]
    if (!journal || journal.requestId !== requestId || journal.sessionId !== session.id) fail('account_request_conflict')
    if (journal.phase === 'reconciled') return { status: 'reconciled', requestId }
    if (journal.phase !== 'interrupted' || !session.tmux) fail('account_switch_blocked')
    if (!session.pid) await adoptLostReplacement(session, journal, expectedSessionId)
    if (!authoritative(session, expectedSessionId) || switching.has(session.channel) || poolState().switches[session.channel] !== journal) fail('stale_account_session')
    switching.add(session.channel)
    try {
      if (!session.pid || await settledBlockReason(session, journal)) fail('account_switch_blocked')
      const { record, view } = registry(), account = currentAccount(view, session)
      if (!account || account.id !== journal.targetAccountId) fail('account_identity_unverified')
      previewPoolAccountSelection(record, { channelId: session.channel, provider: providerOf(session), account: account.id })
      const expected = { pid: session.pid, tmux: session.tmux }
      if (await verifyIdentity(session, account, { stage: 'replacement' }) !== 'verified' || !authoritative(session, expectedSessionId) ||
          session.pid !== expected.pid || session.tmux !== expected.tmux || readRegistry()?.revision !== record.revision ||
          poolState().switches[session.channel] !== journal || await settledBlockReason(session, journal)) fail('account_identity_unverified')
      journal.phase = 'reconciled'; journal.reconciledAt = now()
      for (const receipt of Object.values(poolState().receipts)) {
        if (receipt.requestId === requestId && receipt.channelId === session.channel && receipt.sessionId === session.id) {
          receipt.phase = 'reconciled'; receipt.reconciledAt = journal.reconciledAt
        }
      }
      save()
      const source = view.accounts.find(a => a.id === journal.sourceAccountId) || null
      try { onSettled(session, { journal, source, target: account }) } catch { /* input recovery is separately fenced */ }
      return { status: 'reconciled', requestId }
    } finally { switching.delete(session.channel) }
  }
  const recover = async () => {
    if (!enabled || !state.accountPools) return
    let changed = false
    for (const journal of Object.values(poolState().receipts)) {
      if (!['prepared', 'restarting'].includes(journal.phase)) continue
      if (switching.has(journal.channelId)) continue // live work in this process, not crash recovery
      journal.phase = 'interrupted'; journal.failure = 'Daemon restarted during account handover; verify the exact native session. No restart was replayed.'
      if (poolState().switches[journal.channelId]?.requestId === journal.requestId) poolState().switches[journal.channelId] = journal
      changed = true
    }
    if (changed) save()
  }
  // Measured capacity only, without the reservation estimate. Used solely when
  // the current account is exhausted and no account passes that estimate.
  const measuredCapacityTarget = (session, source) => {
    const { record, view } = registry(), binding = state.accountPools?.bindings?.[session.channel]
    return choosePoolAccount(view, { channelId: session.channel, provider: providerOf(session), currentAccountId: source.id,
      observations: data(record.revision), now: now(), preferredAccountId: binding?.preferredAccountId, reservations: {} }).accountId
  }
  // A new session starts where the monitor would move it anyway, so no launch
  // begins on an exhausted login. Auto mode only; a ready native login stays.
  // `channelId: null` is a channel created only after launch (`/sab-new`).
  // Claude only: a Codex hook reports no account, so a profile launch could
  // not be bound to the login it actually runs on.
  const launchSelection = ({ channelId = null, provider }) => {
    const newChannel = channelId == null
    if (mode !== 'auto' || persistenceFailed || provider !== 'claude' ||
        !newChannel && (!/^[CG][A-Z0-9]{1,32}$/.test(channelId) || state.channels?.[channelId])) return null
    const { record, view } = registry()
    const native = view.accounts.find(a => a.provider === provider && a.credentials.some(ref => ref.kind === 'native-default'))
    if (!native) return null
    // The Mac's login is signed in to another account than the registry says,
    // so a native launch would run somewhere SAB cannot account for. Start on
    // the best account reachable through its own profile instead.
    const mismatch = Boolean(poolState().nativeIdentity)
    const usable = mismatch ? { ...view, accounts: view.accounts.filter(a => accountCredentialReference(a)?.kind !== 'native-default') } : view
    const decision = choosePoolAccount(usable, { channelId, provider, currentAccountId: mismatch ? null : native.id,
      observations: data(record.revision), now: now(), reservations: {}, newChannel })
    const target = decision.reason === 'capacity-handover' && (mismatch || decision.accountId !== native.id)
      ? view.accounts.find(a => a.id === decision.accountId) : null
    const ref = target && accountCredentialReference(target)
    if (!ref || !['legacy-claude', 'claude-profile'].includes(ref.kind) || target.lifecycle !== 'active') return null
    if (!newChannel) previewPoolAccountSelection(record, { channelId, provider, account: target.id })
    return { account: ref.kind === 'legacy-claude' ? ref.alias : ref.profile, accountKind: ref.kind, accountId: target.id, email: target.email }
  }
  // The daemon's Codex poller pauses a limit-ended turn only when the pool can
  // act on it: auto mode and the session's own account measured exhausted.
  const measuredExhaustion = session => {
    if (mode !== 'auto' || persistenceFailed || !authoritative(session)) return null
    try {
      const info = status(session.channel), source = info.currentAccount
      const reading = source && info.accounts.find(a => a.id === source.id)
      const reason = reading?.readiness?.reason
      const exhausted = reason === 'headroom-exhausted' || reason === 'backend-denied' &&
        reading.observation?.windows?.some(w => w.usedPercent >= 90)
      return exhausted ? { accountId: source.id, email: source.email } : null
    } catch { return null }
  }
  // When SAB reads an account through a profile, nothing else would notice
  // Claude signing out the Mac's own login of that account. One notice per
  // episode; a new sign-in ends it.
  const watchNativeLogin = async view => {
    const pools = poolState()
    const account = view.accounts.find(a => a.provider === 'claude' && a.credentials?.some(ref => ref.kind === 'native-default') &&
      accountCredentialReference(a)?.kind !== 'native-default')
    let login = null
    if (account) {
      try { login = await nativeLoginState() } catch { return }
      if (login !== 'signed-out' && login !== 'signed-in') return // nothing read: change nothing
    }
    if (login !== 'signed-out') {
      if (pools.nativeLogin) { delete pools.nativeLogin; save(); if (account) log('native Claude login signed in again') }
      return
    }
    if (!pools.nativeLogin) { pools.nativeLogin = { signedOutAt: now() }; save(); log('native Claude login signed out', account.key) }
    if (pools.nativeLogin.ownerNotifiedAt || noticesPosting.has('native-login')) return
    noticesPosting.add('native-login')
    Promise.resolve().then(async () => {
      await notifyOwner(nativeSignInNotice(account))
      const current = poolState().nativeLogin
      if (current && !current.ownerNotifiedAt) { current.ownerNotifiedAt = now(); save() }
    }).catch(() => {}).finally(() => noticesPosting.delete('native-login'))
  }
  // Signed in or out says nothing about which account the Mac's own login
  // holds. Claude records that in its config; compare it with the registry.
  const watchNativeIdentity = async view => {
    const pools = poolState()
    const account = view.accounts.find(a => a.provider === 'claude' && a.credentials?.some(ref => ref.kind === 'native-default'))
    if (!account) { if (pools.nativeIdentity) { delete pools.nativeIdentity; save() } return }
    let identity = null
    try { identity = await nativeLoginIdentity() } catch { return }
    const observed = typeof identity?.email === 'string' && /^[^\s@]{1,128}@[^\s@]{1,128}$/.test(identity.email) ? identity.email.toLowerCase() : null
    if (!observed) return // nothing read: change nothing
    const expected = account.email.toLowerCase()
    if (observed === expected) {
      if (pools.nativeIdentity) { delete pools.nativeIdentity; save(); log('native Claude login matches the registry again', account.key) }
      return
    }
    if (pools.nativeIdentity?.observed !== observed || pools.nativeIdentity?.expected !== expected) {
      pools.nativeIdentity = { observed, expected, since: now() }
      save()
      log('native Claude login is signed in to another account than the registry says', account.key)
    }
    if (pools.nativeIdentity.ownerNotifiedAt || noticesPosting.has('native-identity')) return
    noticesPosting.add('native-identity')
    Promise.resolve().then(async () => {
      await notifyOwner(nativeIdentityNotice(pools.nativeIdentity))
      const current = poolState().nativeIdentity
      if (current && current.observed === observed && !current.ownerNotifiedAt) { current.ownerNotifiedAt = now(); save() }
    }).catch(() => {}).finally(() => noticesPosting.delete('native-identity'))
  }
  // Every session at a usage limit that did not move gets its reason logged
  // once per change, and the owner hears about each stuck account once per
  // episode. A turn still running on an account below 100% is a normal wait.
  const blockedText = {
    account_task_maintenance_blocked: 'its team task is mid-delivery',
    account_task_maintenance_changed: 'its team task changed during the check',
    account_switch_in_progress: 'a handover is already running',
    stale_account_session: 'the session changed',
    account_switch_blocked: 'work or input was pending',
  }
  const reportWaiting = (waiting, view) => {
    for (const item of waiting) {
      if (deferred.get(item.session.channel) !== item.reason) log('usage-limit move waiting', item.session.channel, item.reason)
      deferred.set(item.session.channel, item.reason)
    }
    for (const channel of [...deferred.keys()]) if (!waiting.some(item => item.session.channel === channel)) deferred.delete(channel)
    const atHardLimit = account => poolState().observations[account.id]?.observation?.windows?.some(w => w.usedPercent >= 100)
    const groups = new Map()
    for (const item of waiting) {
      const kind = String(item.reason).split(':')[0]
      if (item.reason === 'blocked:turn in progress' && !atHardLimit(item.source)) continue
      const group = ['blocked', 'rejected', 'stale-reading'].includes(kind) ? 'blocked' : kind
      const key = `${item.source.id}|${group}${group === 'launch-check' ? `|${item.target}` : ''}`
      const entry = groups.get(key) || { kind: group, source: item.source, target: view.accounts.find(a => a.id === item.target) || null, items: [], nextResetAt: item.nextResetAt }
      entry.items.push(item)
      groups.set(key, entry)
    }
    const pools = poolState()
    if (!pools.waitingNotices || typeof pools.waitingNotices !== 'object' || Array.isArray(pools.waitingNotices)) pools.waitingNotices = {}
    const episodes = pools.waitingNotices
    let changed = false
    for (const key of Object.keys(episodes)) if (!groups.has(key)) { delete episodes[key]; changed = true }
    for (const [key, group] of groups) {
      if (!episodes[key]) { episodes[key] = { since: now() }; changed = true }
      const episode = episodes[key]
      if (episode.notifiedAt || noticesPosting.has(`waiting:${key}`) || now() - episode.since < (WAITING_NOTICE_AFTER_MS[group.kind] ?? 15 * 60000)) continue
      noticesPosting.add(`waiting:${key}`)
      Promise.resolve().then(() => notifyOwner(waitingNotice(group))).then(() => {
        const latest = poolState().waitingNotices?.[key]
        if (latest && !latest.notifiedAt) { latest.notifiedAt = now(); save() }
      }).catch(() => {}).finally(() => noticesPosting.delete(`waiting:${key}`))
    }
    if (changed) save()
  }
  const tick = async () => {
    if (!enabled || tickRunning || persistenceFailed) return
    tickRunning = true
    try {
      const { view } = registry()
      await recover()
      for (const account of view.accounts) await refresh(account.id)
      await watchNativeLogin(view)
      await watchNativeIdentity(view)
      if (mode !== 'auto') return
      startDueLaunchCheck(view)
      const waiting = []
      for (const session of Object.values(state.sessions || {})) {
        if (!authoritative(session) || !session.pid || !session.tmux || switching.has(session.channel) || !['claude', 'codex'].includes(providerOf(session))) continue
        const blocked = blockReason(session)
        const info = status(session.channel), source = info.currentAccount
        if (!source || !info.group.members.includes(source.id) ||
            (source.allowedChannels !== null && !source.allowedChannels.includes(session.channel))) continue
        const exhausted = reason => reason === 'headroom-exhausted' || reason === 'backend-denied' &&
          poolState().observations[source.id]?.observation?.windows?.some(w => w.usedPercent >= 90)
        // The estimate includes reservations for other sessions; the measured
        // reason is the account's own observed usage.
        const quotaExhausted = exhausted(info.decision.candidates.find(c => c.accountId === source.id)?.reason)
        const measuredExhausted = exhausted(info.accounts.find(a => a.id === source.id)?.readiness?.reason)
        // Pane text alone never resumes anything: the daemon marks a held turn
        // paused only while its account is measured exhausted. It resumes in
        // place once a newer reading of that same account shows capacity again;
        // nothing is restarted or moved.
        const own = info.accounts.find(a => a.id === source.id)
        if (measuredExhausted) {
          try { await markLimitPause(session, source.id) }
          catch (error) { log('usage-limit pause not recorded', session.channel, String(error?.message || error)) }
        }
        const pause = session.usageLimitPause
        if (pause && pause.accountId !== source.id) { delete session.usageLimitPause; save() }
        else if (pause && !measuredExhausted && own?.readiness?.ready && own.observation?.observedAt > pause.at) {
          let resumed = false
          try { resumed = await resumeAfterLimit(session) }
          catch (error) { log('usage-limit resume deferred', session.channel, String(error?.message || error)) }
          if (resumed) continue
        }
        // The reservation estimate balances accounts that can all still work. An
        // account whose own usage is exhausted cannot run the next turn at all,
        // so measured capacity elsewhere is enough.
        const target = info.decision.accountId || (measuredExhausted ? measuredCapacityTarget(session, source) : null)
        // Only a session at its own account's usage limit waits visibly: the
        // others have an account that still works.
        const wait = reason => {
          if (measuredExhausted) waiting.push({ session, source, target: target && target !== source.id ? target : null, reason, nextResetAt: info.decision.nextResetAt })
        }
        if (!target || source.id === target) { wait('no-capacity'); continue }
        // Only a measured usage limit moves a session whose own work is held:
        // that turn cannot progress on the exhausted account anyway. A
        // preference return, a drain or a manual switch waits for a safe boundary.
        const usageLimit = measuredExhausted && ['claude', 'codex'].includes(providerOf(session))
        if (blocked && !usageLimit) continue
        if (usageLimit) {
          const halt = usageLimitHalt(providerOf(session))
          if (halt) {
            if (haltLogged !== halt.requestId) log('usage-limit handovers halted until this channel is reconciled', halt.channelId)
            haltLogged = halt.requestId
            wait(`halted:${halt.channelId}`)
            continue
          }
        }
        const draining = source.lifecycle === 'draining' || info.group.drainingMembers.includes(source.id)
        if (!quotaExhausted && !draining && info.decision.reason !== 'preferred-recovered') continue
        const last = poolState().switches[session.channel]
        if (last?.phase === 'interrupted') { wait('interrupted'); continue }
        // A rejection left the provider untouched. Do not announce another
        // attempt, and keep another receipt, on every tick.
        if (last?.automatic && last.phase === 'rejected' && last.sessionId === session.id && now() - last.at < automaticRetryDelay(last)) {
          wait(`rejected:${rejectionCauses[last.reason] || 'see the channel'}`)
          continue
        }
        const targetAccount = view.accounts.find(a => a.id === target)
        if (!launchReady(targetAccount)) { wait(`launch-check:${launchState(targetAccount).reason}`); continue }
        const requestId = `automatic-${crypto.randomUUID()}`
        try {
          await switchAccount(session, target, { requestId, automatic: true, usageLimit })
          deferred.delete(session.channel)
        } catch (error) {
          // A journaled outcome was already explained by switchAccount.
          const journal = poolState().switches[session.channel]
          if (journal?.requestId === requestId) {
            wait(journal.phase === 'interrupted' ? 'interrupted' : `rejected:${rejectionCauses[journal.reason] || 'see the channel'}`)
            continue
          }
          if (error.message === 'account_launch_unchecked') { wait(`launch-check:${launchState(targetAccount).reason}`); continue }
          if (error.message === 'automatic_handover_unproven') { wait('stale-reading:the target account has no fresh reading'); continue }
          // Held work that is not yet at a safe point for usage-limit maintenance
          // is retried on the next tick; its reason is logged and, if it lasts,
          // reported to the owner.
          if (usageLimit) wait(`blocked:${error.blockReason || blockedText[error.message] || error.message}`)
          else await notify(session.channel, 'Automatic account handover is blocked; inspect /sab-account.').catch(() => {})
        }
      }
      reportWaiting(waiting, view)
    } finally { tickRunning = false }
  }
  // An owner's own switch: the usage-limit rules apply when the pool measured
  // the session's account exhausted and its turn visibly stopped at the limit.
  const ownerSwitch = async (session, selector, options = {}) => {
    const usageLimit = !options.preserveTask && Boolean(measuredExhaustion(session)) && await atUsageLimit(session)
    return switchAccount(session, selector, { ...options, automatic: false, usageLimit })
  }
  const accountIdFor = session => {
    try { return enabled && authoritative(session) ? currentAccount(registry().view, session)?.id || null : null } catch { return null }
  }
  return Object.freeze({ enabled, enforcing, mode, status, inventory, manage, refresh, switchAccount, ownerSwitch, reconcile, tick, recover,
    assertLaunchAllowed, assertInputAllowed, assertProviderLaunchAllowed, launchSelection, measuredExhaustion, accountIdFor, noteLaunch })
}
