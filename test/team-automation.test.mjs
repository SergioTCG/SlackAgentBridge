import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AutomationRequestError, createAutomationLifecycle, validateAutomationRequest } from '../daemon/automation.mjs'
import {
  automationSetupPending, automationTaskRequestId, bootstrapTaskHold, createAutomationTeamBootstrap,
  detachAutomationTeams, preparedAutomationChannel,
} from '../daemon/team-automation.mjs'
import {
  TEAM_MAX_MEMBERS, TeamError, addTeamWorker, assertCoordinatorDispatch, beginCollaboratorTeamTurn,
  beginContinuationTeamTurn, beginDelegatedTeamTurn, beginOwnerTeamTurn, cancelQueuedTeamTask,
  claimTeamTaskForSession, closeTeam, commitTeamWorkerReservation, coordinatedTeamForChannel, createTeam,
  parentTeamForChannel, releaseTeamWorkerReservation, reserveTeamWorker, setTeamAutoRelease, teamAutoRelease,
  teamContext,
} from '../daemon/teams.mjs'
import { setContinuationMode } from '../daemon/team-continuation.mjs'

function teamState() {
  const state = {
    sessions: { coord: { id: 'coord', channel: 'C-COORD', provider: 'claude', pid: 10, tmux: 'sab-coord' } },
    channels: { 'C-COORD': 'coord' },
  }
  const team = createTeam(state, { id: 'team_epic', name: 'epic-2995', coordinatorChannel: 'C-COORD', createdBy: 'U-OWNER', now: 1 })
  return { state, team }
}

test('worker reservations hold the member bound and alias until their channel exists', () => {
  const { state, team } = teamState()
  for (let index = 1; index < TEAM_MAX_MEMBERS - 1; index++) {
    addTeamWorker(state, team.id, { channel: `C-W${index}`, alias: `worker-${index}` })
  }
  const reservation = reserveTeamWorker(state, team.id, {
    key: 'issue:1', alias: 'Executor-1', provenance: { kind: 'automation', externalKey: 'issue:1' }, now: 5,
  })
  assert.equal(reservation.alias, 'executor-1')
  // Reserving again with the same key is idempotent; a different alias conflicts.
  assert.equal(reserveTeamWorker(state, team.id, { key: 'issue:1', alias: 'executor-1' }), reservation)
  assert.throws(() => reserveTeamWorker(state, team.id, { key: 'issue:1', alias: 'other' }),
    error => error.code === 'reservation_conflict')
  // The pending slot fills the team: neither a reservation nor an owner add fits.
  assert.throws(() => reserveTeamWorker(state, team.id, { key: 'issue:2', alias: 'executor-2' }),
    error => error.code === 'team_full')
  assert.throws(() => addTeamWorker(state, team.id, { channel: 'C-LATE', alias: 'late' }),
    error => error.code === 'team_full')
  assert.equal(teamContext(state, 'C-COORD').peers.some(peer => peer.alias === 'executor-1'), false)

  const member = commitTeamWorkerReservation(state, team.id, 'issue:1', { channel: 'C-NEW', now: 6 })
  assert.equal(member.alias, 'executor-1')
  assert.deepEqual(member.addedBy, { kind: 'automation', externalKey: 'issue:1' })
  assert.equal(team.pendingMembers, undefined)
  assert.equal(teamContext(state, 'C-NEW').role, 'worker')
  assert.throws(() => commitTeamWorkerReservation(state, team.id, 'issue:1', { channel: 'C-OTHER' }),
    error => error.code === 'reservation_not_found')
})

test('a reserved alias is unavailable to other workers and released reservations free it', () => {
  const { state, team } = teamState()
  reserveTeamWorker(state, team.id, { key: 'issue:1', alias: 'executor-1' })
  assert.throws(() => addTeamWorker(state, team.id, { channel: 'C-W', alias: 'executor-1' }),
    error => error.code === 'alias_in_use')
  assert.equal(releaseTeamWorkerReservation(state, team.id, 'issue:1'), true)
  assert.equal(releaseTeamWorkerReservation(state, team.id, 'issue:1'), false)
  addTeamWorker(state, team.id, { channel: 'C-W', alias: 'executor-1' })
  reserveTeamWorker(state, team.id, { key: 'issue:2', alias: 'executor-2' })
  closeTeam(state, team.id)
  assert.equal(team.pendingMembers, undefined)
})

