import { providerOf } from './providers.mjs'
import { activeTerminalSessions } from './terminal-control.mjs'

function ownsAutomation(session, automations = {}) {
  return Object.values(automations).some(record =>
    record && record.status !== 'stopped' &&
    (record.sessionId === session.id || (session.tmux && record.tmux === session.tmux)))
}

export function bulkUpdateBlockReason(session, {
  busySessionIds = new Set(),
  questionSessionIds = new Set(),
  pendingPermissionChannels = new Set(),
  transitionChannels = new Set(),
  internalSessionIds = new Set(),
  restartingSessionIds = new Set(),
  wakingSessionIds = new Set(),
  automations = {},
} = {}) {
  if (transitionChannels.has(session.channel)) return 'provider switch in progress'
  if (session.teamActiveTaskId) return 'delegated team task in progress'
  if (['active', 'paused'].includes(session.managed?.status) || session.piRouting?.status === 'routing') return 'managed Pi work in progress'
  if (ownsAutomation(session, automations)) return 'automation-owned session'
  if (questionSessionIds.has(session.id)) return 'question awaiting an answer'
  if (pendingPermissionChannels.has(session.channel)) return 'permission awaiting a decision'
  if (internalSessionIds.has(session.id)) return 'private maintenance turn in progress'
  if (restartingSessionIds.has(session.id) || wakingSessionIds.has(session.id)) return 'session already restarting'
  if (busySessionIds.has(session.id) || session.codexTurnStartedAt || session.piTurnStartedAt) return 'turn in progress'
  return null
}

export function planBulkSessionUpdate(state, { pidAlive, ...context }) {
  const eligible = []
  const skipped = []
  for (const session of activeTerminalSessions(state, { pidAlive })) {
    const reason = bulkUpdateBlockReason(session, { ...context, automations: state.automations })
    if (reason) skipped.push({ session, reason })
    else eligible.push(session)
  }
  return { eligible, skipped }
}

export function groupUpdateSessions(sessions) {
  const groups = new Map()
  for (const session of sessions) {
    const provider = providerOf(session)
    const group = groups.get(provider) || []
    group.push(session)
    groups.set(provider, group)
  }
  return groups
}

// Native providers can replace their conversation identity in-place (for
// example Claude `/clear`). Runtime maintenance state is keyed by that native
// identity, so carry every not-yet-delivered prompt and lifecycle fence to the
// replacement before the old key is discarded.
export function rebindSessionRuntimeState(fromId, toId, {
  pendingBySession,
  updatingSessionIds,
  restartingSessionIds,
  wakingSessions,
  fenceOwners,
} = {}) {
  if (!fromId || !toId || fromId === toId) return false

  if (pendingBySession?.has(fromId)) {
    const prior = pendingBySession.get(fromId) || []
    const replacement = pendingBySession.get(toId) || []
    if (prior.length || replacement.length) pendingBySession.set(toId, [...prior, ...replacement])
    pendingBySession.delete(fromId)
  }
  for (const ids of [updatingSessionIds, restartingSessionIds]) {
    if (ids?.delete(fromId)) ids.add(toId)
  }
  if (wakingSessions?.has(fromId)) {
    if (!wakingSessions.has(toId)) wakingSessions.set(toId, wakingSessions.get(fromId))
    wakingSessions.delete(fromId)
  }
  if (fenceOwners?.has(fromId)) {
    if (!fenceOwners.has(toId)) fenceOwners.set(toId, fenceOwners.get(fromId))
    fenceOwners.delete(fromId)
  }
  return true
}

// A retained queue can outlive a failed resurrection. A later owner message is
// the explicit retry signal only when no process, wake, maintenance operation,
// or active drain already owns delivery.
export function shouldRetryDormantSessionWake({
  pending = false,
  providerAlive = false,
  waking = false,
  updating = false,
  draining = false,
} = {}) {
  return Boolean(pending && !providerAlive && !waking && !updating && !draining)
}

// Startup metadata is allowed to fail without trapping the session behind a
// stale maintenance marker. An active drain retains exclusive ownership; a
// surviving queue remains the direct-input fence but becomes explicitly
// retryable through /sab-update.
export function recoverSessionInputFence(sessionId, {
  pendingBySession,
  updatingSessionIds,
  drainingSessionIds,
  fenceOwners,
  expectedOwner = null,
} = {}) {
  if (!sessionId) return 'released'
  if (expectedOwner && fenceOwners?.get(sessionId) !== expectedOwner) return 'superseded'
  if (drainingSessionIds?.has(sessionId)) return 'draining'
  updatingSessionIds?.delete(sessionId)
  if (!expectedOwner || fenceOwners?.get(sessionId) === expectedOwner) fenceOwners?.delete(sessionId)
  return pendingBySession?.get(sessionId)?.length ? 'retry' : 'released'
}

