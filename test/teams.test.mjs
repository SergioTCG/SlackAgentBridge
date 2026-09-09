import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TeamError,
  activeTeamForChannel,
  addTeamWorker,
  acknowledgeCoordinatorTaskMessageDelivery,
  appendCoordinatorTaskMessage,
  appendTeamTaskCheckpoint,
  appendTeamTaskReply,
  assertCoordinatorTaskControl,
  assertTeamTaskRetry,
  beginCollaboratorTeamTurn,
  beginCoordinatorTaskMessageDelivery,
  completeCoordinatorTaskMessageDelivery,
  beginContinuationTeamTurn,
  beginOwnerTeamTurn,
  cancelQueuedTeamTask,
  claimTeamTask,
  claimTeamTaskForSession,
  clearTeamTurn,
  closeTeam,
  completeTeamTask,
  completeTeamTaskWithWarning,
  consumeCoordinatorDispatch,
  coordinatorPromptContext,
  createTeam,
  createTeamTask,
  delegatedTaskPrompt,
  deferCoordinatorTaskMessageDelivery,
  markTeamTaskRunning,
  publicTeamTask,
  reconcileTeamSessionBindings,
  releaseTeamTask,
  pruneTeamTasks,
  removeTeamWorker,
  replaceQueuedTeamTask,
  reportTeamTaskTurn,
  requestTeamTaskCompletion,
  setTeamDispatchMode,
  setTeamWorkerFiles,
  taskMarker,
  tasksForChannel,
  tasksPageForChannel,
  teamDispatchMode,
  teamMutationForRequest,
  teamContext,
  teamTaskDeliverySettled,
  withoutDelegatedTaskPrompt,
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
  assert.equal(context.dispatchMode, 'active')
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

test('accepted continuation retries survive later worker removal', () => {
  const { state, team } = fixture()
  const task = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'sid-master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Continue the accepted work.', parentTaskId: 'task-parent',
    requestId: 'continuation-retry', id: 'task-continuation', now: 2000,
  }).task

  removeTeamWorker(state, team.id, 'parallel-1', { now: 3000 })
  assert.equal(task.status, 'cancelled')
  assert.equal(assertTeamTaskRetry(state, task, {
    teamId: team.id, target: 'C-WORKER-1', text: 'Continue the accepted work.', files: [],
    parentTaskId: 'task-parent',
  }), task)
  assert.throws(() => assertTeamTaskRetry(state, task, {
    teamId: team.id, target: 'C-WORKER-1', text: 'Different continuation.', files: [],
    parentTaskId: 'task-parent',
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
  assert.equal(task.instruction, 'Do the work.')
  assert.equal(task.acceptedAt, new Date(4000).toISOString())
  const { reply } = appendTeamTaskReply(state, task.id, { fromChannel: 'C-WORKER-1', text: 'Halfway.', requestId: 'reply-1', now: 5000 })
  assert.equal(reply.text, 'Halfway.')
  assert.equal(reply.fileDeliveryStatus, 'none')
  const duplicateReply = appendTeamTaskReply(state, task.id, { fromChannel: 'C-WORKER-1', text: 'Halfway.', requestId: 'reply-1', now: 5500 })
  assert.equal(duplicateReply.created, false)
  assert.equal(task.replies.length, 1)
  assert.throws(() => appendTeamTaskReply(state, task.id, { fromChannel: 'C-WORKER-2', text: 'Spoof.', requestId: 'reply-2' }),
    error => error.code === 'reply_not_allowed')
  delete task.completionPolicy // persisted pre-two-phase task
  completeTeamTask(state, task.id, { targetSessionId: 'worker-sid', result: 'Finished.', now: 6000 })
  assert.equal(task.status, 'completed')
  assert.equal(task.result, 'Finished.')
  assert.equal(task.completionDeliveryStatus, 'pending')
  const recoveredReply = appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'Halfway.', requestId: 'reply-1', now: 6500,
  })
  assert.equal(recoveredReply.created, false)
  assert.equal(recoveredReply.reply.id, reply.id)
  assert.throws(() => completeTeamTask(state, task.id, { targetSessionId: 'other', result: 'No.' }),
    error => error.code === 'task_not_running')
  assert.equal(publicTeamTask(task, 'C-MASTER').direction, 'outgoing')
  assert.equal(publicTeamTask(task, 'C-MASTER').instruction, 'Do the work.')
  assert.equal(publicTeamTask(task, 'C-WORKER-1').direction, 'incoming')
  assert.equal(publicTeamTask(task, 'C-MASTER').sourceChannel, undefined)
  assert.equal(publicTeamTask(task, 'C-MASTER').targetChannel, undefined)
  assert.throws(() => publicTeamTask(task, 'C-OTHER'), error => error.code === 'task_not_visible')
})

test('an authenticated task-bound worker reply proves provider acceptance without a lifecycle marker', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Do the work.', requestId: 'reply-proof-1', id: 'task_reply_proof', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: 'worker-sid', targetProvider: 'codex', now: 3000 })

  const appended = appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'Accepted; checking the repository now.', requestId: 'reply-proof', now: 4000,
  })

  assert.equal(appended.created, true)
  assert.equal(appended.accepted, true)
  assert.equal(task.status, 'running')
  assert.equal(task.startedAt, new Date(4000).toISOString())
  assert.equal(task.text, '')
  assert.equal(task.instruction, 'Do the work.')

  const duplicate = appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'Accepted; checking the repository now.', requestId: 'reply-proof', now: 5000,
  })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.accepted, false)
  assert.equal(task.startedAt, new Date(4000).toISOString())
})

