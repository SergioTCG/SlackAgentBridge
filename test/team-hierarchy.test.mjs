import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TEAM_MAX_DEPTH, TEAM_STANDING_TASK_TTL_MS, TEAM_TASK_TTL_MS,
  activeTeamForChannel, addTeamWorker, appendCoordinatorTaskMessage, appendTeamTaskCheckpoint, appendTeamTaskReply,
  assertCoordinatorDispatch, assertCoordinatorTaskControl, beginCollaboratorTeamTurn, beginDelegatedTeamTurn,
  beginOwnerTeamTurn, boundTeamTaskIdFor, cancelQueuedTeamTask, claimTeamTaskForSession,
  completeCoordinatorTaskMessageDelivery, coordinatedTeamForChannel, coordinatorPromptContext, createTeam,
  createTeamTask, delegatedTaskPrompt, delegatedTeamTurnValid, isStandingTeamTask, markTeamTaskRunning,
  parentTeamForChannel, publicTeamReply, publicTeamTask, reconcileTeamSessionBindings, releaseTeamTask,
  reportTeamTaskTurn, requestTeamTaskCompletion, teamContext, teamDepth, teamHeight, teamTaskReleaseReady,
  teamsForChannel,
} from '../daemon/teams.mjs'
import { claimContinuationDispatchAuthority, queueContinuation, setContinuationMode } from '../daemon/team-continuation.mjs'

// main → epic (worker of main, coordinator of epic-2990) → executor.
function hierarchy() {
  const state = {
    sessions: {
      main: { id: 'main', channel: 'C-MAIN', provider: 'claude' },
      epic: { id: 'epic', channel: 'C-EPIC', provider: 'claude' },
      exec: { id: 'exec', channel: 'C-EXEC', provider: 'codex' },
    },
    channels: { 'C-MAIN': 'main', 'C-EPIC': 'epic', 'C-EXEC': 'exec' },
  }
  const main = createTeam(state, { id: 'team_main', name: 'main', coordinatorChannel: 'C-MAIN', createdBy: 'U-OWNER', now: 1 })
  addTeamWorker(state, main.id, { channel: 'C-EPIC', alias: 'epic-2990', now: 2 })
  const epic = createTeam(state, { id: 'team_epic', name: 'epic-2990', coordinatorChannel: 'C-EPIC', createdBy: 'U-OWNER', now: 3 })
  addTeamWorker(state, epic.id, { channel: 'C-EXEC', alias: 'issue-2995', now: 4 })
  return { state, main, epic }
}

test('a channel can coordinate one team and be a worker in one other, within the depth bound', () => {
  const { state, main, epic } = hierarchy()
  assert.equal(coordinatedTeamForChannel(state, 'C-EPIC').id, epic.id)
  assert.equal(parentTeamForChannel(state, 'C-EPIC').id, main.id)
  assert.equal(activeTeamForChannel(state, 'C-EPIC').id, epic.id, 'the coordinated team is primary')
  assert.deepEqual(teamsForChannel(state, 'C-EPIC').map(team => team.id), [epic.id, main.id])
  assert.equal(activeTeamForChannel(state, 'C-EXEC').id, epic.id)
  assert.equal(TEAM_MAX_DEPTH, 2)
  assert.deepEqual([teamDepth(state, main), teamDepth(state, epic)], [1, 2])
  assert.deepEqual([teamHeight(state, main), teamHeight(state, epic)], [2, 1])

  // An executor may not open a third level, and nothing may form a cycle.
  assert.throws(() => createTeam(state, { name: 'too-deep', coordinatorChannel: 'C-EXEC', createdBy: 'U-OWNER' }),
    error => error.code === 'team_depth_exceeded')
  assert.throws(() => addTeamWorker(state, epic.id, { channel: 'C-MAIN', alias: 'up' }),
    error => error.code === 'team_cycle')
  // One parent per channel.
  const side = createTeam(state, { name: 'side', coordinatorChannel: 'C-SIDE', createdBy: 'U-OWNER' })
  assert.throws(() => addTeamWorker(state, side.id, { channel: 'C-EXEC', alias: 'twice' }),
    error => error.code === 'channel_already_teamed')
  // A team with a sub-team can't itself become a sub-team of another team.
  assert.throws(() => addTeamWorker(state, side.id, { channel: 'C-MAIN', alias: 'main' }),
    error => error.code === 'team_depth_exceeded')
  // A leaf team can join another team as a sub-team.
  const leaf = createTeam(state, { name: 'leaf', coordinatorChannel: 'C-LEAF', createdBy: 'U-OWNER' })
  addTeamWorker(state, side.id, { channel: 'C-LEAF', alias: 'leaf' })
  assert.equal(teamDepth(state, leaf), 2)
})

