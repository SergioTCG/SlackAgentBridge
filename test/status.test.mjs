import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createStatusMessages, recoverCodexTurnStartedAt } from '../daemon/status.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')

test('automation prompt echoes suppress mirroring without bypassing turn tracking', () => {
  const block = /if \(ev === 'UserPromptSubmit'\) \{([\s\S]*?)\n  \}\n  if \(ev === 'PreToolUse'\)/.exec(daemon)?.[1] || ''
  assert.match(block, /const automationEcho = automationLifecycle\.consumeInitialPromptEcho/)
  assert.doesNotMatch(block, /consumeInitialPromptEcho\([^\n]+\)\) return/)
  assert.match(block, /if \(provider === 'claude'\) startPoller\(session\)/)
  assert.match(block, /else if \(provider === 'codex'\) beginCodexTurn\(session\)/)
})

function fakeSlack() {
  let next = 10
  const calls = []
  return {
    calls,
    web: { chat: {
      async postMessage(args) { const ts = `${next++}.000001`; calls.push(['post', args, ts]); return { ts } },
      async update(args) { calls.push(['update', args]) },
      async delete(args) { calls.push(['delete', args]) },
    } },
  }
}

test('working status edits in place until newer activity requests a bump', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working 1s')
  await status.set(session, 'working 2s')
  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'update'])
  assert.equal(slack.calls[1][1].ts, '10.000001')

  assert.equal(await status.bump(session, { afterTs: '11.000000' }), true)
  assert.deepEqual(slack.calls.slice(2).map(call => call[0]), ['post', 'delete'])
  assert.equal(slack.calls[2][1].text, 'working 2s')
  assert.equal(slack.calls[3][1].ts, '10.000001')

  await status.set(session, 'working 3s')
  assert.equal(slack.calls.at(-1)[0], 'update')
  assert.equal(slack.calls.at(-1)[1].ts, '11.000001')
})

test('activity older than the current status does not repost it', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working')
  assert.equal(await status.bump(session, { afterTs: '9.999999' }), false)
  assert.deepEqual(slack.calls.map(call => call[0]), ['post'])
})

test('concurrent updates and bumps are serialized onto the replacement message', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working 1s')
  await Promise.all([
    status.bump(session, { afterTs: '11.000000' }),
    status.set(session, 'working 2s'),
  ])

  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'post', 'delete', 'update'])
  assert.equal(slack.calls.at(-1)[1].ts, '11.000001')
  assert.equal(slack.calls.at(-1)[1].text, 'working 2s')
})

test('failed replacement deletion rolls back the new message and keeps the old status', async () => {
  const slack = fakeSlack()
  let failOldDelete = true
  slack.web.chat.delete = async args => {
    slack.calls.push(['delete', args])
    if (failOldDelete && args.ts === '10.000001') {
      failOldDelete = false
      const error = new Error('ratelimited')
      error.data = { error: 'ratelimited' }
      throw error
    }
  }
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working 1s')
  assert.equal(await status.bump(session, { afterTs: '11.000000' }), false)
  await status.set(session, 'working 2s')

  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'post', 'delete', 'delete', 'update'])
  assert.equal(slack.calls.at(-1)[1].ts, '10.000001')
})

test('clear removes the replacement status after a bump', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'working')
  await status.bump(session, { afterTs: '11.000000' })
  await status.clear(session)

  assert.deepEqual(slack.calls.filter(call => call[0] === 'delete').map(call => call[1].ts), [
    '10.000001', '11.000001',
  ])
})

test('clear followed immediately by a new turn preserves the new status text', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }

  await status.set(session, 'old turn')
  await Promise.all([
    status.clear(session),
    status.set(session, 'new turn'),
  ])

  assert.deepEqual(slack.calls.map(call => call[0]), ['post', 'delete', 'post'])
  assert.equal(slack.calls.at(-1)[1].text, 'new turn')
})

