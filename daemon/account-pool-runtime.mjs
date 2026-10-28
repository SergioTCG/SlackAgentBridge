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
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const proofKey = (from, to) => `${from}:${to}`
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
export function accountPoolMode(value) {
  const mode = value || 'off'
  if (!['off', 'shadow', 'manual', 'auto'].includes(mode)) fail('invalid_account_pool_mode')
  return mode
}

export function createAccountPoolRuntime({ state, mode = 'off', readRegistry, persist, readQuota,
  blockReason = () => null, restart, writeRegistry, verifyIdentity = async () => 'credential-unavailable',
  onSettled = () => {}, notify = async () => {}, now = Date.now, log = () => {},
  isDormant = async session => !session.pid && !session.tmux, adoptReplacement = async () => null,
  usageLimitBlockReason = async () => 'usage-limit maintenance unavailable',
}) {
  mode = accountPoolMode(mode)
  const enabled = mode !== 'off', enforcing = ['manual', 'auto'].includes(mode), flights = new Map(), switching = new Set()
  let tickRunning = false, serialRead = Promise.resolve(), persistenceFailed = false
  const deferred = new Map() // channel → last usage-limit refusal, logged once per change
  // A usage-limit handover that ends uncertain halts the others until that
  // channel is reconciled, so a systematic failure strands one session, not all.
  // The journal is the record, so the halt also survives a daemon restart.
  const usageLimitHalt = () => Object.values(poolState().switches).find(journal => journal?.usageLimit &&
    journal.phase === 'interrupted' && authoritative(state.sessions?.[journal.sessionId])) || null
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
    return { mode, automaticSwitching: mode === 'auto' && !persistenceFailed, persistenceFailed, registryRevision: record.revision, group,
      currentAccount: current, decision, pendingSwitch: state.accountPools?.switches?.[channelId] || null,
      accounts: view.accounts.filter(a => group.members.includes(a.id) && a.provider === providerOf(session)).map(account => ({
        id: account.id, email: account.email, observation: snapshots[account.id] || null,
        lastKnownQuota: state.accountPools?.observations?.[account.id]?.lastSuccessful || null,
        readiness: quotaReadiness(snapshots[account.id], { now: now() }),
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
      poolState().observations[account.id] = { observation, lastSuccessful, registryRevision: record.revision, failures,
        nextPollAt: nextQuotaPollAt(observation.status === 'observed' ? observation : lastSuccessful, { now: now(), failures }) }
      save()
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
    // Only the monitor declares a usage limit, for a Claude session it has just
    // observed on an exhausted account. Owners keep the ordinary safe boundary.
    if (usageLimit && (!automatic || preserveTask || providerOf(session) !== 'claude')) fail('account_switch_blocked')
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
      if (reason || !authoritative(session, expectedSessionId) || switching.has(channelId) || poolState().receipts[key] ||
          currentAccount(registry().view, session)?.id !== source?.id || readRegistry()?.revision !== record.revision) fail('account_switch_blocked')
      if (taskMaintenance) assertTaskMaintenance(state, session, taskMaintenance)
    }
    const blocked = usageLimit ? null : maintenanceBlockReason(session, taskMaintenance)
    const dormant = !session.pid || blocked === 'provider is dormant'
    if (taskMaintenance && dormant) fail('account_task_maintenance_blocked')
    if (blocked && !(dormant && blocked === 'provider is dormant') || (!dormant && (!session.pid || !session.tmux))) fail('account_switch_blocked')
    if (automatic) {
      if (mode !== 'auto' || !source || !poolState().proofs[proofKey(source.id, target.id)] ||
          poolState().proofs[proofKey(source.id, target.id)].registryRevision !== record.revision ||
          poolState().observations[target.id]?.registryRevision !== record.revision ||
          !quotaReadiness(poolState().observations[target.id]?.observation, { now: now() }).ready) fail('automatic_handover_unproven')
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
  const launchSelection = ({ channelId, provider }) => {
    if (mode !== 'auto' || persistenceFailed || provider !== 'claude' || !/^[CG][A-Z0-9]{1,32}$/.test(channelId || '') ||
        state.channels?.[channelId]) return null
    const { record, view } = registry()
    const native = view.accounts.find(a => a.provider === provider && a.credentials.some(ref => ref.kind === 'native-default'))
    if (!native) return null
    const decision = choosePoolAccount(view, { channelId, provider, currentAccountId: native.id,
      observations: data(record.revision), now: now(), reservations: {} })
    const target = decision.reason === 'capacity-handover' && decision.accountId !== native.id
      ? view.accounts.find(a => a.id === decision.accountId) : null
    const ref = target && accountCredentialReference(target)
    if (!ref || !['legacy-claude', 'claude-profile'].includes(ref.kind)) return null
    previewPoolAccountSelection(record, { channelId, provider, account: target.id })
    return { account: ref.kind === 'legacy-claude' ? ref.alias : ref.profile, accountKind: ref.kind, accountId: target.id, email: target.email }
  }
  const tick = async () => {
    if (!enabled || tickRunning || persistenceFailed) return
    tickRunning = true
    try {
      const { view } = registry()
      await recover()
      for (const account of view.accounts) await refresh(account.id)
      if (mode !== 'auto') return
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
        // The reservation estimate balances accounts that can all still work. An
        // account whose own usage is exhausted cannot run the next turn at all,
        // so measured capacity elsewhere is enough.
        const target = info.decision.accountId || (measuredExhausted ? measuredCapacityTarget(session, source) : null)
        if (!target || source.id === target) continue
        // Only a measured usage limit moves a session whose own work is held:
        // that turn cannot progress on the exhausted account anyway. A
        // preference return, a drain or a manual switch waits for a safe boundary.
        const usageLimit = measuredExhausted && providerOf(session) === 'claude'
        if (blocked && !usageLimit) continue
        if (usageLimit) {
          const halt = usageLimitHalt()
          if (halt) {
            if (haltLogged !== halt.requestId) log('usage-limit handovers halted until this channel is reconciled', halt.channelId)
            haltLogged = halt.requestId
            continue
          }
        }
        const draining = source.lifecycle === 'draining' || info.group.drainingMembers.includes(source.id)
        if (!quotaExhausted && !draining && info.decision.reason !== 'preferred-recovered') continue
        const last = poolState().switches[session.channel]
        if (last?.phase === 'interrupted') continue
        // A rejection left the provider untouched. Do not announce another
        // attempt, and keep another receipt, on every tick.
        if (last?.automatic && last.phase === 'rejected' && last.sessionId === session.id && now() - last.at < automaticRetryDelay(last)) continue
        const requestId = `automatic-${crypto.randomUUID()}`
        try {
          await switchAccount(session, target, { requestId, automatic: true, usageLimit })
          deferred.delete(session.channel)
        } catch (error) {
          // A journaled outcome was already explained by switchAccount.
          if (poolState().switches[session.channel]?.requestId === requestId || error.message === 'automatic_handover_unproven') continue
          // Held work that is not yet at a safe point for usage-limit maintenance
          // is retried on the next tick, not announced on every one.
          if (usageLimit) {
            if (deferred.get(session.channel) !== error.message) log('usage-limit handover deferred', session.channel, error.message)
            deferred.set(session.channel, error.message)
          } else await notify(session.channel, 'Automatic account handover is blocked; inspect /sab-account.').catch(() => {})
        }
      }
    } finally { tickRunning = false }
  }
  return Object.freeze({ enabled, enforcing, mode, status, inventory, manage, refresh, switchAccount, reconcile, tick, recover, assertLaunchAllowed, assertInputAllowed, assertProviderLaunchAllowed, launchSelection })
}
