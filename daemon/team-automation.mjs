import crypto from 'node:crypto'
import { AutomationRequestError } from './automation.mjs'
import { LOCAL_NODE_ID } from './nodes.mjs'
import { providerOf } from './providers.mjs'
import { setContinuationMode } from './team-continuation.mjs'
import {
  TeamError, activeTeams, closeTeam, commitTeamWorkerReservation, consumeCoordinatorDispatch, coordinatedTeamForChannel,
  createTeam, createTeamTask, normalizeTeamAlias, releaseTeamWorkerReservation, removeTeamWorker, reserveTeamWorker,
  setTeamAutoRelease, teamAutoRelease, teamById, teamDispatchMode,
} from './teams.mjs'

// Automations that start inside a session team. The coordinator's own
// automation call is the only programmatic way to add a team member, and only
// for the channel that call creates. Authority comes from the coordinator's
// current owner or automatic-continuation turn and is consumed like a task
// dispatch; an existing channel is never added this way.

export const automationTaskRequestId = externalKey =>
  `automation:${crypto.createHash('sha256').update(String(externalKey)).digest('hex').slice(0, 48)}`

export function automationTeamError(error) {
  if (error instanceof AutomationRequestError) return error
  if (error instanceof TeamError) return new AutomationRequestError(error.code, error.message, error.status)
  return error
}

export function coordinatedTeamFor(state, session, selector) {
  const team = coordinatedTeamForChannel(state, session?.channel)
  const wanted = String(selector || '')
  if (!team || team.coordinatorChannel !== session.channel || team.members?.[session.channel]?.role !== 'coordinator' ||
      (team.id !== wanted && team.name !== wanted.toLowerCase())) {
    throw new TeamError('team_not_coordinated', 'The calling session must be the coordinator of that active team.', 403)
  }
  return team
}

export function defaultAutomationAlias(record) {
  return record.channelName
    ? normalizeTeamAlias(record.channelName)
    : `worker-${crypto.createHash('sha256').update(String(record.externalKey)).digest('hex').slice(0, 8)}`
}

export function createAutomationTeamBootstrap({
  state,
  resolveCaller,
  // (session, team) => authority; asserts or renews current dispatch authority.
  requireDispatch,
  switching = () => false,
  removeTaskFiles = () => {},
  ready = () => {},
  joined = async () => {},
  now = () => Date.now(),
}) {
  return {
    async authorize(request, caller) {
      if (!caller) {
        throw new AutomationRequestError('team_caller_required',
          'A team-bound automation must be created from the live SAB session that coordinates the team.', 403)
      }
      try {
        const session = await resolveCaller(caller)
        return { sessionId: session.id, channel: session.channel }
      } catch (error) { throw automationTeamError(error) }
    },

    // Synchronous with the journal write that follows, so authority, the
    // dispatch budget and the worker slot cannot be raced by another request.
    reserve(record, request, authorization) {
      try {
        const session = state.sessions?.[authorization?.sessionId]
        if (!session || session.channel !== authorization.channel || state.channels?.[session.channel] !== session.id) {
          throw new TeamError('unauthorized_session', 'The calling coordinator session is no longer authoritative.', 403)
        }
        if (switching(session)) throw new TeamError('source_switching', 'The coordinator is switching providers.', 409)
        const team = coordinatedTeamFor(state, session, request.team.name)
        if (teamDispatchMode(team) === 'draining') {
          throw new TeamError('team_draining', 'This team is draining and does not accept new workers.', 409)
        }
        const authority = requireDispatch(session, team)
        const authorizedBy = {
          kind: 'automation',
          externalKey: record.externalKey,
          coordinatorChannel: session.channel,
          coordinatorSessionId: session.id,
          coordinatorProvider: providerOf(session),
          actor: session.teamTurn?.actor || null,
          at: new Date(now()).toISOString(),
        }
        const reservation = reserveTeamWorker(state, team.id, {
          key: record.externalKey,
          alias: request.team.alias || defaultAutomationAlias(record),
          provenance: authorizedBy,
          createsTeam: request.team.createTeam || null,
          now: now(),
        })
        try { consumeCoordinatorDispatch(session, authority) }
        catch (error) {
          releaseTeamWorkerReservation(state, team.id, record.externalKey)
          throw error
        }
        return { teamId: team.id, teamName: team.name, alias: reservation.alias, taskId: null, authorizedBy }
      } catch (error) { throw automationTeamError(error) }
    },

    release(record) {
      if (record.team?.teamId) releaseTeamWorkerReservation(state, record.team.teamId, record.externalKey)
    },

    // The created channel, its membership and its bootstrap task are committed
    // in one journal mutation. Only this automation's own channel can join.
    bind(record, request) {
      try {
        const team = teamById(state, record.team.teamId)
        if (team.coordinatorChannel !== record.team.authorizedBy.coordinatorChannel) {
          throw new TeamError('team_coordinator_changed', 'The team coordinator changed while the channel was created.', 409)
        }
        const member = commitTeamWorkerReservation(state, team.id, record.externalKey, {
          channel: record.channelId, now: now(),
        })
        let createdTeam = null
        if (request.team.createTeam) {
          // The new worker also coordinates a new sub-team. It inherits the
          // parent's automatic continuation and auto-release policy, which
          // the owner chose for the parent; neither is widened here.
          try {
            const child = createTeam(state, {
              name: request.team.createTeam,
              coordinatorChannel: record.channelId,
              createdBy: team.createdBy,
              provenance: { ...record.team.authorizedBy, parentTeamId: team.id },
              now: now(),
            })
            if (team.continuation?.mode === 'auto-until-blocked') setContinuationMode(child, 'auto-until-blocked', { now: now() })
            if (teamAutoRelease(team)) setTeamAutoRelease(child, true, { now: now() })
            createdTeam = { teamId: child.id, teamName: child.name }
          } catch (error) {
            removeTeamWorker(state, team.id, record.channelId, { now: now() })
            throw error
          }
        }
        let taskId = null
        if (request.team.task) {
          try {
            const result = createTeamTask(state, {
              teamId: team.id,
              sourceChannel: team.coordinatorChannel,
              sourceSessionId: record.team.authorizedBy.coordinatorSessionId,
              sourceProvider: record.team.authorizedBy.coordinatorProvider,
              sourceNodeId: LOCAL_NODE_ID,
              target: record.channelId,
              text: request.team.task,
              requestId: automationTaskRequestId(record.externalKey),
              bootstrap: { externalKey: record.externalKey },
              now: now(),
            })
            taskId = result.task.id
            for (const removed of result.pruned || []) removeTaskFiles(removed)
          } catch (error) {
            if (createdTeam) closeTeam(state, createdTeam.teamId, { now: now() })
            removeTeamWorker(state, team.id, record.channelId, { now: now() })
            throw error
          }
        }
        return { alias: member.alias, taskId, joinedAt: member.joinedAt, ...(createdTeam ? { createdTeam } : {}) }
      } catch (error) { throw automationTeamError(error) }
    },

    ready(record) { ready(record) },
    joined(record) { return joined(record) },
  }
}