function automationFixture(t, { authorizeCaller = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-team-automation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'worktree-')))
  const { state, team } = teamState()
  state.automations = {}
  const coordinator = state.sessions.coord
  beginOwnerTeamTurn(coordinator, { messageTs: '1.0' }, { now: Date.now(), budget: 3 })
  const queue = []
  const calls = { prepare: [], launch: [], inject: [], ready: [], joined: [], notify: [], invite: [] }
  let clock = 10_000
  const bootstrap = createAutomationTeamBootstrap({
    state,
    resolveCaller: async caller => {
      if (authorizeCaller) return authorizeCaller(caller)
      if (caller?.tmux !== 'sab-coord') throw new TeamError('unauthorized_session', 'not the exact session', 403)
      return coordinator
    },
    requireDispatch: (session, current) => assertCoordinatorDispatch(session, {
      teamId: current.id, allowContinuation: current.continuation?.mode === 'auto-until-blocked',
    }) && { teamId: current.id, allowContinuation: current.continuation?.mode === 'auto-until-blocked' },
    ready: record => calls.ready.push(record.externalKey),
    joined: async record => calls.joined.push(record.externalKey),
    now: () => clock,
  })
  let prepare = async (record, options) => {
    options?.journalName?.(record.channelName || 'generated')
    return { channelId: `C-${record.channelName || 'generated'}`.toUpperCase(), channelName: record.channelName || 'generated' }
  }
  const lifecycle = createAutomationLifecycle({
    state,
    home: root,
    persist: () => {},
    schedule: fn => queue.push(fn),
    launch: async record => calls.launch.push(record.externalKey),
    invite: async (channel, userId) => { calls.invite.push([channel, userId]); return { name: userId } },
    waitForInputReady: async () => {},
    inject: async (session, prompt) => calls.inject.push([session.id, prompt]),
    terminate: async () => {},
    archive: async () => {},
    notifyFailure: async (record, failure) => calls.notify.push([record.externalKey, failure.code]),
    prepareChannel: async (record, options) => { calls.prepare.push(record.externalKey); return prepare(record, options) },
    teamBootstrap: bootstrap,
    now: () => ++clock,
  })
  const request = (overrides = {}) => ({
    externalKey: 'github:barrique#2995',
    cwd,
    provider: 'claude',
    flags: ['--dsp', '--model', 'claude-opus-5-5[1m]'],
    collaborators: ['U098WAUUX5M'],
    initialPrompt: '',
    channelName: 'cc-barrique-2995-vivian-holding-lines',
    team: { name: 'epic-2995', alias: 'issue-2995', task: 'Implement issue 2995 and open a PR.' },
    ...overrides,
  })
  const caller = { ppid: '99', tmux: 'sab-coord', provider: 'claude' }
  const drain = async () => { while (queue.length) await queue.shift()() }
  return {
    root, cwd, state, team, coordinator, calls, lifecycle, request, caller, drain,
    setPrepare: fn => { prepare = fn },
  }
}

