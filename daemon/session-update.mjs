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
        await stopSession(session)
        stopped.push(session)
      } catch (error) {
        results.push({ session, provider, status: 'failed', phase: 'stop', error: String(error?.message || error) })
      }
    }
    if (!stopped.length) continue

    let update = null
    let updateError = null
    try { update = await updateProvider(provider) } catch (error) { updateError = String(error?.message || error) }
    providers.push({ provider, update, error: updateError })

    for (const session of stopped) {
      try {
        await resumeSession(session, { update, updateError })
        results.push({ session, provider, status: 'resumed', update, updateError })
      } catch (error) {
        results.push({ session, provider, status: 'failed', phase: 'resume', error: String(error?.message || error), update, updateError })
      }
    }
  }
  return { providers, results }
}
