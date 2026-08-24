import { providerOf } from './providers.mjs'

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