test('validation keeps Slack channel names verbatim and team tasks in place of a raw prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-validate-'))
  try {
    const cwd = fs.realpathSync(home)
    const base = { externalKey: 'k', cwd, provider: 'claude', flags: [], collaborators: [], initialPrompt: '' }
    assert.equal(validateAutomationRequest({ ...base, channelName: 'cc-barrique-2995_x' }, { home }).channelName, 'cc-barrique-2995_x')
    assert.equal(validateAutomationRequest(base, { home }).channelName, null)
    for (const channelName of ['', 'Upper', 'has space', 'dot.name', 'x'.repeat(81), 7, 'ümlaut']) {
      assert.throws(() => validateAutomationRequest({ ...base, channelName }, { home }), /channelName/)
    }
    assert.deepEqual(validateAutomationRequest({ ...base, team: { name: 'epic', task: '  Go.  ' } }, { home }).team,
      { name: 'epic', alias: null, task: 'Go.', createTeam: null })
    assert.equal(validateAutomationRequest({ ...base, team: { name: 'main', task: 'Coordinate.', createTeam: 'epic-2990' } }, { home }).team.createTeam,
      'epic-2990')
    assert.throws(() => validateAutomationRequest({ ...base, team: { name: 'main', createTeam: 'Bad Name' } }, { home }), /createTeam/)
    for (const team of [
      'epic', { alias: 'x' }, { name: 'epic', alias: 'Bad Alias' }, { name: 'epic', task: '   ' },
      { name: 'epic', other: true }, { name: 'epic', task: 'x'.repeat(24 * 1024 + 1) }, [{ name: 'epic' }],
    ]) assert.throws(() => validateAutomationRequest({ ...base, team }, { home }), /team/)
    assert.throws(() => validateAutomationRequest({ ...base, initialPrompt: 'raw', team: { name: 'epic', task: 'Go.' } }, { home }),
      /replaces initialPrompt/)
    // A team worker without a task may still receive an ordinary initial prompt.
    assert.equal(validateAutomationRequest({ ...base, initialPrompt: 'raw', team: { name: 'epic' } }, { home }).initialPrompt, 'raw')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

test('a team-bound automation creates its channel, joins the team and queues its task in one journal step', async t => {
  const f = automationFixture(t)
  const { automation, created } = await f.lifecycle.submit(f.request(), { caller: f.caller })
  assert.equal(created, true)
  assert.equal(automation.status, 'pending')
  assert.equal(automation.channelId, 'C-CC-BARRIQUE-2995-VIVIAN-HOLDING-LINES')
  assert.equal(automation.prompt.status, 'team_task')
  assert.equal(automation.initialPrompt, '')
  const member = f.team.members[automation.channelId]
  assert.equal(member.role, 'worker')
  assert.equal(member.alias, 'issue-2995')
  assert.match(member.addedBy.at, /^\d{4}-\d\d-\d\dT/)
  assert.deepEqual({ ...member.addedBy, at: null }, {
    kind: 'automation', externalKey: 'github:barrique#2995', coordinatorChannel: 'C-COORD',
    coordinatorSessionId: 'coord', coordinatorProvider: 'claude', actor: 'owner', at: null,
  })
  assert.equal(f.team.pendingMembers, undefined)
  const task = f.state.teamTasks[automation.team.taskId]
  assert.equal(task.status, 'queued')
  assert.equal(task.targetChannel, automation.channelId)
  assert.equal(task.sourceChannel, 'C-COORD')
  assert.equal(task.instruction, 'Implement issue 2995 and open a PR.')
  assert.equal(task.requestId, automationTaskRequestId('github:barrique#2995'))
  assert.deepEqual(task.bootstrap, { externalKey: 'github:barrique#2995' })
  assert.equal(f.coordinator.teamTurn.remaining, 2, 'creating a worker task consumes one dispatch')
  assert.deepEqual(f.calls.prepare, ['github:barrique#2995'])
  await f.drain()
  assert.deepEqual(f.calls.launch, ['github:barrique#2995'])
  assert.deepEqual(f.calls.joined, ['github:barrique#2995'])

  // The bootstrap task waits for session binding and collaborator setup.
  assert.equal(bootstrapTaskHold(f.state, task), 'wait')
  const session = { id: 'native-1', channel: automation.channelId, tmux: automation.tmux, cwd: f.cwd, provider: 'claude', pid: 11 }
  assert.equal(preparedAutomationChannel(f.state, session, automation.channelId), automation)
  f.state.sessions[session.id] = session
  f.state.channels[session.channel] = session.id
  assert.equal(preparedAutomationChannel(f.state, session, automation.channelId), null)
  assert.equal(f.lifecycle.correlateSessionStart(session), true)
  await f.drain()
  assert.deepEqual(f.calls.invite, [[automation.channelId, 'U098WAUUX5M']])
  assert.equal(automation.status, 'active')
  assert.deepEqual(f.calls.ready, ['github:barrique#2995'])
  assert.deepEqual(f.calls.inject, [], 'the team dispatcher, not a raw prompt, delivers the task')
  assert.equal(bootstrapTaskHold(f.state, task), null)
  const status = f.lifecycle.status(automation.externalKey)
  assert.deepEqual(status.team, {
    teamId: 'team_epic', teamName: 'epic-2995', alias: 'issue-2995', role: 'worker', taskId: task.id,
  })
  assert.equal(status.channelName, 'cc-barrique-2995-vivian-holding-lines')
  assert.equal(status.prompt.status, 'team_task')
})

test('retries with the same external key are idempotent, and a different request conflicts', async t => {
  const f = automationFixture(t)
  const first = await f.lifecycle.submit(f.request(), { caller: f.caller })
  await f.drain()
  const again = await f.lifecycle.submit(f.request(), { caller: null })
  assert.equal(again.created, false)
  assert.equal(again.automation, first.automation)
  assert.deepEqual(f.calls.prepare, ['github:barrique#2995'])
  assert.deepEqual(f.calls.launch, ['github:barrique#2995'])
  assert.equal(Object.keys(f.state.teamTasks).length, 1)
  assert.equal(f.coordinator.teamTurn.remaining, 2)
  for (const changed of [
    { channelName: 'cc-other' },
    { team: { name: 'epic-2995', alias: 'issue-2995', task: 'Different work.' } },
    { team: { name: 'epic-2995', alias: 'other', task: 'Implement issue 2995 and open a PR.' } },
    { flags: ['--dsp'] },
  ]) {
    await assert.rejects(f.lifecycle.submit(f.request(changed), { caller: f.caller }),
      error => error instanceof AutomationRequestError && error.code === 'external_key_conflict')
  }
})

test('a taken channel name fails before launch and leaves the external key reusable', async t => {
  const f = automationFixture(t)
  f.setPrepare(async () => { throw Object.assign(new Error('#cc-taken already exists'), { definitive: true, code: 'channel_name_taken', status: 409 }) })
  await assert.rejects(f.lifecycle.submit(f.request({ channelName: 'cc-taken' }), { caller: f.caller }),
    error => error.code === 'channel_name_taken' && error.status === 409)
  assert.deepEqual(f.state.automations, {})
  assert.equal(f.team.pendingMembers, undefined)
  assert.deepEqual(Object.keys(f.team.members), ['C-COORD'])
  await f.drain()
  assert.deepEqual(f.calls.launch, [])
  f.setPrepare(async record => ({ channelId: 'C-FREE', channelName: record.channelName }))
  const retry = await f.lifecycle.submit(f.request({ channelName: 'cc-free' }), { caller: f.caller })
  assert.equal(retry.created, true)
  assert.equal(retry.automation.channelId, 'C-FREE')
})

test('an unconfirmed channel creation fails closed without launching and stays traceable', async t => {
  const f = automationFixture(t)
  f.setPrepare(async (record, { journalName }) => {
    journalName('cc-barrique-2995-vivian-holding-lines')
    assert.equal(record.channelSetup.name, 'cc-barrique-2995-vivian-holding-lines', 'the name is journaled before Slack is called')
    throw new Error('socket hang up')
  })
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'channel_creation_uncertain')
  const record = f.state.automations['github:barrique#2995']
  assert.equal(record.status, 'failed')
  assert.equal(record.failure.code, 'channel_creation_uncertain')
  assert.match(record.failure.message, /#cc-barrique-2995-vivian-holding-lines/)
  assert.equal(f.team.pendingMembers, undefined)
  await f.drain()
  assert.deepEqual(f.calls.launch, [])
  const replay = await f.lifecycle.submit(f.request(), { caller: f.caller })
  assert.equal(replay.created, false)
  assert.equal(f.calls.prepare.length, 1, 'an uncertain create is never retried')
  // Stop cannot archive a channel whose ID SAB never learned; it keeps the
  // name and the failure so the owner can find and archive it.
  const stopped = await f.lifecycle.stop(record.externalKey, { archive: true })
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.stop.unresolvedChannel, 'cc-barrique-2995-vivian-holding-lines')
  assert.equal(stopped.failure.code, 'channel_creation_uncertain')
})

