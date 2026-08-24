import { providerOf } from './providers.mjs'

export const AUTOMATION_TMUX_LAUNCH_ATTEMPTS = 24
export const AUTOMATION_TMUX_POLL_INTERVAL_MS = 500

export async function terminateAutomationTmux(tname, {
  isAlive,
  terminate,
  sleep,
  launchAttempts = AUTOMATION_TMUX_LAUNCH_ATTEMPTS,
  intervalMs = AUTOMATION_TMUX_POLL_INTERVAL_MS,
}) {
  let sawTmux = false
  // A recovered stop has no in-memory launch promise. Watch through the same
  // complete materialization window as the launcher, including the final edge,
  // so a delayed Ghostty command cannot create tmux after stop reports success.
  for (let attempt = 0; attempt <= launchAttempts; attempt++) {
    if (await isAlive(tname)) {
      sawTmux = true
      await terminate(tname)
    } else if (sawTmux) return
    if (attempt < launchAttempts) await sleep(intervalMs)
  }
  if (await isAlive(tname)) throw new Error('the exact automation tmux could not be terminated')
}

export function validateAutomationStopTarget(state, record) {
  const session = record.sessionId ? state.sessions?.[record.sessionId] : null
  const conflicting = Object.values(state.sessions || {}).find(item => item.id !== record.sessionId && item.tmux === record.tmux)
  if (conflicting) throw new Error('the automation tmux identity is now owned by another session; refusing to stop it')
  if (session && (providerOf(session) !== record.provider || session.tmux !== record.tmux ||
      (record.channelId && session.channel !== record.channelId))) {
    throw new Error('the persisted automation/session correlation no longer matches; refusing a non-exact stop')
  }
  if (record.channelId && state.channels?.[record.channelId] && state.channels[record.channelId] !== record.sessionId) {
    throw new Error('the automation channel is now bound to another session; refusing to mutate it')
  }
  return session || null
}

export function detachAutomationState(state, record) {
  const session = validateAutomationStopTarget(state, record)
  const channel = record.channelId
  const lineage = channel ? state.lineages?.[channel] : null
  if (lineage) {
    for (const sid of new Set(Object.values(lineage.legs || {}).filter(Boolean))) {
      if (sid !== record.sessionId && state.sessions?.[sid]?.channel === channel) state.sessions[sid].channel = null
    }
    delete state.lineages[channel]
  }
  if (channel) {
    if (state.channels?.[channel] === record.sessionId) delete state.channels[channel]
    if (state.channelTmux?.[channel] === record.tmux) delete state.channelTmux[channel]
    if (state.whitelist) delete state.whitelist[channel]
  }
  if (record.sessionId && state.sessions?.[record.sessionId] === session) delete state.sessions[record.sessionId]
  return { session, channel, hadLineage: Boolean(lineage) }
}
