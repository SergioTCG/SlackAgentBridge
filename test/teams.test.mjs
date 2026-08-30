import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamError,
  activeTeamForChannel,
  addTeamWorker,
  appendTeamTaskReply,
  assertTeamTaskRetry,
  beginCollaboratorTeamTurn,
  beginOwnerTeamTurn,
  claimTeamTask,
  clearTeamTurn,
  closeTeam,
  completeTeamTask,
  consumeCoordinatorDispatch,
  coordinatorPromptContext,
  createTeam,
  createTeamTask,
  delegatedTaskPrompt,
  markTeamTaskRunning,
  publicTeamTask,
  removeTeamWorker,
  setTeamWorkerFiles,
  taskMarker,
  tasksForChannel,
  teamContext,
} from '../daemon/teams.mjs'

const initial = () => ({ sessions: {}, channels: {} })

function fixture() {
  const state = initial()
  const team = createTeam(state, {
    id: 'team_hexagonal', name: 'Hexagonal Cleanup', coordinatorChannel: 'C-MASTER', createdBy: 'U-OWNER', now: 1000,
  })
  addTeamWorker(state, team.id, { channel: 'C-WORKER-1', alias: 'parallel-1', now: 1100 })
  addTeamWorker(state, team.id, { channel: 'C-WORKER-2', alias: 'parallel-2', files: true, now: 1200 })
  return { state, team }
}

test('teams are lazy, normalized, immutable-channel groups with one coordinator', () => {
  const state = initial()
  assert.equal(Object.hasOwn(state, 'teams'), false)
  const team = createTeam(state, {
    id: 'team_hexagonal', name: 'Hexagonal Cleanup', coordinatorChannel: 'C-MASTER', createdBy: 'U-OWNER', now: 1000,
  })
  assert.equal(team.name, 'hexagonal-cleanup')
  assert.deepEqual(team.members['C-MASTER'], {
    role: 'coordinator', alias: 'coordinator', files: false, joinedAt: new Date(1000).toISOString(),
  })
  assert.equal(activeTeamForChannel(state, 'C-MASTER').id, team.id)
  assert.throws(() => createTeam(state, {
    name: 'another', coordinatorChannel: 'C-MASTER', createdBy: 'U-OWNER',
  }), error => error instanceof TeamError && error.code === 'channel_already_teamed')
})

test('worker membership uses unique aliases and one active team per channel', () => {
  const { state, team } = fixture()
  assert.throws(() => addTeamWorker(state, team.id, { channel: 'C-WORKER-3', alias: 'parallel-1' }),
    error => error.code === 'alias_in_use')
  assert.throws(() => createTeam(state, {
    name: 'other', coordinatorChannel: 'C-WORKER-1', createdBy: 'U-OWNER',
  }), error => error.code === 'channel_already_teamed')
  const context = teamContext(state, 'C-MASTER')
  assert.equal(context.role, 'coordinator')
  assert.deepEqual(context.peers.map(peer => peer.alias), ['parallel-1', 'parallel-2'])
  assert.equal(context.coordinatorChannel, undefined)
  assert.equal(context.peers.some(peer => Object.hasOwn(peer, 'channel')), false)
  assert.match(coordinatorPromptContext(state, 'C-MASTER'), /Role: coordinator/)
  assert.match(coordinatorPromptContext(state, 'C-WORKER-1'), /Role: worker/)
})

test('coordinator task creation is idempotent and directed only to workers', () => {
  const { state, team } = fixture()
  const input = {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'sid-master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Inspect issue 442.', requestId: 'request-1', id: 'task_one', now: 2000,
  }
  const first = createTeamTask(state, input)
  const duplicate = createTeamTask(state, input)
  assert.equal(first.created, true)
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.task.id, 'task_one')
  assert.equal(first.task.targetChannel, 'C-WORKER-1')
  assert.throws(() => createTeamTask(state, { ...input, text: 'Different work.' }),
    error => error.code === 'request_conflict')
  assert.throws(() => createTeamTask(state, { ...input, sourceChannel: 'C-WORKER-1', requestId: 'request-2' }),
    error => error.code === 'dispatch_not_allowed')
  assertTeamTaskRetry(state, first.task, {
    teamId: team.id, target: 'parallel-1', text: 'Inspect issue 442.', files: [],
  })
  assert.throws(() => assertTeamTaskRetry(state, first.task, {
    teamId: team.id, target: 'parallel-1', text: 'Changed payload.', files: [],
  }), error => error.code === 'request_conflict')
})