test('a named or team request cannot silently reuse a plain automation key', async t => {
  const f = automationFixture(t)
  const plain = f.lifecycle.create({ ...f.request({ channelName: undefined, team: undefined }), initialPrompt: 'Plain.' })
  assert.equal(plain.created, true)
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'external_key_conflict')
  await assert.rejects(f.lifecycle.submit(f.request({ team: undefined, initialPrompt: 'Plain.' }), { caller: null }),
    error => error.code === 'external_key_conflict')
  // The identical plain request still replays as before.
  assert.equal((await f.lifecycle.submit({ ...f.request({ channelName: undefined, team: undefined }), initialPrompt: 'Plain.' })).created, false)
  assert.deepEqual(f.calls.prepare, [])
})

test('an automation channel is busy for team tasks until its setup completes', () => {
  const state = { automations: {
    a: { externalKey: 'a', channelId: 'C-A', status: 'configuring_collaborators', stop: {} },
    b: { externalKey: 'b', channelId: 'C-B', status: 'active', stop: {} },
    c: { externalKey: 'c', channelId: 'C-C', status: 'launching', stop: { requestedAt: 5 } },
    d: { externalKey: 'd', channelId: 'C-D', status: 'preparing_channel', stop: {} },
  } }
  assert.equal(automationSetupPending(state, 'C-A'), true)
  assert.equal(automationSetupPending(state, 'C-D'), true, 'before SessionStart there is no session to dispatch to')
  assert.equal(automationSetupPending(state, 'C-B'), false)
  assert.equal(automationSetupPending(state, 'C-C'), false, 'a stopping automation is not setup')
  assert.equal(automationSetupPending(state, 'C-OTHER'), false)
  assert.equal(automationSetupPending({}, 'C-A'), false)
})