test('a worker holding exclusive work cannot become a sub-team coordinator', () => {
  const state = { sessions: {}, channels: {} }
  const main = createTeam(state, { id: 'team_main', name: 'main', coordinatorChannel: 'C-MAIN', createdBy: 'U-OWNER' })
  addTeamWorker(state, main.id, { channel: 'C-W', alias: 'w' })
  const { task } = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'w', text: 'Exclusive work.', requestId: 'r1',
  })
  assert.equal(isStandingTeamTask(task), false)
  assert.throws(() => createTeam(state, { name: 'sub', coordinatorChannel: 'C-W', createdBy: 'U-OWNER' }),
    error => error.code === 'exclusive_task_active')
})

test('tasks to a sub-team coordinator are standing, one at a time, and never reserve its turns', () => {
  const { state, main } = hierarchy()
  const create = (overrides = {}) => createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'epic-2990', text: 'Coordinate epic 2990.', requestId: 'epic-1', id: 'task_epic', now: 1000, ...overrides,
  })
  assert.throws(() => create({ reservation: 'exclusive' }), error => error.code === 'standing_required')
  const { task } = create()
  assert.equal(task.reservation, 'standing')
  assert.equal(Date.parse(task.expiresAt), 1000 + TEAM_STANDING_TASK_TTL_MS)
  assert.throws(() => create({ requestId: 'epic-2', id: 'task_epic_2' }), error => error.code === 'standing_task_active')

  const epic = state.sessions.epic
  claimTeamTaskForSession(state, task.id, epic, { targetProvider: 'claude', now: 1100 })
  assert.equal(epic.teamStandingTaskId, task.id)
  assert.equal(epic.teamActiveTaskId, undefined, 'a standing task never reserves the provider turn')
  assert.equal(boundTeamTaskIdFor(epic, task), task.id)
  markTeamTaskRunning(state, task.id, { now: 1200 })
  // Provider finals are not attributed to a standing task.
  assert.equal(reportTeamTaskTurn(state, task.id, { targetSessionId: 'epic', result: 'turn text' }).stale, true)
  assert.equal(task.reports, undefined)

  const reply = appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-EPIC', text: 'Two executors started.', requestId: 'reply-1', now: 5000,
  })
  assert.equal(reply.created, true)
  assert.equal(Date.parse(task.expiresAt), 5000 + TEAM_STANDING_TASK_TTL_MS, 'activity renews the lifetime')
  appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: 'C-EPIC', text: 'Waiting for both PRs.', pendingGates: ['merge'], requestId: 'gates-1', now: 6000,
  })
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'epic', fromChannel: 'C-EPIC', summary: 'Done.', requestId: 'done-early', expectedProviderWorkGeneration: 1,
  }), error => error.code === 'task_gates_pending')
  appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: 'C-EPIC', text: 'Both merged.', pendingGates: [], requestId: 'gates-2', now: 7000,
  })
  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'epic', fromChannel: 'C-EPIC', summary: 'Epic 2990 shipped.', requestId: 'done-1',
    expectedProviderWorkGeneration: 1, now: 8000,
  })
  assert.equal(task.status, 'awaiting_release', 'the declaration itself is the report')
  assert.equal(teamTaskReleaseReady(task), true)

  // A coordinator follow-up invalidates readiness until the worker declares again.
  const { message } = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MAIN', text: 'Also update the changelog.', requestId: 'follow-1', now: 9000,
  })
  assert.equal(teamTaskReleaseReady(task), false)
  completeCoordinatorTaskMessageDelivery(state, task.id, message.id, { now: 9100 })
  assert.equal(task.status, 'running')
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'epic', fromChannel: 'C-EPIC', summary: 'Stale.', requestId: 'done-stale', expectedProviderWorkGeneration: 1,
  }), error => error.code === 'task_revision_changed')
  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'epic', fromChannel: 'C-EPIC', summary: 'Epic 2990 shipped with changelog.', requestId: 'done-2',
    expectedProviderWorkGeneration: 2, now: 9500,
  })
  const released = releaseTeamTask(state, task.id, { sourceChannel: 'C-MAIN', requestId: 'release-1', now: 10_000 })
  assert.equal(released.task.status, 'completed')
  assert.equal(released.task.result, 'Epic 2990 shipped with changelog.')
  assert.equal(publicTeamTask(task, 'C-MAIN').reservation, 'standing')
})