test('new tasks separate provider turn reports from explicit coordinator release', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Run CI and merge.', requestId: 'two-phase-1', id: 'task_two_phase', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })

  appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: worker.channel,
    text: 'Implementation is done; CI is still running.',
    pendingGates: ['ci', 'merge'],
    requestId: 'checkpoint-1',
    now: 5000,
  })
  assert.deepEqual(task.pendingGates, ['ci', 'merge'])
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel, summary: 'Done.', requestId: 'complete-too-soon', now: 5100,
  }), error => error.code === 'task_gates_pending')

  appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: worker.channel,
    text: 'CI passed and the merge completed.',
    pendingGates: [],
    requestId: 'checkpoint-2',
    now: 6000,
  })
  const declared = requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id,
    fromChannel: worker.channel,
    summary: 'Merged after CI passed.',
    requestId: 'complete-1',
    now: 7000,
  })
  assert.equal(declared.created, true)
  assert.equal(requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id,
    fromChannel: worker.channel,
    summary: 'Merged after CI passed.',
    requestId: 'complete-1',
    now: 7100,
  }).created, false)

  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id,
    result: 'Final provider report.',
    now: 8000,
  })
  assert.equal(task.status, 'awaiting_release')
  assert.equal(task.reports.length, 1)
  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id,
    result: 'A duplicate lifecycle path must not create another report.',
    now: 8100,
  })
  assert.equal(task.reports.length, 1)
  assert.equal(task.result, 'Final provider report.')
  assert.throws(() => reportTeamTaskTurn(state, task.id, {
    targetSessionId: 'stale-worker-leg', result: 'Spoofed duplicate.', now: 8200,
  }), error => error.code === 'task_target_changed')
  assert.equal(worker.teamActiveTaskId, task.id)
  assert.equal(publicTeamTask(task, 'C-MASTER').releaseReady, true)
  const followUp = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'One final confirmation?', requestId: 'follow-up-1', now: 8500,
  })
  assert.equal(task.completionRequest, null)
  assert.equal(publicTeamTask(task, 'C-MASTER').releaseReady, false)
  assert.throws(() => releaseTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'release-stale', now: 8600,
  }), error => error.code === 'completion_not_declared')
  beginCoordinatorTaskMessageDelivery(state, task.id, followUp.message.id, { now: 8700 })
  assert.equal(task.status, 'awaiting_release')
  deferCoordinatorTaskMessageDelivery(state, task.id, followUp.message.id, { now: 8750 })
  assert.equal(task.status, 'awaiting_release')
  beginCoordinatorTaskMessageDelivery(state, task.id, followUp.message.id, { now: 8775 })
  completeCoordinatorTaskMessageDelivery(state, task.id, followUp.message.id, { now: 8780 })
  assert.equal(task.status, 'running')

  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id,
    fromChannel: worker.channel,
    summary: 'Final confirmation supplied.',
    requestId: 'complete-2',
    now: 8800,
  })
  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id,
    result: 'Confirmed after follow-up.',
    now: 8900,
  })
  assert.equal(teamMutationForRequest(state, worker.channel, 'complete-1', { taskId: task.id }).status, 'accepted')

  const released = releaseTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'release-1', now: 9000,
  })
  assert.equal(released.created, true)
  assert.equal(task.status, 'completed')
  assert.equal(task.lastTransition.reason, 'coordinator_released')
  assert.equal(releaseTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'release-1', now: 9100,
  }).created, false)
  const completionRetry = requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id,
    fromChannel: worker.channel,
    summary: 'Final confirmation supplied.',
    requestId: 'complete-2',
    now: 9200,
  })
  assert.equal(completionRetry.created, false)
  assert.equal(completionRetry.request.summary, 'Final confirmation supplied.')
  assert.equal(task.status, 'completed')
})

test('delivery-time coordinator follow-up wins a concurrent worker report', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Verify the result.', requestId: 'race-task', id: 'task_follow_up_race', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })

  const followUp = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'Confirm the runtime proof.', requestId: 'race-follow-up', now: 5000,
  })
  assert.equal(followUp.message.resumesTask, false)
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'Ready before follow-up delivery.', requestId: 'race-complete', now: 5100,
  }), error => error.code === 'task_message_in_flight')
  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id, result: 'First report.', now: 5200,
  })
  assert.equal(task.status, 'awaiting_release')

  beginCoordinatorTaskMessageDelivery(state, task.id, followUp.message.id, { now: 5300 })
  assert.equal(followUp.message.resumesTask, true)
  assert.equal(followUp.message.invalidatedCompletion, undefined)
  assert.equal(task.completionRequest, null)
  assert.equal(task.status, 'awaiting_release')
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'This readiness predates the delivered follow-up.', requestId: 'race-too-early', now: 5350,
  }), error => error.code === 'task_message_in_flight')
  completeCoordinatorTaskMessageDelivery(state, task.id, followUp.message.id, { now: 5360 })
  assert.equal(task.status, 'running')
  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'Ready after receiving the follow-up.', requestId: 'race-after-delivery', now: 5375,
  })
  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id, result: 'Second report after the follow-up.', now: 5400,
  })
  assert.equal(task.status, 'awaiting_release')
  assert.equal(task.reports.length, 2)
  assert.equal(task.reports.at(-1).result, 'Second report after the follow-up.')
  assert.equal(publicTeamTask(task, 'C-MASTER').releaseReady, true)
})