test('status edits coalesce while a workspace-wide Slack budget is occupied', async () => {
  const slack = fakeSlack()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  let updates = 0
  const originalUpdate = slack.web.chat.update
  slack.web.chat.update = async args => {
    updates++
    if (updates === 1) { startedResolve(); await gate }
    return originalUpdate(args)
  }
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }
  await status.set(session, 'working 1s')
  const pending = status.set(session, 'working 2s')
  await started
  const newer = Promise.all([status.set(session, 'working 3s'), status.set(session, 'working 4s')])
  release()
  await Promise.all([pending, newer])
  assert.equal(updates, 2)
  assert.equal(slack.calls.at(-1)[1].text, 'working 4s')
})

test('clear cancels a queued edit and preempts unrelated cosmetic status traffic', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const first = { id: 'S1', channel: 'C1' }
  const second = { id: 'S2', channel: 'C2' }
  const ending = { id: 'S3', channel: 'C3' }

  await status.set(first, 'one')
  await status.set(second, 'two')
  await status.set(ending, 'ending')

  let release
  const gate = new Promise(resolve => { release = resolve })
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const originalUpdate = slack.web.chat.update
  slack.web.chat.update = async args => {
    if (args.channel === 'C1') { startedResolve(); await gate }
    return originalUpdate(args)
  }

  const occupied = status.set(first, 'one newer')
  await started
  const unrelated = status.set(second, 'two newer')
  const stale = status.set(ending, 'must never be sent')
  const cleared = status.clear(ending)
  release()
  await Promise.all([occupied, unrelated, stale, cleared])

  const afterOccupied = slack.calls.slice(4)
  assert.equal(afterOccupied[0][0], 'delete')
  assert.equal(afterOccupied[0][1].channel, 'C3')
  assert.equal(afterOccupied.some(call => call[0] === 'update' && call[1].text === 'must never be sent'), false)
  assert.equal(afterOccupied.some(call => call[0] === 'update' && call[1].text === 'two newer'), true)
})

test('clear cannot deadlock an in-flight status bump', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C1' }
  await status.set(session, 'working')

  let release
  const gate = new Promise(resolve => { release = resolve })
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  const originalPost = slack.web.chat.postMessage
  slack.web.chat.postMessage = async args => {
    if (args.text === 'working') { startedResolve(); await gate }
    return originalPost(args)
  }

  const bumped = status.bump(session)
  await started
  const cleared = status.clear(session)
  release()

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('status clear deadlocked')), 1000))
  await Promise.race([Promise.all([bumped, cleared]), timeout])
  assert.equal(status.snapshot().normal, 0)
  assert.equal(status.snapshot().priority, 0)
  assert.equal(slack.calls.filter(call => call[0] === 'delete').length, 2)
})

test('clear invalidates a bump waiting inside the channel delivery queue', async () => {
  const slack = fakeSlack()
  let release
  let queuedResolve
  const gate = new Promise(resolve => { release = resolve })
  const queued = new Promise(resolve => { queuedResolve = resolve })
  let statusPosts = 0
  const status = createStatusMessages(slack.web, {
    postMessage: async (channel, text, { valid } = {}) => {
      statusPosts++
      if (statusPosts === 2) {
        queuedResolve()
        await gate
        if (valid && !valid()) return null
      }
      return slack.web.chat.postMessage({ channel, text })
    },
  })
  const session = { id: 'S1', channel: 'C1' }
  await status.set(session, 'working')

  const bumped = status.bump(session, { afterTs: '11.000000' })
  await queued
  const cleared = status.clear(session)
  release()
  await Promise.all([bumped, cleared])

  assert.equal(slack.calls.filter(call => call[0] === 'post').length, 1)
  assert.deepEqual(slack.calls.filter(call => call[0] === 'delete').map(call => call[1].ts), ['10.000001'])
})