// A worker created by an automation receives its first task only after that
// automation's channel binding, collaborator setup and input readiness.
// Returns null when dispatchable, 'wait' while setup runs, or 'ended'.
export function bootstrapTaskHold(state, task) {
  if (!task?.bootstrap) return null
  const automations = state.automations || {}
  const record = Object.hasOwn(automations, task.bootstrap.externalKey) ? automations[task.bootstrap.externalKey] : null
  if (!record || record.channelId !== task.targetChannel || record.stop?.requestedAt ||
      ['failed', 'stopping', 'stopped'].includes(record.status)) return 'ended'
  if (['active', 'released'].includes(record.status) && record.prompt?.status === 'team_task') return null
  return 'wait'
}

// An automation is still setting up its channel's session until it is active.
// No team task, bootstrap or not, may reach that session before collaborator
// setup and its own initial prompt; before SessionStart there is no session.
const AUTOMATION_SETUP_STATUSES = new Set([
  'preparing_channel', 'pending', 'launching', 'awaiting_session', 'configuring_collaborators',
  'ready_to_prompt', 'injecting_prompt',
])
export function automationSetupPending(state, channel) {
  if (!channel) return false
  return Object.values(state.automations || {}).some(record => record.channelId === channel &&
    AUTOMATION_SETUP_STATUSES.has(record.status) && !record.stop?.requestedAt)
}

// A named or team-bound automation creates its channel before launch. Its
// first SessionStart binds exactly that channel; it never falls back to a new
// one, which would detach the channel's team membership and bootstrap task.
export function preparedAutomationChannel(state, session, channel) {
  if (!channel || !session?.tmux || state.channels?.[channel]) return null
  return Object.values(state.automations || {}).find(record =>
    record.channelId === channel && record.tmux === session.tmux && record.provider === providerOf(session) &&
    !record.sessionId && !record.stop?.requestedAt && !['stopping', 'stopped', 'released'].includes(record.status)) || null
}

// A stopped automation's session record and channel mapping are removed, so
// its team roles end with it: its worker membership is removed, cancelling only
// that membership's active tasks, and a team it coordinated is closed. Tasks
// keep their terminal journal entries and Slack audit cards.
export function detachAutomationTeams(state, record, { now = Date.now() } = {}) {
  const departures = []
  if (record.team?.teamId) releaseTeamWorkerReservation(state, record.team.teamId, record.externalKey)
  const channel = record.channelId
  if (!channel) return departures
  for (const team of activeTeams(state)) {
    const member = team.members?.[channel]
    if (!member) continue
    if (member.role === 'worker') {
      const result = removeTeamWorker(state, team.id, channel, { now, reason: 'The worker automation was stopped.' })
      departures.push({ kind: 'removed', team, alias: member.alias, cancelled: result.cancelled })
    } else if (team.coordinatorChannel === channel) {
      const memberChannels = Object.keys(team.members)
      const result = closeTeam(state, team.id, { now })
      departures.push({ kind: 'closed', team, memberChannels, cancelled: result.cancelled })
    }
  }
  return departures
}