test('bounded undelivered reports receive a fresh Slack idempotency identity', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Produce many progress reports.', requestId: 'bounded-reports',
    id: 'task_bounded_reports', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })

  for (let generation = 1; generation <= 32; generation++) {
    task.status = 'running'
    task.providerWorkGeneration = generation
    reportTeamTaskTurn(state, task.id, {
      targetSessionId: worker.id, providerWorkGeneration: generation,
      result: `Report ${generation}.`, now: 3000 + generation,
    })
  }
  const displacedId = task.reports.at(-1).id
  task.status = 'running'
  task.providerWorkGeneration = 33
  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id, providerWorkGeneration: 33,
    result: 'Report 33.', now: 4000,
  })

  assert.equal(task.reports.length, 32)
  assert.notEqual(task.reports.at(-1).id, displacedId)
  assert.equal(new Set(task.reports.map(report => report.id)).size, 32)
  assert.equal(task.reports.at(-1).result, 'Report 33.')
  assert.equal(task.reports.at(-1).coalescedCount, 2)
})

test('queued follow-ups recompute whether each delivery resumes the task', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Verify the result.', requestId: 'queued-follow-ups-task',
    id: 'task_queued_follow_ups', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id, result: 'Initial report.', now: 4500,
  })

  const first = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'First follow-up.', requestId: 'queued-follow-up-1', now: 5000,
  }).message
  const second = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'Second follow-up.', requestId: 'queued-follow-up-2', now: 5100,
  }).message
  assert.equal(first.resumesTask, true)
  assert.equal(second.resumesTask, true)

  beginCoordinatorTaskMessageDelivery(state, task.id, first.id, { now: 5200 })
  completeCoordinatorTaskMessageDelivery(state, task.id, first.id, { now: 5300 })
  assert.equal(task.status, 'running')

  beginCoordinatorTaskMessageDelivery(state, task.id, second.id, { now: 5400 })
  assert.equal(second.resumesTask, false)
  completeCoordinatorTaskMessageDelivery(state, task.id, second.id, { now: 5500 })
  assert.equal(second.resumesTask, false)
})

test('a completion declaration heals dispatching into authenticated running state', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Verify the result.', requestId: 'completion-proof-task',
    id: 'task_completion_proof', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })

  const declared = requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'All gates are clear.', requestId: 'completion-proof', now: 4000,
  })
  assert.equal(declared.created, true)
  assert.equal(declared.accepted, true)
  assert.equal(task.status, 'running')
  assert.equal(task.acceptedAt, new Date(4000).toISOString())
})

test('accepted coordinator messages fence readiness until exact provider delivery', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Verify the result.', requestId: 'pending-message-task',
    id: 'task_pending_message', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })

  const followUp = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'Also verify the runtime proof.',
    requestId: 'pending-message', now: 5000,
  }).message
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'Ready without the follow-up.', requestId: 'pending-message-complete', now: 5100,
  }), error => error.code === 'task_message_in_flight')

  beginCoordinatorTaskMessageDelivery(state, task.id, followUp.id, { now: 5200 })
  completeCoordinatorTaskMessageDelivery(state, task.id, followUp.id, { now: 5300 })
  const declared = requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'Ready after the follow-up.', requestId: 'pending-message-complete', now: 5400,
  })
  assert.equal(declared.created, true)
})

test('an authenticated prompt acknowledgement settles an uncertain coordinator follow-up exactly once', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Verify the result.', requestId: 'ack-task',
    id: 'task_ack_follow_up', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  const followUp = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'Also verify the runtime proof.',
    requestId: 'ack-follow-up', now: 5000,
  }).message
  beginCoordinatorTaskMessageDelivery(state, task.id, followUp.id, { now: 5100 })
  followUp.providerDeliveryStatus = 'uncertain'
  followUp.deliveryStatus = 'failed'
  followUp.deliveryError = 'tmux write outcome was uncertain'

  const acknowledged = acknowledgeCoordinatorTaskMessageDelivery(state, task.id, {
    targetSessionId: worker.id,
    providerWorkGeneration: followUp.workGeneration,
    now: 5200,
  })
  assert.equal(acknowledged.created, true)
  assert.equal(acknowledged.message.id, followUp.id)
  assert.equal(followUp.providerDeliveryStatus, 'delivered')
  assert.equal(followUp.deliveryStatus, 'delivered')
  assert.equal(followUp.deliveryError, null)
  assert.equal(task.providerWorkGeneration, followUp.workGeneration)
  assert.equal(task.status, 'running')

  const version = task.lifecycleVersion
  const duplicate = acknowledgeCoordinatorTaskMessageDelivery(state, task.id, {
    targetSessionId: worker.id,
    providerWorkGeneration: followUp.workGeneration,
    now: 5300,
  })
  assert.equal(duplicate.created, false)
  assert.equal(task.lifecycleVersion, version)
  completeCoordinatorTaskMessageDelivery(state, task.id, followUp.id, { now: 5400 })
  assert.equal(task.lifecycleVersion, version)
})

test('worker turn reports deduplicate by provider work generation', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'claude',
    target: 'parallel-1', text: 'Verify the result.', requestId: 'report-generation-task',
    id: 'task_report_generation', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'claude', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  const oldGeneration = task.providerWorkGeneration

  const followUp = appendCoordinatorTaskMessage(state, task.id, {
    sourceChannel: 'C-MASTER', text: 'Also verify the runtime proof.',
    requestId: 'report-generation-message', now: 5000,
  }).message
  beginCoordinatorTaskMessageDelivery(state, task.id, followUp.id, { now: 5100 })
  completeCoordinatorTaskMessageDelivery(state, task.id, followUp.id, { now: 5200 })
  assert.ok(task.providerWorkGeneration > oldGeneration)

  const stale = reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id, result: 'Final from the earlier provider turn.',
    providerWorkGeneration: oldGeneration, now: 5300,
  })
  assert.equal(stale.created, false)
  assert.equal(stale.stale, true)
  assert.equal(task.status, 'running')
  assert.equal(task.reports?.length || 0, 0)
  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'Ready after receiving the follow-up.', requestId: 'report-generation-complete', now: 5350,
  })
  assert.throws(() => releaseTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'report-generation-release-early', now: 5375,
  }), error => error.code === 'task_not_awaiting_release')

  const current = reportTeamTaskTurn(state, task.id, {
    targetSessionId: worker.id, result: 'Final after the delivered follow-up.',
    providerWorkGeneration: task.providerWorkGeneration, now: 5400,
  })
  assert.equal(current.created, true)
  assert.equal(task.status, 'awaiting_release')
  assert.equal(task.reports.length, 1)
  assert.equal(task.reports[0].result, 'Final after the delivered follow-up.')
  assert.equal(publicTeamTask(task, 'C-MASTER').releaseReady, true)
})

