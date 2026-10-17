// Off by default. The daemon supplies exact live authority, restart/input
// fencing, and native readiness; quota readers never control session lifetime.
import crypto from 'node:crypto'
import { channelNodeId, LOCAL_NODE_ID } from './nodes.mjs'
import { providerOf, resumeArgsFor } from './providers.mjs'
import { captureTaskMaintenance, assertTaskMaintenance } from './account-task-maintenance.mjs'
import { accountRegistryDigest, previewPoolAccountSelection, publicAccountRegistry } from './account-registry.mjs'
import { choosePoolAccount, nextQuotaPollAt, quotaReadiness } from './account-quota.mjs'
import { accountCredentialReference } from './account-profiles.mjs'

const fail = code => { throw new Error(code) }
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const proofKey = (from, to) => `${from}:${to}`
export function accountPoolMode(value) {
  const mode = value || 'off'
  if (!['off', 'shadow', 'manual', 'auto'].includes(mode)) fail('invalid_account_pool_mode')
  return mode
}

export function createAccountPoolRuntime({ state, mode = 'off', readRegistry, persist, readQuota,
  blockReason = () => null, restart, writeRegistry, verifyIdentity = async () => 'credential-unavailable',
  onSettled = () => {}, notify = async () => {}, now = Date.now,
  isDormant = async session => !session.pid && !session.tmux,
}) {
  mode = accountPoolMode(mode)
  const enabled = mode !== 'off', enforcing = ['manual', 'auto'].includes(mode), flights = new Map(), switching = new Set()
  let tickRunning = false, serialRead = Promise.resolve(), persistenceFailed = false
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
  const switchAccount = async (session, selector, { requestId, expectedSessionId = session?.id, automatic = false, preserveTask = null } = {}) => {
    if (persistenceFailed) fail('account_pool_persistence_failed')
    if (!['manual', 'auto'].includes(mode)) fail('account_pool_read_only')
    if (!requestPattern.test(requestId || '')) fail('invalid_account_request')
    if (!authoritative(session, expectedSessionId)) fail('stale_account_session')
    const channelId = session.channel
    if (switching.has(channelId)) fail('account_switch_in_progress')
    const { record, view } = registry()
    const selected = previewPoolAccountSelection(record, { channelId, provider: providerOf(session), account: selector })
    const target = selected.account, source = currentAccount(view, session)
    const key = accountRegistryDigest([channelId, requestId]), digest = accountRegistryDigest(preserveTask
      ? [expectedSessionId, target.id, automatic, preserveTask] : [expectedSessionId, target.id, automatic])
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
    const taskMaintenance = preserveTask ? captureTaskMaintenance(state, session, preserveTask) : null
    const blocked = maintenanceBlockReason(session, taskMaintenance)
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
    if (taskMaintenance) journal.taskMaintenance = taskMaintenance
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
      await restart(session, alias, { expectedSessionId, account: target, automatic, taskMaintenance,
        authorize: () => { if (readRegistry()?.revision !== record.revision) fail('account_registry_changed') },
      })
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
      try { onSettled(session) } catch { /* input recovery is separately fenced */ }
      await notify(channelId, `Account handover complete: ${target.email} (${selected.group.name}).${journal.identityVerified ? '' : ' Legacy token identity is owner-attested only; this does not authorize automatic switching.'}`).catch(() => {})
      return { status: 'committed', accountId: target.id, requestId }
    } catch (error) {
      const rejected = journal.phase === 'prepared' || error.accountPreflightRejected === true
      journal.phase = rejected ? 'rejected' : 'interrupted'
      journal.failure = rejected ? 'Rejected before provider teardown; verify credentials, idle state and pending work, then use a new request ID.'
        : 'Verify this exact session with /sab-status before requesting another handover; the restart will not be replayed.'
      if (!persistenceFailed) save()
      await notify(channelId, rejected ? 'Account handover was rejected before teardown. The existing provider was not stopped.'
        : 'Account handover did not establish a verified resume. No automatic retry will occur; inspect /sab-status.').catch(() => {})
      fail(rejected ? 'account_handover_rejected' : 'account_handover_uncertain')
    } finally { switching.delete(channelId) }
  }
  const reconcile = async (session, { requestId, expectedSessionId = session?.id } = {}) => {
    if (!enforcing || persistenceFailed) fail('account_pool_read_only')
    if (!authoritative(session, expectedSessionId) || switching.has(session.channel)) fail('stale_account_session')
    const journal = poolState().switches[session.channel]
    if (!journal || journal.requestId !== requestId || journal.sessionId !== session.id) fail('account_request_conflict')
    if (journal.phase === 'reconciled') return { status: 'reconciled', requestId }
    if (journal.phase !== 'interrupted' || !session.pid || !session.tmux || maintenanceBlockReason(session, journal.taskMaintenance)) fail('account_switch_blocked')
    const { record, view } = registry(), account = currentAccount(view, session)
    if (!account || account.id !== journal.targetAccountId) fail('account_identity_unverified')
    previewPoolAccountSelection(record, { channelId: session.channel, provider: providerOf(session), account: account.id })
    const expected = { pid: session.pid, tmux: session.tmux }
    switching.add(session.channel)
    try {
      if (await verifyIdentity(session, account, { stage: 'replacement' }) !== 'verified' || !authoritative(session, expectedSessionId) ||
          session.pid !== expected.pid || session.tmux !== expected.tmux || readRegistry()?.revision !== record.revision ||
          poolState().switches[session.channel] !== journal || maintenanceBlockReason(session, journal.taskMaintenance)) fail('account_identity_unverified')
      journal.phase = 'reconciled'; journal.reconciledAt = now()
      for (const receipt of Object.values(poolState().receipts)) {
        if (receipt.requestId === requestId && receipt.channelId === session.channel && receipt.sessionId === session.id) {
          receipt.phase = 'reconciled'; receipt.reconciledAt = journal.reconciledAt
        }
      }
      save()
      try { onSettled(session) } catch { /* input recovery is separately fenced */ }
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
  const tick = async () => {
    if (!enabled || tickRunning || persistenceFailed) return
    tickRunning = true
    try {
      const { view } = registry()
      await recover()
      for (const account of view.accounts) await refresh(account.id)
      if (mode !== 'auto') return
      for (const session of Object.values(state.sessions || {})) {
        if (!authoritative(session) || !session.pid || !session.tmux || blockReason(session) || switching.has(session.channel) || !['claude', 'codex'].includes(providerOf(session))) continue
        const info = status(session.channel), source = info.currentAccount, target = info.decision.accountId
        if (!source || !target || source.id === target || !info.group.members.includes(source.id) ||
            (source.allowedChannels !== null && !source.allowedChannels.includes(session.channel))) continue
        const currentReason = info.decision.candidates.find(c => c.accountId === source.id)?.reason
        const quotaExhausted = currentReason === 'headroom-exhausted' || currentReason === 'backend-denied' &&
          poolState().observations[source.id]?.observation?.windows?.some(w => w.usedPercent >= 90)
        const draining = source.lifecycle === 'draining' || info.group.drainingMembers.includes(source.id)
        if (!quotaExhausted && !draining && info.decision.reason !== 'preferred-recovered') continue
        if (poolState().switches[session.channel]?.phase === 'interrupted') continue
        try { await switchAccount(session, target, { requestId: `automatic-${crypto.randomUUID()}`, automatic: true }) }
        catch (error) { if (error.message !== 'automatic_handover_unproven') await notify(session.channel, 'Automatic account handover is blocked; inspect /sab-account.').catch(() => {}) }
      }
    } finally { tickRunning = false }
  }
  return Object.freeze({ enabled, enforcing, mode, status, inventory, manage, refresh, switchAccount, reconcile, tick, recover, assertLaunchAllowed, assertInputAllowed, assertProviderLaunchAllowed })
}
