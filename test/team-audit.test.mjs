import test from 'node:test'
import assert from 'node:assert/strict'
import { SLACK_UPDATE_TEXT_MAX, createPayloadAuditUpdater, teamTaskPayloadText } from '../daemon/team-audit.mjs'
import {
  addTeamWorker, claimTeamTaskForSession, createTeam, createTeamTask, replaceQueuedTeamTask,
} from '../daemon/teams.mjs'

// Slack accepts long chat.postMessage text but rejects chat.update text above
// roughly 4,000 characters with msg_too_long.
function fakeSlack({ updateLimit = 4000, failUpdate = null } = {}) {
  const calls = []
  let next = 100
  return {
    calls,
    update: async (channel, ts, text) => {
      calls.push({ op: 'update', channel, ts, text })
      const forced = failUpdate?.({ channel, ts, text })
      if (forced) throw Object.assign(new Error(forced), { data: { error: forced } })
      if (text.length > updateLimit) throw Object.assign(new Error('msg_too_long'), { data: { error: 'msg_too_long' } })
      return { ok: true }
    },
    post: async (channel, payload) => {
      calls.push({ op: 'post', channel, text: payload.text, clientMsgId: payload.client_msg_id })
      return { ts: `${next++}.000100` }
    },
  }
}

function replacedTask(length) {
  const state = { sessions: {}, channels: {} }
  const team = createTeam(state, { id: 'team_t', name: 'lanes', coordinatorChannel: 'C-COORD', createdBy: 'U', now: 1 })
  addTeamWorker(state, team.id, { channel: 'C-WORKER', alias: 'executor-1', now: 2 })
  const { task } = createTeamTask(state, {
    teamId: team.id, sourceChannel: 'C-COORD', sourceSessionId: 'coord', sourceProvider: 'codex',
    target: 'executor-1', text: 'Original instruction.', requestId: 'create', id: 'task_replaced', now: 3,
  })
  task.sourcePayloadSlackTs = '1.000001'
  task.targetPayloadSlackTs = '2.000001'
  task.payloadAuditInstructionVersion = 1
  const revision = 'Revised scope: '.padEnd(length, 'x')
  replaceQueuedTeamTask(state, task.id, { sourceChannel: 'C-COORD', text: revision, requestId: 'replace', now: 4 })
  return { state, task, revision }
}

function updaterFor(slack, clock = { now: 0 }) {
  return createPayloadAuditUpdater({
    update: slack.update, post: slack.post,
    clientId: (task, side) => `${task.id}:${side}`,
    persist: () => {}, now: () => clock.now,
  })
}

test('an oversized replacement is audited by a new card instead of failing forever', async () => {
  const { state, task, revision } = replacedTask(4703)
  assert.ok(teamTaskPayloadText(task, 'source').length > SLACK_UPDATE_TEXT_MAX)
  const slack = fakeSlack()
  const updatePayloadAudit = updaterFor(slack)

  assert.equal(await updatePayloadAudit(task), true)
  assert.equal(task.payloadAuditInstructionVersion, 2)
  const posts = slack.calls.filter(call => call.op === 'post')
  assert.deepEqual(posts.map(call => call.channel), ['C-COORD', 'C-WORKER'])
  assert.ok(posts.every(call => call.text.includes(revision)), 'the full revision is visible in both channels')
  const edits = slack.calls.filter(call => call.op === 'update')
  assert.deepEqual(edits.map(call => call.ts), ['1.000001', '2.000001'], 'the original cards point to the revision')
  assert.ok(edits.every(call => call.text.length < 4000 && /revision 2/.test(call.text)))
  assert.deepEqual(Object.keys(task.payloadRevisionCards), ['source', 'target'])

  // The revised queued task may now be claimed: the dispatch gate is satisfied.
  const worker = { id: 'sid-worker', channel: 'C-WORKER' }
  claimTeamTaskForSession(state, task.id, worker, {
    targetProvider: 'codex', expectedInstructionVersion: 2, expectedAuditInstructionVersion: 2,
  })
  assert.equal(task.status, 'dispatching')

  // Re-running never posts the same revision twice.
  await updatePayloadAudit(task)
  assert.equal(slack.calls.filter(call => call.op === 'post').length, 2)
})