test('clear promotes bump cleanup ahead of unrelated cosmetic queue pressure', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  const ending = { id: 'S1', channel: 'C1' }
  const occupied = { id: 'S2', channel: 'C2' }
  const unrelated = { id: 'S3', channel: 'C3' }
  await status.set(ending, 'ending')
  await status.set(occupied, 'occupied')
  await status.set(unrelated, 'unrelated')

  let releasePost
  let postStartedResolve
  const postGate = new Promise(resolve => { releasePost = resolve })
  const postStarted = new Promise(resolve => { postStartedResolve = resolve })
  let replacement = true
  const originalPost = slack.web.chat.postMessage
  slack.web.chat.postMessage = async args => {
    if (args.channel === 'C1' && replacement) {
      replacement = false
      postStartedResolve()
      await postGate
    }
    return originalPost(args)
  }

  let releaseOccupied
  let occupiedStartedResolve
  const occupiedGate = new Promise(resolve => { releaseOccupied = resolve })
  const occupiedStarted = new Promise(resolve => { occupiedStartedResolve = resolve })
  const originalUpdate = slack.web.chat.update
  slack.web.chat.update = async args => {
    if (args.channel === 'C2' && args.text === 'occupied newer') {
      occupiedStartedResolve()
      await occupiedGate
    }
    return originalUpdate(args)
  }

  const bumped = status.bump(ending, { afterTs: '99.000000' })
  await postStarted
  const blocker = status.set(occupied, 'occupied newer')
  const queuedCosmetic = status.set(unrelated, 'unrelated newer')
  releasePost()
  await occupiedStarted
  const cleared = status.clear(ending)
  releaseOccupied()
  await Promise.all([bumped, blocker, queuedCosmetic, cleared])

  const afterBlocker = slack.calls.slice(slack.calls.findIndex(call =>
    call[0] === 'update' && call[1].text === 'occupied newer') + 1)
  const cleanupIndex = afterBlocker.findIndex(call => call[0] === 'delete' && call[1].channel === 'C1')
  const cosmeticIndex = afterBlocker.findIndex(call => call[0] === 'update' && call[1].text === 'unrelated newer')
  assert.ok(cleanupIndex >= 0)
  assert.ok(cosmeticIndex >= 0)
  assert.ok(cleanupIndex < cosmeticIndex, 'completed-turn cleanup must preempt unrelated cosmetic traffic')
})

test('status scheduler exposes bounded operational queue depth', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web)
  assert.deepEqual(status.snapshot(), { active: false, normal: 0, priority: 0, sessions: 0 })
  await status.set({ id: 'S1', channel: 'C1' }, 'working')
  assert.deepEqual(status.snapshot(), { active: false, normal: 0, priority: 0, sessions: 1 })
})

test('clearing a session without a posted status does not consume the workspace API interval', async () => {
  const slack = fakeSlack()
  const status = createStatusMessages(slack.web, { minIntervalMs: 100 })

  await status.clear({ id: 'EMPTY', channel: 'C0' })
  const posted = status.set({ id: 'LIVE', channel: 'C1' }, 'working')
  const outcome = await Promise.race([
    posted.then(() => 'posted'),
    new Promise(resolve => setTimeout(() => resolve('delayed'), 20)),
  ])

  assert.equal(outcome, 'posted')
  await posted
  assert.deepEqual(slack.calls.map(call => call[0]), ['post'])
})

test('deferred clear deletes from the channel captured before provider handoff', async () => {
  const slack = fakeSlack()
  let release
  let startedResolve
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { startedResolve = resolve })
  const originalUpdate = slack.web.chat.update
  slack.web.chat.update = async args => {
    startedResolve()
    await gate
    return originalUpdate(args)
  }
  const status = createStatusMessages(slack.web)
  const session = { id: 'S1', channel: 'C-source' }
  await status.set(session, 'working')

  const update = status.set(session, 'working still')
  await started
  const clearing = status.clear(session)
  session.channel = null
  release()
  await Promise.all([update, clearing])

  const deletion = slack.calls.find(call => call[0] === 'delete')
  assert.equal(deletion?.[1]?.channel, 'C-source')
  assert.equal(deletion?.[1]?.ts, '10.000001')
})