test('a channel creation interrupted by a bridge restart fails closed and frees its slot', async t => {
  const f = automationFixture(t)
  let resume
  f.setPrepare(() => new Promise(resolve => { resume = resolve }))
  const pending = f.lifecycle.submit(f.request(), { caller: f.caller })
  await new Promise(resolve => setImmediate(resolve))
  const record = f.state.automations['github:barrique#2995']
  assert.equal(record.status, 'preparing_channel')
  assert.equal(f.team.pendingMembers['github:barrique#2995'].alias, 'issue-2995')
  // Boot recovery can run while this process is still serving that request:
  // the loopback API listens before recovery. It must not fail live work.
  f.lifecycle.recover()
  assert.equal(record.status, 'preparing_channel')
  resume({ channelId: 'C-LIVE', channelName: 'cc-barrique-2995-vivian-holding-lines' })
  assert.equal((await pending).automation.status, 'pending')

  // A journal left by an earlier process has no live preparation behind it.
  const g = automationFixture(t)
  g.setPrepare(() => new Promise(() => {}))
  g.lifecycle.submit(g.request(), { caller: g.caller }).catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  const stale = structuredClone(g.state.automations['github:barrique#2995'])
  const reservation = structuredClone(g.team.pendingMembers)
  const h = automationFixture(t)
  h.state.automations[stale.externalKey] = stale
  h.team.pendingMembers = reservation
  h.lifecycle.recover()
  assert.equal(stale.status, 'failed')
  assert.equal(stale.failure.code, 'channel_creation_interrupted')
  assert.equal(h.team.pendingMembers, undefined)
  await h.drain()
  assert.deepEqual(h.calls.launch, [])
  assert.equal(h.lifecycle.status(stale.externalKey).status, 'failed')
  // The burned key cannot launch again, whatever the retry contains.
  await assert.rejects(h.lifecycle.submit(h.request(), { caller: h.caller }), error => error.code === 'external_key_conflict')
  assert.deepEqual(h.calls.prepare, [])
})

test('stop waits for an in-flight channel preparation and then removes everything it created', async t => {
  const f = automationFixture(t)
  let resume
  f.setPrepare(() => new Promise(resolve => { resume = resolve }))
  const pending = f.lifecycle.submit(f.request(), { caller: f.caller })
  await new Promise(resolve => setImmediate(resolve))
  const stopping = f.lifecycle.stop('github:barrique#2995', { archive: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.state.automations['github:barrique#2995'].status, 'preparing_channel')
  resume({ channelId: 'C-PREPARED', channelName: 'cc-barrique-2995-vivian-holding-lines' })
  await pending
  // launch runs in the scheduled queue; drain it so stop can proceed.
  await f.drain()
  const stopped = await stopping
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.channelId, 'C-PREPARED')
  assert.equal(stopped.stop.channelArchived, true)
})

test('only the team coordinator, in an authorized turn, can create a worker', async t => {
  const f = automationFixture(t)
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: null }), error => error.code === 'team_caller_required')
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: { ...f.caller, tmux: 'sab-other' } }),
    error => error.code === 'unauthorized_session' && error.status === 403)
  await assert.rejects(f.lifecycle.submit(f.request({ team: { name: 'another-team', task: 'x' } }), { caller: f.caller }),
    error => error.code === 'team_not_coordinated')
  beginCollaboratorTeamTurn(f.coordinator, { messageTs: '2.0' })
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'owner_turn_required')
  f.coordinator.teamTurn = null
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'owner_turn_required')
  // A continuation turn for this exact team is authorized once auto mode is on.
  f.team.continuation = { mode: 'auto-until-blocked', pending: [], seenKeys: [], active: null }
  beginContinuationTeamTurn(f.coordinator, { teamId: 'team_other', eventId: 'event_1' })
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'owner_turn_required')
  beginContinuationTeamTurn(f.coordinator, { teamId: f.team.id, eventId: 'event_2' }, { budget: 1 })
  assert.equal((await f.lifecycle.submit(f.request(), { caller: f.caller })).created, true)
  await assert.rejects(f.lifecycle.submit(f.request({ externalKey: 'github:barrique#2996', channelName: 'cc-2996', team: { name: 'epic-2995', task: 'x' } }), { caller: f.caller }),
    error => error.code === 'dispatch_budget_exhausted')
  assert.deepEqual(f.calls.prepare, ['github:barrique#2995'])
})