test('the bounded reply journal reserves capacity to clear the final gate', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Long-running validation.', requestId: 'gate-capacity-task',
    id: 'task_gate_capacity', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'CI is pending.', pendingGates: ['ci'],
    requestId: 'gate-checkpoint-1', now: 5000,
  })
  for (let index = 1; index < 31; index++) {
    appendTeamTaskReply(state, task.id, {
      fromChannel: 'C-WORKER-1', text: `Progress ${index}.`, requestId: `gate-progress-${index}`, now: 5000 + index,
    })
  }
  assert.equal(task.replies.length, 31)
  assert.throws(() => appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'One more progress note.', requestId: 'gate-progress-overflow', now: 5100,
  }), error => error.code === 'reply_limit')
  assert.throws(() => appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'CI remains pending.', pendingGates: ['ci'],
    requestId: 'gate-still-pending-overflow', now: 5200,
  }), error => error.code === 'reply_limit')

  appendTeamTaskCheckpoint(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'CI passed.', pendingGates: [],
    requestId: 'gate-cleared-final-slot', now: 5300,
  })
  assert.equal(task.replies.length, 32)
  assert.deepEqual(task.pendingGates, [])
  assert.equal(requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'worker', fromChannel: 'C-WORKER-1', summary: 'All gates passed.',
    requestId: 'gate-capacity-complete', now: 5400,
  }).created, true)
})

test('provider final remains backward-compatible for tasks without a completion policy', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'claude',
    target: 'parallel-1', text: 'Legacy work.', requestId: 'legacy-final-1', id: 'task_legacy_final', now: 2000,
  })
  delete task.completionPolicy
  claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'claude', now: 3000 })
  reportTeamTaskTurn(state, task.id, { targetSessionId: 'worker', result: 'Legacy done.', now: 4000 })
  assert.equal(task.status, 'completed')
  assert.equal(task.result, 'Legacy done.')

  task.status = 'running'
  task.replies = []
  for (let index = 0; index < 32; index++) {
    appendTeamTaskReply(state, task.id, {
      fromChannel: 'C-WORKER-1', text: `Legacy progress ${index}.`,
      requestId: `legacy-progress-${index}`, now: 5000 + index,
    })
  }
  assert.equal(task.replies.length, 32)
})

test('mutation receipts expose accepted state and session binding repair is exact', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Repair me.', requestId: 'repair-send', id: 'task_repair', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: worker.id, targetProvider: 'codex', now: 3000 })
  assert.equal(worker.teamActiveTaskId, undefined)
  const repair = reconcileTeamSessionBindings(state, { now: 4000 })
  assert.equal(repair.changed, true)
  assert.equal(worker.teamActiveTaskId, task.id)
  assert.equal(worker.teamAvailabilityReason, 'restored_durable_task_binding')
  const receipt = teamMutationForRequest(state, 'C-MASTER', 'repair-send', { taskId: task.id })
  assert.deepEqual({ kind: receipt.kind, taskId: receipt.taskId, status: receipt.status }, {
    kind: 'send', taskId: task.id, status: 'accepted',
  })
  task.status = 'completed'
  reconcileTeamSessionBindings(state, { now: 5000 })
  assert.equal(worker.teamActiveTaskId, undefined)
})

test('a task creation request ID cannot be reused for coordinator control', () => {
  const { state, team } = fixture()
  const queued = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Original task.', requestId: 'same-request', id: 'task_collision_queued', now: 2000,
  }).task

  assert.throws(() => replaceQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', text: 'Replacement.', requestId: 'same-request', now: 2100,
  }), error => error.code === 'request_conflict')
  assert.equal(queued.instruction, 'Original task.')
  assert.throws(() => cancelQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', requestId: 'same-request', now: 2200,
  }), error => error.code === 'request_conflict')
  assert.equal(queued.status, 'queued')

  claimTeamTask(state, queued.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 3000 })
  assert.throws(() => appendCoordinatorTaskMessage(state, queued.id, {
    sourceChannel: 'C-MASTER', text: 'Follow up.', requestId: 'same-request', now: 4000,
  }), error => error.code === 'request_conflict')
  assert.deepEqual(queued.messages, [])
  assert.deepEqual(teamMutationForRequest(state, 'C-MASTER', 'same-request', { taskId: queued.id }), {
    requestId: 'same-request',
    kind: 'send',
    status: 'accepted',
    resourceId: queued.id,
    taskId: queued.id,
    taskStatus: 'dispatching',
    lifecycleVersion: queued.lifecycleVersion,
    acceptedAt: queued.createdAt,
  })
})

