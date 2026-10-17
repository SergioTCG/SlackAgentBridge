import test from 'node:test'
import assert from 'node:assert/strict'
import { captureTaskMaintenance, assertTaskMaintenance, taskMaintenancePending, taskMaintenanceClaimAllowed, proveIdleTaskProcessTree } from '../daemon/account-task-maintenance.mjs'
import { appendCoordinatorTaskMessage, appendTeamTaskReply, requestTeamTaskCompletion, releaseTeamTask } from '../daemon/teams.mjs'

function fixture() {
  const session = { id: 'native', channel: 'CWORK', provider: 'claude', pid: 20, tmux: 'sab-worker', cwd: '/workspace', teamActiveTaskId: 'task-one' }
  const task = { id: 'task-one', teamId: 'team', sourceChannel: 'CCOORD', status: 'awaiting_release', completionPolicy: 'coordinator-release', targetSessionId: 'native',
    targetChannel: 'CWORK', targetProvider: 'claude', workGeneration: 2, providerWorkGeneration: 2, pendingGates: ['review'], messages: [], reports: [{ workGeneration: 2, deliveryStatus: 'delivered' }] }
  const state = { sessions: { native: session }, channels: { CWORK: 'native' }, teamTasks: { 'task-one': task },
    teams: { team: { id: 'team', coordinatorChannel: 'CCOORD', members: { CWORK: { role: 'worker' } } } } }
  return { state, session, task }
}

test('task snapshot binds exact channel/session/generation without declaring or releasing work', () => {
  const { state, session, task } = fixture()
  const snapshot = captureTaskMaintenance(state, session, task.id)
  assertTaskMaintenance(state, session, snapshot)
  session.pid = 30; session.tmux = 'sab-replacement'
  assertTaskMaintenance(state, session, snapshot)
  task.pendingGates.push('merge')
  assert.throws(() => assertTaskMaintenance(state, session, snapshot), /changed/)
})

test('maintenance fences replies, completion, release and coordinator messages until exact settlement', () => {
  const { state, session, task } = fixture()
  const snapshot = captureTaskMaintenance(state, session, task.id)
  state.accountPools = { switches: { CWORK: { phase: 'restarting', taskMaintenance: snapshot } } }
  assert.equal(taskMaintenancePending(state, task), true)
  assert.equal(taskMaintenanceClaimAllowed(state, { sessionId: 'native', tmux: session.tmux, provider: 'claude' }), true)
  assert.equal(taskMaintenanceClaimAllowed(state, { sessionId: 'unexpected-native', tmux: session.tmux, provider: 'claude' }), false)
  assert.equal(taskMaintenanceClaimAllowed(state, { sessionId: 'native', tmux: session.tmux, provider: 'codex' }), false)
  for (const mutate of [() => appendTeamTaskReply(state, task.id, {}), () => requestTeamTaskCompletion(state, task.id, {}),
    () => appendCoordinatorTaskMessage(state, task.id, {}), () => releaseTeamTask(state, task.id, {})]) {
    assert.throws(mutate, error => error.code === 'task_maintenance')
  }
  state.accountPools.switches.CWORK.phase = 'committed'
  assert.equal(taskMaintenancePending(state, task), false)
})

test('task maintenance rejects rebound, nonlocal and undelivered checkpoints without changing other records', () => {
  for (const mutate of [f => { f.state.channels.CWORK = 'replacement' }, f => { f.state.channelNodes = { CWORK: 'remote' } },
    f => { f.task.targetNodeId = 'remote' }, f => { f.task.reports.push({ workGeneration: 2, deliveryStatus: 'pending' }) },
    f => { f.task.sourceChannel = 'COTHER' }, f => { f.session.teamInputReservation = {} }]) {
    const f = fixture(); mutate(f)
    const before = structuredClone(f.state)
    assert.throws(() => captureTaskMaintenance(f.state, f.session, f.task.id))
    assert.deepEqual(f.state, before)
  }
})

test('pending reply text, files and failure notices block maintenance before teardown', () => {
  for (const reply of [{ text: 'progress' }, { text: 'progress', textSlackTs: '1.2', files: [{}], fileDeliveryStatus: 'uploading' },
    { files: [{}], fileDeliveryStatus: 'failed' }]) {
    const { state, session, task } = fixture()
    task.replies = [reply]
    assert.throws(() => captureTaskMaintenance(state, session, task.id), /blocked/)
  }
})

test('process proof rejects arbitrary children, nested jobs, additional panes and a mismatched provider root', async () => {
  const session = { pid: 20, tmux: 'sab-worker' }, bridge = '/bridge'
  const normal = '10 1\n20 10\n21 20\n'
  const mock = ({ tree = normal, command = 'node /bridge/channel/server.mjs', panes = '%1\n' } = {}) => async (bin, args) => ({ stdout:
    args[0] === 'list-panes' ? panes : args[0] === 'display-message' ? '10\n' : args.includes('pid=,ppid=') ? tree : command })
  await proveIdleTaskProcessTree(session, { bridge, execFile: mock() })
  for (const options of [{ command: 'node /workspace/build.mjs' }, { tree: normal + '22 21\n' }, { panes: '%1\n%2\n' }, { tree: '10 1\n20 999\n' }]) {
    await assert.rejects(proveIdleTaskProcessTree(session, { bridge, execFile: mock(options) }), /background|process|pane/)
  }
})