test('active worker queues are bounded and fail visibly before mutation', () => {
  const { state, team } = fixture()
  for (let index = 0; index < 8; index++) {
    createTeamTask(state, {
      teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
      target: 'parallel-1', text: `Task ${index}`, requestId: `queue-${index}`, id: `task_queue_${index}`,
    })
  }
  assert.throws(() => createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'One too many', requestId: 'queue-overflow', id: 'task_queue_overflow',
  }), error => error.code === 'worker_queue_full' && error.status === 429)
  assert.equal(state.teamTasks.task_queue_overflow, undefined)
})

test('files require explicit per-worker permission', () => {
  const { state, team } = fixture()
  const file = { path: '/workspace/report.pdf', filename: 'report.pdf', size: 100 }
  assert.throws(() => createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'claude',
    target: 'parallel-1', text: 'Read this.', files: [file], requestId: 'file-1',
  }), error => error.code === 'files_not_allowed')
  setTeamWorkerFiles(state, team.id, 'parallel-1', true)
  const created = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'claude',
    target: 'parallel-1', text: 'Read this.', files: [file], requestId: 'file-2', id: 'task_file',
  })
  assert.equal(created.task.files[0].filename, 'report.pdf')
  assert.equal(created.task.fileDeliveryStatus, 'pending')
})

test('task phase transitions bind an exact worker session and clear pending content', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Do the work.', requestId: 'run-1', id: 'task_run', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: 'worker-sid', targetProvider: 'claude', now: 3000 })
  assert.equal(task.status, 'dispatching')
  markTeamTaskRunning(state, task.id, { now: 4000 })
  assert.equal(task.status, 'running')
  assert.equal(task.text, '')
  const { reply } = appendTeamTaskReply(state, task.id, { fromChannel: 'C-WORKER-1', text: 'Halfway.', requestId: 'reply-1', now: 5000 })
  assert.equal(reply.text, 'Halfway.')
  assert.equal(reply.fileDeliveryStatus, 'none')
  const duplicateReply = appendTeamTaskReply(state, task.id, { fromChannel: 'C-WORKER-1', text: 'Halfway.', requestId: 'reply-1', now: 5500 })
  assert.equal(duplicateReply.created, false)
  assert.equal(task.replies.length, 1)
  assert.throws(() => appendTeamTaskReply(state, task.id, { fromChannel: 'C-WORKER-2', text: 'Spoof.', requestId: 'reply-2' }),
    error => error.code === 'reply_not_allowed')
  completeTeamTask(state, task.id, { targetSessionId: 'worker-sid', result: 'Finished.', now: 6000 })
  assert.equal(task.status, 'completed')
  assert.equal(task.result, 'Finished.')
  assert.throws(() => completeTeamTask(state, task.id, { targetSessionId: 'other', result: 'No.' }),
    error => error.code === 'task_not_running')
  assert.equal(publicTeamTask(task, 'C-MASTER').direction, 'outgoing')
  assert.equal(publicTeamTask(task, 'C-WORKER-1').direction, 'incoming')
  assert.equal(publicTeamTask(task, 'C-MASTER').sourceChannel, undefined)
  assert.equal(publicTeamTask(task, 'C-MASTER').targetChannel, undefined)
  assert.throws(() => publicTeamTask(task, 'C-OTHER'), error => error.code === 'task_not_visible')
})