test('worker request IDs cannot collide across replies and completion declarations', () => {
  const { state, team } = fixture()
  const task = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Worker task.', requestId: 'worker-collision-task', id: 'task_worker_collision', now: 2000,
  }).task
  claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text: 'Progress.', requestId: 'worker-same-request', now: 5000,
  })
  assert.throws(() => requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'worker', fromChannel: 'C-WORKER-1', summary: 'Ready.',
    requestId: 'worker-same-request', now: 6000,
  }), error => error.code === 'request_conflict')
  assert.equal(task.completionRequest, null)
})

test('binding repair refuses to choose between conflicting durable tasks', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  for (const [id, requestId] of [['task_conflict_a', 'conflict-a'], ['task_conflict_b', 'conflict-b']]) {
    const task = createTeamTask(state, {
      teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
      target: 'parallel-1', text: id, requestId, id, now: 2000,
    }).task
    claimTeamTask(state, task.id, { targetSessionId: worker.id, targetProvider: 'codex', now: 3000 })
  }

  const reconciliation = reconcileTeamSessionBindings(state, { now: 4000 })
  assert.equal(reconciliation.changed, false)
  assert.equal(worker.teamActiveTaskId, undefined)
  assert.deepEqual(reconciliation.anomalies[0].taskIds, ['task_conflict_a', 'task_conflict_b'])
})

test('an awaiting-release task survives restart and fences the next queued task until release', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid', channel: 'C-WORKER-1' }
  state.sessions[worker.id] = worker
  state.channels[worker.channel] = worker.id
  const first = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'First task.', requestId: 'restart-release-1', id: 'task_restart_release', now: 2000,
  }).task
  const second = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Second task.', requestId: 'restart-release-2', id: 'task_after_release', now: 2100,
  }).task
  claimTeamTaskForSession(state, first.id, worker, { targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, first.id, { now: 4000 })
  requestTeamTaskCompletion(state, first.id, {
    targetSessionId: worker.id, fromChannel: worker.channel,
    summary: 'First task is complete.', requestId: 'restart-complete', now: 5000,
  })
  reportTeamTaskTurn(state, first.id, { targetSessionId: worker.id, result: 'Ready.', now: 6000 })

  const recovered = JSON.parse(JSON.stringify(state))
  delete recovered.sessions[worker.id].teamActiveTaskId
  const repair = reconcileTeamSessionBindings(recovered, { now: 7000 })
  assert.equal(repair.changed, true)
  assert.equal(recovered.sessions[worker.id].teamActiveTaskId, first.id)
  assert.equal(recovered.teamTasks[first.id].status, 'awaiting_release')
  assert.equal(recovered.teamTasks[second.id].status, 'queued')
  assert.throws(() => claimTeamTaskForSession(recovered, second.id, recovered.sessions[worker.id], {
    targetProvider: 'codex', now: 7500,
  }), error => error.code === 'worker_busy')

  releaseTeamTask(recovered, first.id, {
    sourceChannel: 'C-MASTER', requestId: 'restart-release-final', now: 8000,
  })
  delete recovered.sessions[worker.id].teamActiveTaskId
  claimTeamTaskForSession(recovered, second.id, recovered.sessions[worker.id], {
    targetProvider: 'codex', now: 9000,
  })
  assert.equal(recovered.teamTasks[second.id].status, 'dispatching')
})

test('a rejected worker reply cannot acknowledge a dispatching task', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Do the work.', requestId: 'reply-reject-1', id: 'task_reply_reject', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: 'worker-sid', targetProvider: 'codex', now: 3000 })

  assert.throws(() => appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-2', text: 'Spoofed.', requestId: 'reply-spoof', now: 4000,
  }), error => error.code === 'reply_not_allowed')
  assert.equal(task.status, 'dispatching')
  assert.equal(task.startedAt, undefined)
  assert.equal(task.text, 'Do the work.')
})

test('an idempotent reply retry heals a pre-upgrade dispatching journal', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Do the work.', requestId: 'reply-heal-1', id: 'task_reply_heal', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: 'worker-sid', targetProvider: 'codex', now: 3000 })
  const text = 'Already working.'
  appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text, requestId: 'reply-heal', now: 3500,
  })
  // Recreate the state shape written by an older daemon: the reply was
  // durable, but the task never left `dispatching`.
  task.status = 'dispatching'
  task.text = 'Do the work.'
  delete task.startedAt

  const duplicate = appendTeamTaskReply(state, task.id, {
    fromChannel: 'C-WORKER-1', text, requestId: 'reply-heal', now: 4000,
  })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.accepted, true)
  assert.equal(task.status, 'running')
  assert.equal(task.startedAt, new Date(4000).toISOString())
})

test('bounded journal pruning returns exact removed records for staged-file cleanup', () => {
  const { state, team } = fixture()
  for (let index = 0; index < 3; index++) {
    const { task } = createTeamTask(state, {
      teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
      target: 'parallel-1', text: `Finished ${index}`, requestId: `prune-${index}`, id: `task_prune_${index}`,
      now: 1000 + index,
    })
    claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 2000 + index })
    delete task.completionPolicy
    completeTeamTask(state, task.id, { targetSessionId: 'worker', result: 'done', now: 3000 + index })
    task.completionDeliveryStatus = 'delivered'
  }
  const removed = pruneTeamTasks(state, { now: 4000, max: 1 })
  assert.deepEqual(removed.map(task => task.id), ['task_prune_0', 'task_prune_1'])
  assert.deepEqual(Object.keys(state.teamTasks), ['task_prune_2'])
})