test('a worker cannot create workers for its coordinator\'s team', async t => {
  const g = automationFixture(t, { authorizeCaller: async () => g.state.sessions.worker })
  addTeamWorker(g.state, g.team.id, { channel: 'C-WORKER', alias: 'worker' })
  const worker = { id: 'worker', channel: 'C-WORKER', provider: 'claude' }
  g.state.sessions.worker = worker
  g.state.channels[worker.channel] = worker.id
  beginOwnerTeamTurn(worker, { messageTs: '3.0' })
  await assert.rejects(g.lifecycle.submit(g.request(), { caller: g.caller }), error => error.code === 'team_not_coordinated')
  assert.deepEqual(g.calls.prepare, [])
})

test('a draining or full team refuses new workers before any channel is created', async t => {
  const f = automationFixture(t)
  f.team.dispatchMode = 'draining'
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'team_draining')
  f.team.dispatchMode = 'active'
  for (let index = 1; index < TEAM_MAX_MEMBERS; index++) {
    addTeamWorker(f.state, f.team.id, { channel: `C-W${index}`, alias: `worker-${index}` })
  }
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'team_full')
  assert.deepEqual(f.calls.prepare, [])
  assert.deepEqual(f.state.automations, {})
  assert.equal(f.coordinator.teamTurn.remaining, 3, 'a refused request consumes no dispatch')
})

test('a team closed while its channel is created fails the automation and keeps the channel for cleanup', async t => {
  const f = automationFixture(t)
  f.setPrepare(async record => { closeTeam(f.state, f.team.id); return { channelId: 'C-ORPHAN', channelName: record.channelName } })
  await assert.rejects(f.lifecycle.submit(f.request(), { caller: f.caller }), error => error.code === 'team_not_found')
  const record = f.state.automations['github:barrique#2995']
  assert.equal(record.status, 'failed')
  assert.equal(record.failure.code, 'team_join_failed')
  assert.equal(record.channelId, 'C-ORPHAN', 'stop --archive can still remove the channel')
  assert.equal(Object.values(f.state.teamTasks || {}).length, 0)
  await f.drain()
  assert.deepEqual(f.calls.launch, [])
})

test('a session that binds another channel cannot satisfy a prepared automation', async t => {
  const f = automationFixture(t)
  const { automation } = await f.lifecycle.submit(f.request(), { caller: f.caller })
  await f.drain()
  const session = { id: 'native-2', channel: 'C-ELSEWHERE', tmux: automation.tmux, cwd: f.cwd, provider: 'claude', pid: 12 }
  assert.equal(f.lifecycle.correlateSessionStart(session), false)
  assert.equal(automation.status, 'failed')
  assert.equal(automation.failure.code, 'session_channel_mismatch')
  assert.equal(bootstrapTaskHold(f.state, f.state.teamTasks[automation.team.taskId]), 'ended')
})

test('a channel-name-only automation needs no team and launches after its channel exists', async t => {
  const f = automationFixture(t)
  const { automation } = await f.lifecycle.submit(f.request({ team: undefined, initialPrompt: 'Raw prompt.' }), { caller: null })
  assert.equal(automation.channelId, 'C-CC-BARRIQUE-2995-VIVIAN-HOLDING-LINES')
  assert.equal(automation.team, undefined)
  assert.equal(f.coordinator.teamTurn.remaining, 3)
  await f.drain()
  const session = { id: 'native-3', channel: automation.channelId, tmux: automation.tmux, cwd: f.cwd, provider: 'claude', pid: 13 }
  f.state.sessions[session.id] = session
  f.state.channels[session.channel] = session.id
  f.lifecycle.correlateSessionStart(session)
  await f.drain()
  assert.deepEqual(f.calls.inject, [['native-3', 'Raw prompt.']])
  // Plain synchronous create() refuses requests that need a prepared channel.
  assert.throws(() => f.lifecycle.create(f.request({ externalKey: 'other', team: undefined })),
    error => error.code === 'channel_preparation_required')
})