test('a short replacement is still edited in place', async () => {
  const { task, revision } = replacedTask(800)
  const slack = fakeSlack()
  assert.equal(await updaterFor(slack)(task), true)
  assert.deepEqual(slack.calls.map(call => call.op), ['update', 'update'])
  assert.ok(slack.calls.every(call => call.text.includes(revision)))
  assert.equal(task.payloadRevisionCards, undefined)
})

test('a Slack msg_too_long below the local threshold falls back to a revision card', async () => {
  const { task } = replacedTask(1200)
  const slack = fakeSlack({ updateLimit: 1000 })
  assert.equal(await updaterFor(slack)(task), true)
  assert.equal(slack.calls.filter(call => call.op === 'post').length, 2)
  assert.equal(task.payloadAuditInstructionVersion, 2)
})

test('a failed pointer edit is retried without posting the revision again', async () => {
  const { task } = replacedTask(4703)
  let flaky = true
  const slack = fakeSlack({ failUpdate: ({ ts }) => flaky && ts === '2.000001' ? 'ratelimited' : null })
  const clock = { now: 0 }
  const updatePayloadAudit = updaterFor(slack, clock)
  assert.equal(await updatePayloadAudit(task), false)
  assert.equal(task.payloadAuditInstructionVersion, 1, 'a partial update never satisfies the dispatch gate')
  flaky = false
  clock.now += 30_000
  assert.equal(await updatePayloadAudit(task), true)
  assert.equal(slack.calls.filter(call => call.op === 'post').length, 2, 'each side posted its revision once')
})

test('a persistent Slack failure backs off instead of retrying every sweep', async () => {
  const { task } = replacedTask(800)
  const slack = fakeSlack({ failUpdate: () => 'channel_not_found' })
  const clock = { now: 0 }
  const updatePayloadAudit = updaterFor(slack, clock)
  // The reconciler sweeps every 3 s; before the fix each sweep called Slack.
  for (let elapsed = 0; elapsed <= 10 * 60_000; elapsed += 3000) {
    clock.now = elapsed
    assert.equal(await updatePayloadAudit(task), false)
  }
  const attempts = slack.calls.length / 2
  assert.ok(attempts <= 6, `10 minutes of sweeps made ${attempts} attempts, not 200`)
  assert.equal(task.payloadAuditInstructionVersion, 1)

  // A newer revision is tried at once, and success clears the backoff.
  replaceQueuedTeamTask({ teamTasks: { [task.id]: task }, teams: {} }, task.id, {
    sourceChannel: 'C-COORD', text: 'A different revision.', requestId: 'replace-2', now: 5,
  })
  const working = fakeSlack()
  const recovered = createPayloadAuditUpdater({
    update: working.update, post: working.post, clientId: () => 'id', persist: () => {}, now: () => clock.now,
  })
  assert.equal(await recovered(task), true)
  assert.equal(task.payloadAuditInstructionVersion, 3)
})

test('a missing card fails and the recorded version is the one that was rendered', async () => {
  const missing = replacedTask(800).task
  missing.targetPayloadSlackTs = null
  assert.equal(await updaterFor(fakeSlack())(missing), false)
  assert.equal(missing.payloadAuditInstructionVersion, 1)

  const { task } = replacedTask(800)
  const slack = fakeSlack({
    // A concurrent replacement lands while the first card is being edited.
    failUpdate: ({ ts }) => { if (ts === '1.000001') task.instructionVersion = 3; return null },
  })
  assert.equal(await updaterFor(slack)(task), true)
  assert.equal(task.payloadAuditInstructionVersion, 2, 'the newer revision stays unaudited')
})