test('journal pruning retains terminal tasks until every durable delivery settles', () => {
  const { state, team } = fixture()
  const make = (id, now) => {
    const { task } = createTeamTask(state, {
      teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
      target: 'parallel-1', text: id, requestId: id, id: `task_${id}`, now,
    })
    claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'codex', now: now + 1 })
    delete task.completionPolicy
    completeTeamTask(state, task.id, { targetSessionId: 'worker', result: 'done', now: now + 2 })
    return task
  }
  const pendingCompletion = make('pending_completion', 1000)
  const pendingReply = make('pending_reply', 2000)
  pendingReply.completionDeliveryStatus = 'delivered'
  pendingReply.replies.push({ text: 'update', textSlackTs: null, files: [], fileDeliveryStatus: 'none' })
  const delivered = make('delivered', 3000)
  delivered.completionDeliveryStatus = 'delivered'

  assert.equal(teamTaskDeliverySettled(pendingCompletion), false)
  assert.equal(teamTaskDeliverySettled(pendingReply), false)
  assert.equal(teamTaskDeliverySettled(delivered), true)
  assert.deepEqual(pruneTeamTasks(state, { now: 10 * 24 * 60 * 60 * 1000, max: 0 }).map(task => task.id),
    ['task_delivered'])
  assert.deepEqual(Object.keys(state.teamTasks).sort(), ['task_pending_completion', 'task_pending_reply'])
})

test('restart recovery preserves one dispatch claim and rejects late completion from another leg', () => {
  const { state, team } = fixture()
  createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Exactly once.', requestId: 'restart-1', id: 'task_restart', now: 2000,
  })
  claimTeamTask(state, 'task_restart', { targetSessionId: 'worker-original', targetProvider: 'claude', now: 3000 })
  delete state.teamTasks.task_restart.completionPolicy
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
  assert.throws(() => consumeCoordinatorDispatch(session, { now: 4000 }), error => error.code === 'dispatch_budget_exhausted')
  beginCollaboratorTeamTurn(session, { messageTs: '1.3' }, { now: 5000 })
  assert.throws(() => consumeCoordinatorDispatch(session, { now: 6000 }), error => error.code === 'owner_turn_required')
  clearTeamTurn(session)
  assert.equal(session.teamTurn, undefined)
})

test('automatic continuation authority is bounded and exact-team only', () => {
  const session = {}
  beginContinuationTeamTurn(session, {
    teamId: 'team_hexagonal', eventId: 'team_event_reply_1',
  }, { now: 1000, budget: 2 })

  assert.throws(() => consumeCoordinatorDispatch(session, {
    now: 2000, teamId: 'team_hexagonal', allowContinuation: false,
  }), error => error.code === 'owner_turn_required')
  assert.throws(() => consumeCoordinatorDispatch(session, {
    now: 2000, teamId: 'team_other', allowContinuation: true,
  }), error => error.code === 'owner_turn_required')

  consumeCoordinatorDispatch(session, {
    now: 2000, teamId: 'team_hexagonal', allowContinuation: true,
  })
  consumeCoordinatorDispatch(session, {
    now: 3000, teamId: 'team_hexagonal', allowContinuation: true,
  })
  assert.throws(() => consumeCoordinatorDispatch(session, {
    now: 4000, teamId: 'team_hexagonal', allowContinuation: true,
  }), error => error.code === 'dispatch_budget_exhausted')
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
  assert.match(prompt, /<sab-team-task[^>]*generation="1"/)
  assert.match(prompt, /Origin: coordinator/)
  assert.doesNotMatch(prompt, /C-MASTER/)
  assert.match(prompt, /sab team reply --task task_prompt/)
  assert.match(prompt, /provider turn ending reports progress/)
  assert.match(prompt, /sab team complete --task task_prompt/)
  assert.match(prompt, /\/private\/attachment\/report\.txt/)

  delete task.completionPolicy
  const legacyPrompt = delegatedTaskPrompt(team, task)
  assert.match(legacyPrompt, /stable final answer will be returned automatically/)
  assert.doesNotMatch(legacyPrompt, /sab team (?:checkpoint|complete|release)/)
  assert.deepEqual(withoutDelegatedTaskPrompt([
    'ordinary queued prompt',
    prompt,
    { text: prompt, route: 'native' },
  ], 'task_prompt'), ['ordinary queued prompt'])
})

test('legacy empty provider finals remain failures while explicit hookless proof remains a warning', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker', channel: 'C-WORKER-1' }
  const workerTwo = { id: 'worker-two', channel: 'C-WORKER-2' }
  state.sessions[worker.id] = worker
  state.sessions[workerTwo.id] = workerTwo
  state.channels[worker.channel] = worker.id
  state.channels[workerTwo.channel] = workerTwo.id
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Legacy work.', requestId: 'legacy-empty', id: 'task_legacy_empty',
  })
  delete task.completionPolicy
  claimTeamTaskForSession(state, task.id, worker, { targetProvider: 'claude', now: 2000 })
  markTeamTaskRunning(state, task.id, { now: 2100 })

  const empty = reportTeamTaskTurn(state, task.id, {
    targetSessionId: 'worker', result: '', now: 2200,
  })
  assert.equal(empty.task.status, 'failed')
  assert.match(empty.task.error, /without a stable final response/)

  const { task: warningTask } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-2', text: 'Legacy hookless work.', requestId: 'legacy-warning', id: 'task_legacy_warning',
  })
  delete warningTask.completionPolicy
  claimTeamTaskForSession(state, warningTask.id, workerTwo, { targetProvider: 'codex', now: 2300 })
  markTeamTaskRunning(state, warningTask.id, { now: 2400 })
  const warning = reportTeamTaskTurn(state, warningTask.id, {
    targetSessionId: 'worker-two', result: '', warning: 'Continuously observed idle.', now: 2500,
  })
  assert.equal(warning.task.status, 'completed_with_warning')
})

