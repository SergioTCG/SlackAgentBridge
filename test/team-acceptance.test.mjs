import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createAutomationLifecycle } from '../daemon/automation.mjs'
import { bootstrapTaskHold, createAutomationTeamBootstrap, detachAutomationTeams } from '../daemon/team-automation.mjs'
import {
  claimContinuation, queueContinuation, setContinuationMode, settleContinuation, shouldWakeForTeamReply,
} from '../daemon/team-continuation.mjs'
import {
  appendCoordinatorTaskMessage, appendTeamTaskCheckpoint, appendTeamTaskReply, assertCoordinatorDispatch,
  assertCoordinatorTaskControl, beginContinuationTeamTurn, beginCoordinatorTaskMessageDelivery,
  beginDelegatedTeamTurn, beginOwnerTeamTurn, boundTeamTaskIdFor, claimTeamTaskForSession, clearTeamTurn, closeTeam,
  completeCoordinatorTaskMessageDelivery, coordinatedTeamForChannel, createTeam, markTeamTaskRunning,
  parentTeamForChannel, releaseTeamTask, removeTeamWorker, reportTeamTaskTurn, requestTeamTaskCompletion,
  setTeamAutoRelease, teamAutoRelease, teamContext, teamTaskProviderWorkGeneration, teamTaskReleaseReady,
} from '../daemon/teams.mjs'

