import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { handleCodexFinalHttp } from '../daemon/codex-final-http.mjs'

const payload = {
  threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', text: 'Done safely.', observedAt: 123456,
}

function fixture(overrides = {}) {
  const calls = []
  const session = {
    id: 'thread-1', provider: 'codex', pid: 42, tmux: 'sab-one', channel: 'C1',
  }
  const state = { sessions: { 'thread-1': session }, channels: { C1: 'thread-1' } }
  return {
    calls,
    state,
    execFile: async () => {},
    internalTurns: new Map(),
    resolveAgentPid: async value => Number(value),
    codexAppServerProcessPid: async value => value,
    validTmuxClaim: async () => true,
    transitionForTarget: () => null,
    completePrivateTurn: async (...args) => { calls.push(['private', ...args]); return true },
    finalizeCodexTurn: async (...args) => { calls.push(['final', ...args]); return true },
    ...overrides,
  }
}

async function startServer(t, context) {
  const server = http.createServer(async (req, res) => {
    const handled = await handleCodexFinalHttp(req, res, new URL(req.url, 'http://localhost'), context)
    if (!handled) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

function send(base, value = payload, options = {}) {
  return fetch(`${base}/codex/final?ppid=42&tmux=sab-one`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ccs-provider': 'codex', ...options.headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  })
}

test('Codex final HTTP completes only the exact public session turn', async t => {
  const context = fixture()
  const base = await startServer(t, context)
  const response = await send(base)
  assert.equal(response.status, 202)
  assert.equal(context.calls.length, 1)
  assert.equal(context.calls[0][0], 'final')
  assert.equal(context.calls[0][1], context.state.sessions['thread-1'])
  assert.deepEqual(context.calls[0][2], {
    turn_id: 'turn-1', last_assistant_message: 'Done safely.', observed_at: 123456,
  })
})

test('Codex final HTTP rejects an invalid proxy observation timestamp', async t => {
  const context = fixture()
  const base = await startServer(t, context)
  assert.equal((await send(base, { ...payload, observedAt: -1 })).status, 400)
  assert.deepEqual(context.calls, [])
})

test('Codex final HTTP routes private completions without posting a public final', async t => {
  const context = fixture()
  context.internalTurns.set('thread-1', {})
  const base = await startServer(t, context)
  const response = await send(base)
  assert.equal(response.status, 202)
  assert.equal(context.calls.length, 1)
  assert.equal(context.calls[0][0], 'private')
})

test('Codex final HTTP deduplicates Stop and App Server completion', async t => {
  const context = fixture()
  context.state.sessions['thread-1'].lastMirroredTurn = 'turn-1'
  const base = await startServer(t, context)
  const response = await send(base)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'duplicate')
  assert.deepEqual(context.calls, [])
})

test('Codex final HTTP fails closed on malformed or mismatched authority', async t => {
  const context = fixture()
  const base = await startServer(t, context)

  assert.equal((await fetch(`${base}/codex/final`)).status, 405)
  assert.equal((await send(base, '{')).status, 400)
  assert.equal((await send(base, payload, { headers: { 'x-ccs-provider': 'claude' } })).status, 403)

  context.state.channels.C1 = 'another-thread'
  assert.equal((await send(base)).status, 409)
  context.state.channels.C1 = 'thread-1'
  context.validTmuxClaim = async () => false
  assert.equal((await send(base)).status, 403)
  context.validTmuxClaim = async () => true
  context.state.sessions['thread-1'].id = 'different-thread'
  assert.equal((await send(base)).status, 403)
  assert.deepEqual(context.calls, [])
})

test('Codex final HTTP bounds request bodies before any lifecycle mutation', async t => {
  const context = fixture()
  const base = await startServer(t, context)
  const response = await send(base, JSON.stringify({ ...payload, text: 'x'.repeat((2 << 20) + 1) }))
  assert.equal(response.status, 413)
  assert.deepEqual(context.calls, [])
})