test('linked continuations resolve an immutable worker channel after its alias changes', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Original work.', requestId: 'alias-original', id: 'task_alias_original', now: 2000,
  })
  delete task.completionPolicy
  claimTeamTask(state, task.id, { targetSessionId: 'worker-sid', targetProvider: 'codex', now: 3000 })
  completeTeamTask(state, task.id, { targetSessionId: 'worker-sid', result: 'Done.', now: 4000 })
  removeTeamWorker(state, team.id, 'parallel-1', { now: 5000 })
  addTeamWorker(state, team.id, { channel: 'C-WORKER-1', alias: 'renamed-worker', now: 6000 })

  const continuation = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: task.targetChannel, text: 'Follow up.', parentTaskId: task.id,
    requestId: 'alias-continuation', id: 'task_alias_continuation', now: 7000,
  }).task
  assert.equal(continuation.targetChannel, 'C-WORKER-1')
  assert.equal(continuation.targetAlias, 'renamed-worker')
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

test('dispatch claim atomically binds worker availability and a populated start timestamp', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid' }
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Atomic work.', requestId: 'atomic-1', id: 'task_atomic', now: 2000,
  })
  claimTeamTaskForSession(state, task.id, worker, {
    targetProvider: 'codex', targetNodeId: 'local', now: 3000,
  })
  assert.equal(task.status, 'dispatching')
  assert.equal(task.startedAt, new Date(3000).toISOString())
  assert.equal(worker.teamActiveTaskId, task.id)
  assert.equal(task.targetSessionId, worker.id)
  assert.equal(task.lifecycleVersion, 2)
})

test('dispatch claim binds the exact fully-audited instruction revision', () => {
  const { state, team } = fixture()
  const worker = { id: 'worker-sid' }
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Current instruction.', requestId: 'revision-1', id: 'task_revision', now: 2000,
  })
  task.instructionVersion = 2
  task.payloadAuditInstructionVersion = 2

  assert.throws(() => claimTeamTaskForSession(state, task.id, worker, {
    targetProvider: 'codex', expectedInstructionVersion: 1, expectedAuditInstructionVersion: 1,
  }), error => error.code === 'task_revision_changed')
  assert.equal(task.status, 'queued')
  assert.equal(worker.teamActiveTaskId, undefined)

  assert.throws(() => claimTeamTaskForSession(state, task.id, worker, {
    targetProvider: 'codex', expectedInstructionVersion: 2, expectedAuditInstructionVersion: 1,
  }), error => error.code === 'task_audit_stale')
  assert.equal(task.status, 'queued')
  assert.equal(worker.teamActiveTaskId, undefined)

  claimTeamTaskForSession(state, task.id, worker, {
    targetProvider: 'codex', expectedInstructionVersion: 2, expectedAuditInstructionVersion: 2, now: 3000,
  })
  assert.equal(task.status, 'dispatching')
  assert.equal(worker.teamActiveTaskId, task.id)
})

test('an idle acknowledged worker can complete with a lifecycle warning instead of false failure', () => {
  const { state, team } = fixture()
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Finish safely.', requestId: 'warning-1', id: 'task_warning', now: 2000,
  })
  claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  delete task.completionPolicy
  completeTeamTaskWithWarning(state, task.id, {
    targetSessionId: 'worker', result: 'Last authenticated progress.',
    warning: 'Provider completion hook was missing.', now: 5000,
  })
  assert.equal(task.status, 'completed_with_warning')
  assert.equal(task.result, 'Last authenticated progress.')
  assert.equal(task.warning, 'Provider completion hook was missing.')
  assert.equal(publicTeamTask(task, 'C-MASTER').status, 'completed_with_warning')
})

test('coordinator can cancel or replace only queued work and message only its active task', () => {
  const { state, team } = fixture()
  const queued = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Old instruction.', requestId: 'control-1', id: 'task_control', now: 2000,
  }).task
  const replacement = replaceQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', text: 'New instruction.', requestId: 'replace-1', now: 3000,
  })
  assert.equal(replacement.created, true)
  assert.equal(queued.text, 'New instruction.')
  assert.equal(replaceQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', text: 'New instruction.', requestId: 'replace-1', now: 3500,
  }).created, false)
  assert.throws(() => replaceQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', text: 'Conflicting instruction.', requestId: 'replace-1', now: 3600,
  }), error => error.code === 'request_conflict')

  const cancelled = cancelQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', reason: 'No longer needed.', now: 4000,
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', reason: 'No longer needed.', now: 4500,
  }).status, 'cancelled')
  assert.equal(cancelQueuedTeamTask(state, queued.id, {
    sourceChannel: 'C-MASTER', reason: 'A different retry description.', requestId: 'cancel-again', now: 4600,
  }).status, 'cancelled')

  const active = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Active instruction.', requestId: 'control-2', id: 'task_active', now: 5000,
  }).task
  claimTeamTask(state, active.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 6000 })
  markTeamTaskRunning(state, active.id, { now: 7000 })
  const message = appendCoordinatorTaskMessage(state, active.id, {
    sourceChannel: 'C-MASTER', text: 'Yes, proceed.', requestId: 'message-1', now: 8000,
  })
  assert.equal(message.created, true)
  assert.equal(appendCoordinatorTaskMessage(state, active.id, {
    sourceChannel: 'C-MASTER', text: 'Yes, proceed.', requestId: 'message-1', now: 8500,
  }).created, false)
  assert.equal(publicTeamTask(active, 'C-MASTER').messages[0].text, 'Yes, proceed.')
  delete active.completionPolicy
  completeTeamTask(state, active.id, { targetSessionId: 'worker', result: 'Done.', now: 8750 })
  assert.equal(appendCoordinatorTaskMessage(state, active.id, {
    sourceChannel: 'C-MASTER', text: 'Yes, proceed.', requestId: 'message-1', now: 8800,
  }).created, false)
  assert.throws(() => appendCoordinatorTaskMessage(state, active.id, {
    sourceChannel: 'C-WORKER-1', text: 'Spoof.', requestId: 'message-2', now: 9000,
  }), error => error.code === 'task_control_not_allowed')
})

