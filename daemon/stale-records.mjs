import { lineageFor, lineageSessionIds } from './lineage.mjs'
import { activeTeams, isActiveTeamTask } from './teams.mjs'

// An account handover in one of these phases still needs owner inspection.
const UNCERTAIN_HANDOVER_PHASES = new Set(['prepared', 'restarting', 'interrupted'])
// An automation in any other state still owns its session and channel.
const FINISHED_AUTOMATION_STATES = new Set(['released', 'stopped'])

function inUse(state) {
  const channels = new Set()
  const sessions = new Set()
  for (const task of Object.values(state.teamTasks || {})) {
    if (!isActiveTeamTask(task)) continue
    channels.add(task.sourceChannel).add(task.targetChannel)
    sessions.add(task.sourceSessionId).add(task.targetSessionId)
  }
  for (const automation of Object.values(state.automations || {})) {
    if (FINISHED_AUTOMATION_STATES.has(automation?.status)) continue
    channels.add(automation?.channelId)
    sessions.add(automation?.sessionId)
  }
  for (const [channel, journal] of Object.entries(state.accountPools?.switches || {})) {
    if (UNCERTAIN_HANDOVER_PHASES.has(journal?.phase)) channels.add(channel)
  }
  return { channels, sessions }
}

// Session channels whose records may go once Slack reports them archived. Every
// session of the channel is stopped, and no provider switch, active team task,
// owning automation or uncertain account handover still depends on it.
export function dormantChannelCandidates(state, { alive }) {
  const { channels: busy } = inUse(state)
  return Object.entries(state.channels || {}).filter(([channel, sid]) => {
    if (channel === state.control || busy.has(channel)) return false
    const lineage = lineageFor(state, channel)
    if (lineage?.transition) return false
    return [sid, ...lineageSessionIds(lineage)].every(id => !alive(state.sessions?.[id]))
  }).map(([channel]) => channel)
}

// Open teams whose every channel Slack reports archived.
export function archivedTeams(state, archived) {
  return activeTeams(state).filter(team => {
    const channels = Object.keys(team.members || {})
    return channels.length > 0 && channels.every(channel => archived.has(channel))
  })
}

// Stopped session records that nothing can reach: no channel maps to them, no
// lineage or provider switch refers to them, and no active team task or
// automation owns them.
export function orphanSessionIds(state, { alive }) {
  const reachable = new Set(Object.values(state.channels || {}))
  for (const lineage of Object.values(state.lineages || {})) {
    for (const sid of lineageSessionIds(lineage)) reachable.add(sid)
    reachable.add(lineage?.transition?.source?.sid).add(lineage?.transition?.target?.sid)
  }
  for (const sid of inUse(state).sessions) reachable.add(sid)
  return Object.entries(state.sessions || {})
    .filter(([sid, session]) => !reachable.has(sid) && !alive(session))
    .map(([sid]) => sid)
}