test('stopping an automation removes its worker membership and closes a team it coordinates', () => {
  const { state, team } = teamState()
  addTeamWorker(state, team.id, { channel: 'C-EXEC', alias: 'exec-1' })
  state.teamTasks = {
    task_live: {
      id: 'task_live', teamId: team.id, status: 'running', sourceChannel: 'C-COORD', targetChannel: 'C-EXEC',
      replies: [], messages: [], controlRequests: [],
    },
    task_done: {
      id: 'task_done', teamId: team.id, status: 'completed', sourceChannel: 'C-COORD', targetChannel: 'C-EXEC',
      replies: [], messages: [], controlRequests: [],
    },
  }
  const departures = detachAutomationTeams(state, { externalKey: 'k', channelId: 'C-EXEC' })
  assert.deepEqual(departures.map(item => [item.kind, item.alias, item.cancelled]), [['removed', 'exec-1', ['task_live']]])
  assert.equal(team.members['C-EXEC'], undefined)
  assert.equal(state.teamTasks.task_live.status, 'cancelled')
  assert.equal(state.teamTasks.task_live.error, 'The worker automation was stopped.')
  assert.equal(state.teamTasks.task_done.status, 'completed', 'terminal history is kept')

  const closed = detachAutomationTeams(state, { externalKey: 'coordinator', channelId: 'C-COORD' })
  assert.equal(closed[0].kind, 'closed')
  assert.ok(team.closedAt)
  assert.deepEqual(detachAutomationTeams(state, { externalKey: 'none', channelId: null }), [])
})

// main (owner turn) creates an epic coordinator; the epic's standing first
// task carries delegated authority to create its own executors.
function hierarchyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-team-hierarchy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'worktree-')))
  const state = {
    sessions: { main: { id: 'main', channel: 'C-MAIN', provider: 'claude', pid: 10, tmux: 'sab-main' } },
    channels: { 'C-MAIN': 'main' },
    automations: {},
  }
  const main = createTeam(state, { id: 'team_main', name: 'main', coordinatorChannel: 'C-MAIN', createdBy: 'U-OWNER', now: 1 })
  setContinuationMode(main, 'auto-until-blocked')
  setTeamAutoRelease(main, true)
  beginOwnerTeamTurn(state.sessions.main, { messageTs: '1.0' })
  let caller = state.sessions.main
  const queue = []
  const launched = []
  const lifecycle = createAutomationLifecycle({
    state,
    home: root,
    persist: () => {},
    schedule: fn => queue.push(fn),
    launch: async record => launched.push(record.externalKey),
    invite: async () => ({ name: 'x' }),
    inject: async () => {},
    terminate: async () => {},
    archive: async () => {},
    prepareChannel: async record => ({ channelId: `C-${record.channelName}`.toUpperCase(), channelName: record.channelName }),
    teamBootstrap: createAutomationTeamBootstrap({
      state,
      resolveCaller: async () => caller,
      requireDispatch: (session, current) => {
        const authority = { teamId: current.id, allowContinuation: current.continuation?.mode === 'auto-until-blocked', state }
        assertCoordinatorDispatch(session, authority)
        return authority
      },
    }),
  })
  const request = overrides => ({
    externalKey: 'github:barrique#epic-2990', cwd, provider: 'claude', flags: ['--dsp'], collaborators: [],
    initialPrompt: '', channelName: 'cc-barrique-epic-2990',
    team: { name: 'main', alias: 'epic-2990', task: 'Coordinate epic 2990.', createTeam: 'epic-2990' },
    ...overrides,
  })
  return { state, main, lifecycle, request, setCaller: session => { caller = session }, drain: async () => { while (queue.length) await queue.shift()() }, launched }
}