// The feature request's acceptance scenario, end to end through the real
// state modules. Daemon glue (Slack posts, tmux, provider hooks) is replaced
// by the exact journal calls that glue performs, in the same order. After the
// owner's one-time setup in main (/sab-team create, auto, auto-release on)
// nothing below is an owner action.
test('acceptance: main → epic coordinator → two executors, with no owner clicks after setup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-acceptance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const worktree = name => {
    const directory = path.join(root, name)
    fs.mkdirSync(directory, { recursive: true })
    return fs.realpathSync(directory)
  }
  let clock = Date.parse('2026-10-26T10:00:00.000Z')
  const tick = (ms = 1000) => (clock += ms)
  const state = {
    sessions: { main: { id: 'main', channel: 'C-MAIN', provider: 'claude', pid: 10, tmux: 'sab-main' } },
    channels: { 'C-MAIN': 'main' },
    automations: {},
  }
  // One-time owner setup in main.
  const main = createTeam(state, { id: 'team_main', name: 'main', coordinatorChannel: 'C-MAIN', createdBy: 'U-OWNER', now: clock })
  setContinuationMode(main, 'auto-until-blocked', { now: clock })
  setTeamAutoRelease(main, true, { now: clock })

  let caller = null
  const queue = []
  const lifecycle = createAutomationLifecycle({
    state, home: root, persist: () => {}, schedule: fn => queue.push(fn),
    launch: async () => {}, invite: async () => ({ name: 'x' }), inject: async () => assert.fail('no raw prompts'),
    terminate: async () => {}, archive: async () => {},
    prepareChannel: async record => ({ channelId: `C-${record.channelName}`.toUpperCase(), channelName: record.channelName }),
    teamBootstrap: createAutomationTeamBootstrap({
      state,
      resolveCaller: async () => caller,
      requireDispatch: (session, team) => {
        const authority = { teamId: team.id, allowContinuation: team.continuation?.mode === 'auto-until-blocked', state }
        assertCoordinatorDispatch(session, authority)
        return authority
      },
      now: () => clock,
    }),
    now: () => tick(1),
  })
  const drain = async () => { while (queue.length) await queue.shift()() }
  // SessionStart, collaborator setup and input readiness for an automation.
  const start = async (record, id, provider = 'claude') => {
    const session = { id, channel: record.channelId, provider, pid: 100 + Object.keys(state.sessions).length, tmux: record.tmux, cwd: record.cwd }
    state.sessions[id] = session
    state.channels[record.channelId] = id
    assert.equal(lifecycle.correlateSessionStart(session), true)
    await drain()
    assert.equal(record.status, 'active')
    return session
  }
  // dispatchTeamTask's claim plus the provider hook acknowledging the header.
  const deliver = (task, session) => {
    assert.equal(bootstrapTaskHold(state, task), null, 'setup completed before the first task')
    claimTeamTaskForSession(state, task.id, session, { targetProvider: session.provider, now: tick() })
    const ownTeam = coordinatedTeamForChannel(state, task.targetChannel)
    if (ownTeam) beginDelegatedTeamTurn(session, { teamId: ownTeam.id, sourceTaskId: task.id }, { now: clock })
    else clearTeamTurn(session)
    markTeamTaskRunning(state, task.id, { now: tick() })
  }

  // 1. main creates an epic coordinator: --create-team, --team main, first task.
  beginOwnerTeamTurn(state.sessions.main, { messageTs: '1.0' }, { now: clock })
  caller = state.sessions.main
  const epicRecord = (await lifecycle.submit({
    externalKey: 'barrique:epic-2990', cwd: worktree('epic'), provider: 'claude', flags: ['--dsp', '--model', 'claude-opus-5-5[1m]'],
    collaborators: [], initialPrompt: '', channelName: 'cc-barrique-epic-2990',
    team: { name: 'main', alias: 'epic-2990', task: 'Coordinate epic 2990: issues 2995 and 2996.', createTeam: 'epic-2990' },
  }, { caller: {} })).automation
  const epicTeam = coordinatedTeamForChannel(state, epicRecord.channelId)
  assert.equal(parentTeamForChannel(state, epicRecord.channelId).id, main.id)
  assert.equal(epicTeam.continuation.mode, 'auto-until-blocked')
  assert.equal(teamAutoRelease(epicTeam), true)
  await drain()
  const epic = await start(epicRecord, 'epic')
  const epicTask = state.teamTasks[epicRecord.team.taskId]
  assert.equal(epicTask.reservation, 'standing')
  deliver(epicTask, epic)
  assert.equal(epic.teamActiveTaskId, undefined, 'the epic never becomes a reserved worker')

  // 2. The epic creates two executors from its delegated turn.
  caller = epic
  const executors = []
  for (const issue of ['2995', '2996']) {
    const record = (await lifecycle.submit({
      externalKey: `barrique:${issue}`, cwd: worktree(issue), provider: issue === '2995' ? 'claude' : 'codex', flags: [],
      collaborators: [], initialPrompt: '', channelName: `cc-barrique-${issue}-holding-lines`,
      team: { name: 'epic-2990', alias: `issue-${issue}`, task: `Implement issue ${issue}.` },
    }, { caller: {} })).automation
    await drain()
    const session = await start(record, `exec-${issue}`, issue === '2995' ? 'claude' : 'codex')
    const task = state.teamTasks[record.team.taskId]
    assert.equal(task.teamId, epicTeam.id)
    assert.equal(task.reservation, undefined)
    deliver(task, session)
    executors.push({ record, session, task })
  }
  assert.equal(epic.teamTurn.remaining, 18, 'two dispatches from the delegated budget')
  clearTeamTurn(epic) // the epic's turn ends; its authority ends with it
  assert.throws(() => assertCoordinatorDispatch(epic, { teamId: epicTeam.id, state }), error => error.code === 'owner_turn_required')

  // 3. An executor asks; the epic forwards it up; main answers; it flows down.
  const [first] = executors
  const question = appendTeamTaskReply(state, first.task.id, {
    fromChannel: first.session.channel, text: 'Should the API keep the v1 field?', requestId: 'q-1', now: tick(),
  })
  assert.equal(shouldWakeForTeamReply(epicTeam, question), true)
  queueContinuation(epicTeam, { taskId: first.task.id, kind: 'reply', replyId: question.reply.id, lifecycleVersion: question.reply.lifecycleVersion, now: clock })
  const epicWake = claimContinuation(epicTeam, { now: tick() })
  beginContinuationTeamTurn(epic, { teamId: epicTeam.id, eventId: epicWake.id }, { now: clock })
  settleContinuation(epicTeam, epicWake.id, { now: clock })
  assert.equal(boundTeamTaskIdFor(epic, epicTask), epicTask.id)
  const forwarded = appendTeamTaskReply(state, epicTask.id, {
    fromChannel: epic.channel, text: 'issue-2995 asks: should the API keep the v1 field?', requestId: 'fwd-1', now: tick(),
  })
  assert.equal(shouldWakeForTeamReply(main, forwarded), true)
  clearTeamTurn(epic)
  queueContinuation(main, { taskId: epicTask.id, kind: 'reply', replyId: forwarded.reply.id, lifecycleVersion: forwarded.reply.lifecycleVersion, now: clock })
  const mainWake = claimContinuation(main, { now: tick() })
  beginContinuationTeamTurn(state.sessions.main, { teamId: main.id, eventId: mainWake.id }, { now: clock })
  settleContinuation(main, mainWake.id, { now: clock })
  assertCoordinatorTaskControl(state.sessions.main, { teamId: main.id, allowContinuation: true, state })
  const answer = appendCoordinatorTaskMessage(state, epicTask.id, {
    sourceChannel: 'C-MAIN', text: 'Keep v1 until the migration lands.', requestId: 'answer-1', now: tick(),
  }).message
  // performCoordinatorTaskMessageDelivery for the standing epic: idle surface,
  // delegated authority attached to the turn that receives the message.
  answer.providerDeliveryStatus = 'delivering'
  beginCoordinatorTaskMessageDelivery(state, epicTask.id, answer.id, { now: clock })
  beginDelegatedTeamTurn(epic, { teamId: epicTeam.id, sourceTaskId: epicTask.id }, { now: clock })
  completeCoordinatorTaskMessageDelivery(state, epicTask.id, answer.id, { now: tick() })
  assert.equal(teamTaskProviderWorkGeneration(epicTask), 2)
  assertCoordinatorTaskControl(epic, { teamId: epicTeam.id, allowContinuation: true, state })
  assert.throws(() => assertCoordinatorTaskControl(epic, { teamId: main.id, allowContinuation: true, state }),
    error => error.code === 'owner_turn_required', 'delegated authority never reaches the parent team')
  const down = appendCoordinatorTaskMessage(state, first.task.id, {
    sourceChannel: epic.channel, text: 'Main says: keep v1 until the migration lands.', requestId: 'down-1', now: tick(),
  }).message
  down.providerDeliveryStatus = 'delivering'
  beginCoordinatorTaskMessageDelivery(state, first.task.id, down.id, { now: clock })
  completeCoordinatorTaskMessageDelivery(state, first.task.id, down.id, { now: tick() })
  assert.equal(teamTaskProviderWorkGeneration(first.task), 2)
  clearTeamTurn(epic)

  // 4. Both executors complete and are auto-released by the epic team.
  for (const executor of executors) {
    const generation = teamTaskProviderWorkGeneration(executor.task)
    appendTeamTaskCheckpoint(state, executor.task.id, {
      fromChannel: executor.session.channel, text: 'Tests, CI and review are green; merged.', pendingGates: [],
      requestId: `gates-${executor.session.id}`, now: tick(),
    })
    requestTeamTaskCompletion(state, executor.task.id, {
      targetSessionId: executor.session.id, fromChannel: executor.session.channel, summary: 'Merged.',
      requestId: `done-${executor.session.id}`, expectedProviderWorkGeneration: generation, now: tick(),
    })
    reportTeamTaskTurn(state, executor.task.id, {
      targetSessionId: executor.session.id, result: 'PR merged.', providerWorkGeneration: generation,
      reportKey: `final-${executor.session.id}`, now: tick(), observedAt: clock,
    })
    assert.equal(executor.task.status, 'awaiting_release')
    assert.equal(teamTaskReleaseReady(executor.task), true)
    // autoReleaseTeamTask: the team opted in and the release is exactly ready.
    assert.equal(teamAutoRelease(state.teams[executor.task.teamId]), true)
    releaseTeamTask(state, executor.task.id, { sourceChannel: executor.task.sourceChannel, requestId: `auto-release-${executor.session.id}`, now: tick() })
    delete executor.session.teamActiveTaskId
    assert.equal(executor.task.status, 'completed')
    assert.equal(executor.task.result, 'PR merged.')
  }

  // 5. Barrique's finalizer stops and archives both executors.
  for (const executor of executors) {
    const departures = detachAutomationTeams(state, executor.record, { now: tick() })
    assert.deepEqual(departures.map(item => [item.kind, item.cancelled]), [['removed', []]])
    assert.equal(epicTeam.members[executor.session.channel], undefined)
    assert.equal(state.teamTasks[executor.task.id].status, 'completed', 'task history remains')
  }
  assert.deepEqual(teamContext(state, epic.channel).peers, [])

  // 6. The epic's channel is archived: its team closes and it leaves main.
  closeTeam(state, epicTeam.id, { now: tick() })
  const left = removeTeamWorker(state, main.id, epic.channel, { reason: 'The worker channel was archived and its sub-team closed.', now: tick() })
  assert.ok(epicTeam.closedAt)
  assert.deepEqual(left.cancelled, [epicTask.id])
  assert.equal(epicTask.status, 'cancelled')
  assert.equal(coordinatedTeamForChannel(state, epic.channel), null)
  assert.equal(parentTeamForChannel(state, epic.channel), null)
})