test('queued cancellation remains available after the bounded control journal fills', () => {
  const { state, team } = fixture()
  const task = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Eventually cancel.', requestId: 'cancel-full', id: 'task_cancel_full', now: 2000,
  }).task
  task.controlRequests = Array.from({ length: 32 }, (_, index) => ({
    requestId: `prior-${index}`, kind: 'replace', payloadHash: `hash-${index}`,
  }))
  assert.equal(cancelQueuedTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'cancel-final', now: 3000,
  }).status, 'cancelled')
  assert.equal(task.controlRequests.length, 32)
  assert.throws(() => cancelQueuedTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', reason: 'Conflicting reason.', requestId: 'cancel-final', now: 3100,
  }), error => error.code === 'request_conflict')
  assert.throws(() => cancelQueuedTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'another-cancel', now: 3200,
  }), error => error.code === 'task_control_limit')
})

test('coordinator release remains available after the bounded control journal fills', () => {
  const { state, team } = fixture()
  const task = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Long task.', requestId: 'long-release', id: 'task_long_release', now: 2000,
  }).task
  claimTeamTask(state, task.id, { targetSessionId: 'worker', targetProvider: 'codex', now: 3000 })
  markTeamTaskRunning(state, task.id, { now: 4000 })
  requestTeamTaskCompletion(state, task.id, {
    targetSessionId: 'worker', fromChannel: 'C-WORKER-1', summary: 'Ready.',
    requestId: 'long-release-ready', now: 4500,
  })
  reportTeamTaskTurn(state, task.id, { targetSessionId: 'worker', result: 'Done.', now: 5000 })
  task.controlRequests = Array.from({ length: 32 }, (_, index) => ({
    requestId: `control-${index}`, kind: 'message', payloadHash: `hash-${index}`, createdAt: new Date(5100 + index).toISOString(),
  }))

  assert.equal(releaseTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'release-after-limit', now: 6000,
  }).task.status, 'completed')
  assert.equal(releaseTeamTask(state, task.id, {
    sourceChannel: 'C-MASTER', requestId: 'release-after-limit', now: 6100,
  }).created, false)
})

test('coordinator task control requires a current owner or matching continuation turn without spending dispatch budget', () => {
  const session = {}
  beginOwnerTeamTurn(session, { messageTs: '1.2' }, { now: 1000, budget: 2 })
  assert.equal(assertCoordinatorTaskControl(session, { now: 1100 }).actor, 'owner')
  assert.equal(session.teamTurn.remaining, 2)
  beginContinuationTeamTurn(session, { teamId: 'team_hexagonal', eventId: 'event_1' }, { now: 2000, budget: 2 })
  assert.equal(assertCoordinatorTaskControl(session, {
    now: 2100, teamId: 'team_hexagonal', allowContinuation: true,
  }).actor, 'continuation')
  assert.throws(() => assertCoordinatorTaskControl(session, {
    now: 2100, teamId: 'other', allowContinuation: true,
  }), error => error.code === 'owner_turn_required')
})

test('team drain mode blocks new dispatch without cancelling active or queued records', () => {
  const { state, team } = fixture()
  const queued = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
    target: 'parallel-1', text: 'Wait in queue.', requestId: 'drain-1', id: 'task_drain', now: 2000,
  }).task
  const result = setTeamDispatchMode(team, 'draining', { now: 3000 })
  assert.equal(result.mode, 'draining')
  assert.equal(teamDispatchMode(team), 'draining')
  assert.equal(queued.status, 'queued')
  assert.throws(() => claimTeamTask(state, queued.id, {
    targetSessionId: 'worker', targetProvider: 'codex', now: 3500,
  }), error => error.code === 'team_draining')
  setTeamDispatchMode(team, 'active', { now: 4000 })
  assert.equal(teamDispatchMode(team), 'active')
})

test('filtered inbox pages retain instruction and expose an opaque older-page cursor', () => {
  const { state, team } = fixture()
  for (let index = 0; index < 4; index++) {
    const task = createTeamTask(state, {
      teamId: team.id, sourceChannel: 'C-MASTER', sourceSessionId: 'master', sourceProvider: 'codex',
      target: index % 2 ? 'parallel-2' : 'parallel-1', text: `Instruction ${index}`,
      requestId: `page-${index}`, id: `task_page_${index}`, now: 1000 + index,
    }).task
    if (index === 0) cancelQueuedTeamTask(state, task.id, { sourceChannel: 'C-MASTER', now: 2000 })
  }
  const first = tasksPageForChannel(state, 'C-MASTER', { limit: 2, active: true })
  assert.deepEqual(first.tasks.map(task => task.id), ['task_page_3', 'task_page_2'])
  assert.ok(first.nextCursor)
  const second = tasksPageForChannel(state, 'C-MASTER', { limit: 2, active: true, cursor: first.nextCursor })
  assert.deepEqual(second.tasks.map(task => task.id), ['task_page_1'])
  assert.equal(publicTeamTask(first.tasks[0], 'C-MASTER').instruction, 'Instruction 3')
  assert.deepEqual(tasksPageForChannel(state, 'C-MASTER', {
    target: 'parallel-2', status: ['queued'], since: new Date(1001).toISOString(),
  }).tasks.map(task => task.id), ['task_page_3', 'task_page_1'])
})