test('an exclusive task waits while its worker holds a standing task, and cancel ends a standing task', () => {
  const { state, main } = hierarchy()
  const { task } = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'epic-2990', text: 'Coordinate.', requestId: 'epic-1', id: 'task_epic',
  })
  claimTeamTaskForSession(state, task.id, state.sessions.epic, { targetProvider: 'claude' })
  // A liaison-style plain worker can also get a standing task explicitly.
  addTeamWorker(state, main.id, { channel: 'C-LIAISON', alias: 'liaison' })
  const liaison = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'liaison', text: 'Relay accepted suggestions.', requestId: 'liaison-1', reservation: 'standing',
  }).task
  assert.equal(liaison.reservation, 'standing')
  const plain = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'liaison', text: 'One exclusive job.', requestId: 'liaison-2', now: Date.now() + 1,
  }).task
  assert.equal(plain.reservation, undefined)
  const session = { id: 'liaison', channel: 'C-LIAISON' }
  claimTeamTaskForSession(state, liaison.id, session, { targetProvider: 'claude' })
  assert.throws(() => claimTeamTaskForSession(state, plain.id, session, { targetProvider: 'claude' }),
    error => error.code === 'worker_busy')
  assert.equal(Date.parse(plain.expiresAt) - Date.parse(plain.createdAt), TEAM_TASK_TTL_MS)

  const cancelled = cancelQueuedTeamTask(state, task.id, { sourceChannel: 'C-MAIN', reason: 'Epic dropped.', requestId: 'cancel-1' })
  assert.equal(cancelled.status, 'cancelled')
  assert.throws(() => cancelQueuedTeamTask(state, 'task_missing', { sourceChannel: 'C-MAIN' }), error => error.code === 'task_not_found')
})

test('nested roles both appear in context and the standing task prompt', () => {
  const { state, main, epic } = hierarchy()
  const { task } = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'epic-2990', text: 'Coordinate epic 2990.', requestId: 'epic-1', id: 'task_epic',
  })
  const context = teamContext(state, 'C-EPIC')
  assert.equal(context.role, 'coordinator')
  assert.equal(context.name, 'epic-2990')
  assert.equal(context.depth, 2)
  assert.deepEqual(context.peers.map(peer => peer.alias), ['issue-2995'])
  assert.equal(context.parentTeam.name, 'main')
  assert.equal(context.parentTeam.role, 'worker')
  assert.equal(context.parentTeam.alias, 'epic-2990')
  assert.equal(context.parentTeam.standingTaskId, task.id)
  assert.equal(JSON.stringify(context).includes('C-'), false, 'no raw channel IDs reach the agent')
  assert.equal(teamContext(state, 'C-MAIN').peers[0].coordinatesTeam, 'epic-2990')

  const prompt = coordinatorPromptContext(state, 'C-EPIC')
  assert.match(prompt, /Team: epic-2990\nRole: coordinator/)
  assert.match(prompt, /Also a worker in team: main \(alias epic-2990\)/)
  assert.match(prompt, new RegExp(`sab team reply --task ${task.id}`))
  assert.match(coordinatorPromptContext(state, 'C-MAIN'), /epic-2990 \(coordinates epic-2990\)[\s\S]*Tasks to a worker that coordinates/)

  const header = delegatedTaskPrompt(main, task, [], { ownTeam: epic })
  assert.match(header, /<sab-team-task id="task_epic" team="team_main" generation="1" source="coordinator">/)
  assert.match(header, /Reservation: standing/)
  assert.match(header, /You also coordinate team epic-2990/)
  assert.match(header, /Provider finals are not reported automatically/)
})