test('main creates an epic coordinator whose sub-team inherits policy and whose task is standing', async t => {
  const f = hierarchyFixture(t)
  const { automation } = await f.lifecycle.submit(f.request(), { caller: {} })
  const epicChannel = automation.channelId
  const epicTeam = coordinatedTeamForChannel(f.state, epicChannel)
  assert.equal(epicTeam.name, 'epic-2990')
  assert.equal(parentTeamForChannel(f.state, epicChannel).id, f.main.id)
  assert.equal(epicTeam.continuation.mode, 'auto-until-blocked', 'continuation mode is inherited')
  assert.equal(teamAutoRelease(epicTeam), true, 'auto-release is inherited')
  assert.equal(epicTeam.createdVia.kind, 'automation')
  assert.equal(epicTeam.createdVia.parentTeamId, f.main.id)
  assert.deepEqual(automation.team.createdTeam, { teamId: epicTeam.id, teamName: 'epic-2990' })
  const task = f.state.teamTasks[automation.team.taskId]
  assert.equal(task.reservation, 'standing')
  assert.equal(task.teamId, f.main.id)
  assert.deepEqual(f.lifecycle.status(automation.externalKey).team.coordinates, { teamId: epicTeam.id, teamName: 'epic-2990' })

  // The epic session starts and receives its standing task with delegated authority.
  const epic = { id: 'epic', channel: epicChannel, provider: 'claude', pid: 20, tmux: automation.tmux }
  f.state.sessions.epic = epic
  f.state.channels[epicChannel] = 'epic'
  claimTeamTaskForSession(f.state, task.id, epic, { targetProvider: 'claude' })
  beginDelegatedTeamTurn(epic, { teamId: epicTeam.id, sourceTaskId: task.id })
  f.setCaller(epic)
  const executor = await f.lifecycle.submit(f.request({
    externalKey: 'github:barrique#2995', channelName: 'cc-barrique-2995-vivian-holding-lines',
    team: { name: 'epic-2990', alias: 'issue-2995', task: 'Implement issue 2995.' },
  }), { caller: {} })
  const execTask = f.state.teamTasks[executor.automation.team.taskId]
  assert.equal(execTask.teamId, epicTeam.id)
  assert.equal(execTask.reservation, undefined, 'an executor task is exclusive')
  assert.equal(execTask.sourceChannel, epicChannel)

  // A depth-3 executor may not create a team; main's turn cannot target the
  // epic's team, and a delegated turn cannot create under main.
  const exec = { id: 'exec', channel: executor.automation.channelId, provider: 'claude', pid: 30 }
  f.state.sessions.exec = exec
  f.state.channels[exec.channel] = 'exec'
  await assert.rejects(f.lifecycle.submit(f.request({
    externalKey: 'k-epic-under-main', channelName: 'cc-x', team: { name: 'main', task: 'x', createTeam: 'x' },
  }), { caller: {} }), error => error.code === 'team_not_coordinated')
  await assert.rejects(f.lifecycle.submit(f.request({
    externalKey: 'k-too-deep', channelName: 'cc-too-deep', team: { name: 'epic-2990', task: 'x', createTeam: 'deeper' },
  }), { caller: {} }), error => error.code === 'team_depth_exceeded')
  // Once the standing task ends, the epic's delegated authority ends too.
  cancelQueuedTeamTask(f.state, task.id, { sourceChannel: 'C-MAIN', reason: 'Epic dropped.', requestId: 'cancel-1' })
  await assert.rejects(f.lifecycle.submit(f.request({
    externalKey: 'k-after', channelName: 'cc-after', team: { name: 'epic-2990', task: 'x' },
  }), { caller: {} }), error => error.code === 'owner_turn_required')
})

test('a sub-team name is reserved with its slot and taken names are refused', async t => {
  const f = hierarchyFixture(t)
  createTeam(f.state, { name: 'taken', coordinatorChannel: 'C-OTHER', createdBy: 'U-OWNER' })
  await assert.rejects(f.lifecycle.submit(f.request({ team: { name: 'main', task: 'x', createTeam: 'taken' } }), { caller: {} }),
    error => error.code === 'team_name_in_use')
  const pending = f.lifecycle.submit(f.request(), { caller: {} })
  // While the first channel is being created its sub-team name is reserved.
  await assert.rejects(f.lifecycle.submit(f.request({
    externalKey: 'k2', channelName: 'cc-k2', team: { name: 'main', task: 'x', createTeam: 'epic-2990' },
  }), { caller: {} }), error => error.code === 'team_name_in_use')
  const { automation } = await pending
  assert.equal(coordinatedTeamForChannel(f.state, automation.channelId).name, 'epic-2990')
})