// Drain until the queue is observably empty. New input can arrive while an
// earlier paste is awaiting the provider; it remains fenced and is picked up
// by the next loop iteration instead of overtaking the queued prompt.
export async function drainSessionInputQueue(sessionIdentity, {
  pendingBySession,
  updatingSessionIds,
  drainingSessionIds,
  fenceOwners,
  expectedOwner = null,
  inFlightPrompts,
  inFlightOwner = null,
  deliver,
} = {}) {
  const resolveIdentity = typeof sessionIdentity === 'function' ? sessionIdentity : () => sessionIdentity
  let activeId = resolveIdentity()
  if (!activeId || typeof deliver !== 'function') throw new TypeError('session input drain requires an identity and deliver function')
  if (drainingSessionIds?.has(activeId)) return false
  drainingSessionIds?.add(activeId)
  const followReplacement = () => {
    const nextId = resolveIdentity()
    if (!nextId || nextId === activeId) return activeId
    drainingSessionIds?.delete(activeId)
    if (drainingSessionIds?.has(nextId)) throw new Error('replacement session already has an input drain')
    activeId = nextId
    drainingSessionIds?.add(activeId)
    return activeId
  }
  let completed = false
  try {
    while (true) {
      const sessionId = followReplacement()
      const batch = [...(pendingBySession?.get(sessionId) || [])]
      if (!batch.length) break
      pendingBySession.set(sessionId, [])
      for (let index = 0; index < batch.length; index++) {
        if (inFlightPrompts && inFlightOwner) inFlightPrompts.set(inFlightOwner, batch.slice(index))
        try {
          await deliver(batch[index])
          if (inFlightPrompts && inFlightOwner) {
            if (index + 1 < batch.length) inFlightPrompts.set(inFlightOwner, batch.slice(index + 1))
            else inFlightPrompts.delete(inFlightOwner)
          }
        } catch (error) {
          const replacementId = followReplacement()
          const arrived = pendingBySession.get(replacementId) || []
          pendingBySession.set(replacementId, [...batch.slice(index), ...arrived])
          throw error
        }
      }
    }
    const sessionId = followReplacement()
    if (expectedOwner && fenceOwners?.get(sessionId) !== expectedOwner) {
      throw new Error('session input fence ownership changed during delivery')
    }
    pendingBySession?.delete(sessionId)
    updatingSessionIds?.delete(sessionId)
    if (!expectedOwner || fenceOwners?.get(sessionId) === expectedOwner) fenceOwners?.delete(sessionId)
    completed = true
    return true
  } finally {
    drainingSessionIds?.delete(activeId)
    if (inFlightPrompts && inFlightOwner) inFlightPrompts.delete(inFlightOwner)
    // A failed delivery deliberately retains the maintenance fence and queue.
    // Callers may retry, but direct provider input must not overtake it.
    if (!completed && pendingBySession && !pendingBySession.has(activeId)) pendingBySession.set(activeId, [])
  }
}

// Stop every eligible session for one provider before swapping its CLI, then
// resume every session even when the update check itself fails. Callers provide
// all effects so this orchestration can be regression-tested without Slack,
// tmux, provider binaries, or persisted state.
export async function runBulkSessionUpdate(sessions, {
  revalidateSession,
  stopSession,
  updateProvider,
  resumeSession,
}) {
  const providers = []
  const results = []
  for (const [provider, group] of groupUpdateSessions(sessions)) {
    const stopped = []
    for (const session of group) {
      let reason = null
      try { reason = await revalidateSession(session) } catch (error) { reason = String(error?.message || error) }
      if (reason) {
        results.push({ session, provider, status: 'skipped', reason })
        continue
      }
      try {
        const stopResult = await stopSession(session)
        stopped.push({ session, stopResult })
      } catch (error) {
        results.push({ session, provider, status: 'failed', phase: 'stop', error: String(error?.message || error) })
      }
    }
    if (!stopped.length) continue

    let update = null
    let updateError = null
    try { update = await updateProvider(provider) } catch (error) { updateError = String(error?.message || error) }
    providers.push({ provider, update, error: updateError })

    for (const { session, stopResult } of stopped) {
      try {
        await resumeSession(session, { update, updateError }, stopResult)
        results.push({ session, provider, status: 'resumed', update, updateError })
      } catch (error) {
        results.push({ session, provider, status: 'failed', phase: 'resume', error: String(error?.message || error), update, updateError })
      }
    }
  }
  return { providers, results }
}