test('bridge health exposes status-queue pressure without provider or Slack secrets', () => {
  const block = /if \(name === 'health'\) \{([\s\S]*?)\n  \}\n  if \(name === 'kill'\)/.exec(daemon)?.[1] || ''
  assert.match(block, /liveStatuses\.snapshot\(\)/)
  assert.match(block, /Status queue/)
  assert.doesNotMatch(block, /SLACK_(?:BOT|APP)_TOKEN/)
})

test('daemon re-anchors status after posts, topic changes, and channel messages', () => {
  assert.match(daemon, /async function postSlackMessage[\s\S]*bumpStatusForChannel\(channel, result\?\.ts\)/)
  assert.match(daemon, /const changed = await syncTopic[\s\S]*if \(changed\) await bumpStatus/)
  assert.match(daemon, /event\.subtype === 'channel_topic'[\s\S]*bumpStatusForChannel\(event\.channel, event\.ts \|\| null\)/)
  assert.match(daemon, /if \(!event\.thread_ts\) await bumpStatusForChannel\(event\.channel, event\.ts \|\| null\)/)
  assert.match(daemon, /liveStatuses\.adopt\(s\.id, ts\)/)
})

test('provider output is delivered without waiting behind cosmetic status mutations', () => {
  assert.match(daemon, /async function postMd\(channel, md, \{ waitForBump = true, reanchor = true \} = \{\}\)/)
  assert.match(daemon, /function postProviderOutput\(channel, md, \{ keepStatus = false \} = \{\}\)/)
  assert.match(daemon, /return postMd\(channel, md, \{ waitForBump: false, reanchor: keepStatus \}\)/)
  assert.match(daemon, /finalizeCodexTurn[\s\S]*postProviderOutput\(session\.channel, text\)/)
  const commentary = /if \(url\.pathname === '\/codex\/commentary'[\s\S]*?\n    return\n  \}/.exec(daemon)?.[0] || ''
  assert.match(commentary, /postProviderOutput\(session\.channel, commentary\.text, \{ keepStatus: true \}\)/)
})

test('Codex restart recovery preserves or reconstructs the active turn duration', () => {
  const now = Date.parse('2026-08-24T16:30:00Z')
  const promptAt = Date.parse('2026-08-24T07:43:27.316Z')
  const frozenAt = Date.parse('2026-08-24T16:20:00Z')

  assert.equal(recoverCodexTurnStartedAt({ persistedStartedAt: 1234, now }), 1234)
  assert.equal(recoverCodexTurnStartedAt({
    statusMessage: {
      ts: String((frozenAt - 1_000) / 1000),
      edited: { ts: String(frozenAt / 1000) },
      text: ':gear: Codex is working… (8h 36m 32s · 2.1M tokens this turn)',
    },
    latestPromptTs: String(promptAt / 1000),
    now,
  }), frozenAt - ((8 * 3600 + 36 * 60 + 32) * 1000))
  assert.equal(recoverCodexTurnStartedAt({
    statusMessage: {
      ts: String(Date.parse('2026-08-20T07:15:35Z') / 1000),
      edited: { ts: String(Date.parse('2026-08-20T07:50:00Z') / 1000) },
      text: ':gear: Codex is working… (34m 25s)',
    },
    latestPromptTs: String(promptAt / 1000),
    now,
  }), promptAt)
  assert.equal(recoverCodexTurnStartedAt({ latestPromptTs: String(promptAt / 1000), now }), promptAt)
  assert.equal(recoverCodexTurnStartedAt({ now }), now)
})

test('Codex stop waits for confirmation and clears only the interrupted turn', () => {
  assert.match(daemon, /waitForCodexInterrupt\(session/)
  assert.match(daemon, /interruptedTurnStartedAt = session\.codexTurnStartedAt/)
  assert.match(daemon, /outcome === 'idle'[\s\S]*stopPoller\(session\)[\s\S]*clearStatus\(session\)/)
  assert.match(daemon, /Codex did not return to idle[\s\S]*working status remains active/)
  assert.match(daemon, /codexStatusRecoveryDecision\(s,[\s\S]*cleared stale Codex turn status/)
  assert.match(daemon, /recoverCodexTurnStartedAt\([\s\S]*startCodexPoller\(s\)/)
})