test('delegated authority flows down only with an active, exactly bound standing task', () => {
  const { state, main, epic } = hierarchy()
  const session = state.sessions.epic
  const { task } = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'epic-2990', text: 'Coordinate epic 2990.', requestId: 'epic-1', id: 'task_epic',
  })
  beginDelegatedTeamTurn(session, { teamId: epic.id, sourceTaskId: task.id }, { budget: 2 })
  // Queued and unbound: no authority yet.
  assert.equal(delegatedTeamTurnValid(state, session, epic.id), false)
  claimTeamTaskForSession(state, task.id, session, { targetProvider: 'claude' })
  assert.equal(delegatedTeamTurnValid(state, session, epic.id), true)
  assert.doesNotThrow(() => assertCoordinatorDispatch(session, { teamId: epic.id, state }))
  assert.doesNotThrow(() => assertCoordinatorTaskControl(session, { teamId: epic.id, state }))
  // Never for the parent team, another team, or without the journal.
  assert.throws(() => assertCoordinatorDispatch(session, { teamId: main.id, state }), error => error.code === 'owner_turn_required')
  assert.throws(() => assertCoordinatorDispatch(session, { teamId: epic.id }), error => error.code === 'owner_turn_required')
  // A different session presenting the same turn shape has no authority.
  const forged = { id: 'other', channel: 'C-EPIC', teamStandingTaskId: task.id, teamTurn: { ...session.teamTurn } }
  assert.equal(delegatedTeamTurnValid(state, forged, epic.id), false)

  // Renewal may chain a delegated turn from a same-team authenticated event.
  setContinuationMode(epic, 'auto-until-blocked')
  session.teamTurn.remaining = 0
  queueContinuation(epic, { taskId: 'task_exec', kind: 'reply', replyId: 'r1', lifecycleVersion: 2 })
  const renewed = claimContinuationDispatchAuthority(epic, session)
  assert.equal(renewed.event.taskId, 'task_exec')
  assert.equal(session.teamTurn.actor, 'continuation')

  // Releasing or cancelling the standing task ends the delegation.
  beginDelegatedTeamTurn(session, { teamId: epic.id, sourceTaskId: task.id })
  cancelQueuedTeamTask(state, task.id, { sourceChannel: 'C-MAIN', reason: 'Stop.', requestId: 'cancel-1' })
  assert.equal(delegatedTeamTurnValid(state, session, epic.id), false)
  beginCollaboratorTeamTurn(session, { messageTs: '1.0' })
  assert.throws(() => assertCoordinatorDispatch(session, { teamId: epic.id, state }), error => error.code === 'owner_turn_required')
  beginOwnerTeamTurn(session, { messageTs: '2.0' })
  assert.doesNotThrow(() => assertCoordinatorDispatch(session, { teamId: epic.id, state }))
})

test('restart reconciliation restores and clears standing bindings separately', () => {
  const { state, main } = hierarchy()
  const { task } = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'epic-2990', text: 'Coordinate.', requestId: 'epic-1', id: 'task_epic',
  })
  const session = state.sessions.epic
  claimTeamTaskForSession(state, task.id, session, { targetProvider: 'claude' })
  delete session.teamStandingTaskId
  const repaired = reconcileTeamSessionBindings(state, { now: 1 })
  assert.equal(session.teamStandingTaskId, task.id)
  assert.equal(session.teamActiveTaskId, undefined)
  assert.equal(repaired.repairs[0].field, 'teamStandingTaskId')
  session.teamActiveTaskId = task.id // a corrupt exclusive projection of a standing task
  reconcileTeamSessionBindings(state, { now: 2 })
  assert.equal(session.teamActiveTaskId, undefined)
  assert.equal(session.teamStandingTaskId, task.id)
})

test('a reply written in a collaborator-started turn is labelled collaborator-originated', () => {
  const { state, main } = hierarchy()
  addTeamWorker(state, main.id, { channel: 'C-LIAISON', alias: 'liaison' })
  const { task } = createTeamTask(state, {
    teamId: main.id, sourceChannel: 'C-MAIN', sourceSessionId: 'main', sourceProvider: 'claude',
    target: 'liaison', text: 'Relay accepted suggestions.', requestId: 'liaison-1', reservation: 'standing',
  })
  const { reply } = appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-LIAISON', text: 'Marcel suggests holding lines.', requestId: 'r1',
    origin: { kind: 'collaborator', userId: 'U098WAUUX5M', name: 'Marcel' },
  })
  assert.deepEqual(reply.origin, { kind: 'collaborator', userId: 'U098WAUUX5M', name: 'Marcel' })
  assert.equal(publicTeamReply(task, reply, 'C-MAIN').origin, 'collaborator')
  const own = appendTeamTaskReply(state, task.id, { fromChannel: 'C-LIAISON', text: 'Own note.', requestId: 'r2' }).reply
  assert.equal(publicTeamReply(task, own, 'C-MAIN').origin, 'worker')
})