test('restart recovery preserves one dispatch claim and rejects late completion from another leg', () => {
  const { state, team } = fixture()
  createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Exactly once.', requestId: 'restart-1', id: 'task_restart', now: 2000,
  })
  claimTeamTask(state, 'task_restart', { targetSessionId: 'worker-original', targetProvider: 'claude', now: 3000 })
  const recovered = JSON.parse(JSON.stringify(state))
  assert.equal(recovered.teamTasks.task_restart.status, 'dispatching')
  assert.throws(() => claimTeamTask(recovered, 'task_restart', {
    targetSessionId: 'worker-retry', targetProvider: 'claude', now: 4000,
  }), error => error.code === 'task_not_queued')
  markTeamTaskRunning(recovered, 'task_restart', { now: 5000 })
  assert.throws(() => completeTeamTask(recovered, 'task_restart', {
    targetSessionId: 'worker-retry', result: 'Late stale result.', now: 6000,
  }), error => error.code === 'task_target_changed')
  completeTeamTask(recovered, 'task_restart', {
    targetSessionId: 'worker-original', result: 'Correct result.', now: 7000,
  })
  assert.equal(recovered.teamTasks.task_restart.result, 'Correct result.')
})

test('worker removal and team closure cancel exact active tasks', () => {
  const { state, team } = fixture()
  for (const [n, target] of [['1', 'parallel-1'], ['2', 'parallel-2']]) {
    createTeamTask(state, {
      teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
      target, text: `Task ${n}`, requestId: `cancel-${n}`, id: `task_cancel_${n}`,
    })
  }
  const removed = removeTeamWorker(state, team.id, 'parallel-1', { now: 3000 })
  assert.deepEqual(removed.cancelled, ['task_cancel_1'])
  assert.equal(state.teamTasks.task_cancel_1.status, 'cancelled')
  assert.equal(state.teamTasks.task_cancel_2.status, 'queued')
  const closed = closeTeam(state, team.id, { now: 4000 })
  assert.deepEqual(closed.cancelled, ['task_cancel_2'])
  assert.equal(activeTeamForChannel(state, 'C-MASTER'), null)
})

test('owner turn authority is bounded and collaborator turns fail closed', () => {
  const session = {}
  beginOwnerTeamTurn(session, { messageTs: '1.2' }, { now: 1000, budget: 2 })
  consumeCoordinatorDispatch(session, { now: 2000 })
  consumeCoordinatorDispatch(session, { now: 3000 })
  assert.throws(() => consumeCoordinatorDispatch(session, { now: 4000 }), error => error.code === 'owner_turn_required')
  beginCollaboratorTeamTurn(session, { messageTs: '1.3' }, { now: 5000 })
  assert.throws(() => consumeCoordinatorDispatch(session, { now: 6000 }), error => error.code === 'owner_turn_required')
  clearTeamTurn(session)
  assert.equal(session.teamTurn, undefined)
})

test('delegated prompts carry immutable provenance and a task marker', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Return a report.', requestId: 'prompt-1', id: 'task_prompt',
  })
  const prompt = delegatedTaskPrompt(team, task, [{ path: '/private/attachment/report.txt' }])
  assert.equal(taskMarker(prompt), 'task_prompt')
  assert.match(prompt, /Role: worker/)
  assert.match(prompt, /Origin: coordinator/)
  assert.doesNotMatch(prompt, /C-MASTER/)
  assert.match(prompt, /sab team reply --task task_prompt/)
  assert.match(prompt, /\/private\/attachment\/report\.txt/)
})

test('channel inboxes contain only tasks involving that exact channel', () => {
  const { state, team } = fixture()
  createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'One', requestId: 'inbox-1', id: 'task_inbox_1', now: 1000,
  })
  createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-2', text: 'Two', requestId: 'inbox-2', id: 'task_inbox_2', now: 2000,
  })
  assert.deepEqual(tasksForChannel(state, 'C-WORKER-1').map(task => task.id), ['task_inbox_1'])
  assert.deepEqual(tasksForChannel(state, 'C-MASTER').map(task => task.id), ['task_inbox_2', 'task_inbox_1'])
  assert.deepEqual(tasksForChannel(state, 'C-MASTER', { after: 'task_inbox_1' }).map(task => task.id), ['task_inbox_2'])
  assert.throws(() => tasksForChannel(state, 'C-WORKER-1', { after: 'task_inbox_2' }),
    error => error.code === 'invalid_cursor')
  assert.deepEqual(tasksForChannel(state, 'C-UNRELATED'), [])
})
