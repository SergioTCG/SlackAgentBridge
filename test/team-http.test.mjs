import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { handleTeamHttp } from '../daemon/team-http.mjs'
import { TeamError } from '../daemon/teams.mjs'

async function withServer(service, run) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!(await handleTeamHttp(req, res, url, service))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

const caller = '?ppid=123&tmux=sab-test'
const headers = { 'x-ccs-provider': 'codex' }

async function rawGet(base, pathname, requestHeaders) {
  const target = new URL(base)
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname, port: target.port, path: pathname, method: 'GET', headers: requestHeaders,
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('error', reject)
    request.end()
  })
}

test('team HTTP exposes context, peers, inbox, and exact task status', async () => {
  const seen = []
  const inboxSeen = []
  const service = {
    context: async meta => { seen.push(meta); return { role: 'coordinator' } },
    peers: async () => [{ alias: 'parallel-1' }],
    inbox: async (_meta, options) => {
      inboxSeen.push(options)
      return { tasks: [{ id: `limit-${options.limit}-after-${options.after}` }], nextCursor: 'next-page' }
    },
    task: async (_meta, id) => ({ id, status: 'running' }),
    mutation: async (_meta, requestId, taskId) => ({ requestId, taskId, status: 'accepted' }),
    send: async () => assert.fail('unexpected send'),
    reply: async () => assert.fail('unexpected reply'),
  }
  await withServer(service, async base => {
    let response = await fetch(`${base}/team/context${caller}`, { headers })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, context: { role: 'coordinator' } })
    response = await fetch(`${base}/team/peers${caller}`, { headers })
    assert.deepEqual((await response.json()).peers, [{ alias: 'parallel-1' }])
    response = await fetch(`${base}/team/inbox${caller}&limit=5&active=true&target=parallel-1&status=queued,running&since=2026-01-01T00%3A00%3A00.000Z&cursor=page-one`, { headers })
    assert.deepEqual(await response.json(), { ok: true, tasks: [{ id: 'limit-5-after-null' }], nextCursor: 'next-page' })
    assert.deepEqual(inboxSeen[0], {
      limit: '5', after: null, cursor: 'page-one', active: true,
      target: 'parallel-1', status: ['queued', 'running'], since: '2026-01-01T00:00:00.000Z',
    })
    response = await fetch(`${base}/team/inbox${caller}&limit=5&after=task_old`, { headers })
    assert.deepEqual((await response.json()).tasks, [{ id: 'limit-5-after-task_old' }])
    response = await fetch(`${base}/team/tasks/task_123${caller}`, { headers })
    assert.deepEqual((await response.json()).task, { id: 'task_123', status: 'running' })
    response = await fetch(`${base}/team/mutations/request-1${caller}&taskId=task_123`, { headers })
    assert.deepEqual((await response.json()).mutation,
      { requestId: 'request-1', taskId: 'task_123', status: 'accepted' })
  })
  assert.deepEqual(seen[0], { ppid: '123', tmux: 'sab-test', provider: 'codex' })
  assert.equal(inboxSeen[1].after, 'task_old')
})

test('team HTTP rejects ambiguous legacy and filtered inbox cursors', async () => {
  const service = { inbox: async () => assert.fail('ambiguous inbox request reached service') }
  await withServer(service, async base => {
    const response = await fetch(`${base}/team/inbox${caller}&after=task_old&active=true`, { headers })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).code, 'invalid_filter_combo')
  })
})

test('accepted mutation receipt is returned without a second caller-identity lookup', async () => {
  let mutationLookups = 0
  const receipt = {
    requestId: 'atomic-1', kind: 'send', status: 'accepted', resourceId: 'task_atomic',
    taskId: 'task_atomic', taskStatus: 'queued', lifecycleVersion: 1, acceptedAt: '2026-01-01T00:00:00.000Z',
  }
  const service = {
    send: async () => ({ task: { id: 'task_atomic', status: 'queued' }, created: true, mutation: receipt }),
    mutation: async () => { mutationLookups++; throw new Error('second lookup must not happen') },
  }
  await withServer(service, async base => {
    const response = await fetch(`${base}/team/send${caller}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'worker', text: 'Do work.', requestId: 'atomic-1' }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual((await response.json()).mutation, receipt)
  })
  assert.equal(mutationLookups, 0)
})

test('team HTTP accepts JSON-safe send, reply, control, and mode requests', async () => {
  const calls = []
  const service = {
    context: async () => null, peers: async () => [], inbox: async () => [], task: async () => null,
    mutation: async (_meta, requestId, taskId) => ({ requestId, taskId, status: 'accepted' }),
    send: async (meta, body) => { calls.push(['send', meta, body]); return { task: { id: 'task_one' }, created: true } },
    reply: async (meta, body) => { calls.push(['reply', meta, body]); return { reply: { id: 'reply_one' } } },
    cancel: async (meta, body) => { calls.push(['cancel', meta, body]); return { task: { id: 'task_one', status: 'cancelled' } } },
    replace: async (meta, body) => { calls.push(['replace', meta, body]); return { task: { id: 'task_one', instruction: body.text } } },
    message: async (meta, body) => { calls.push(['message', meta, body]); return { message: { id: 'message_one' } } },
    checkpoint: async (meta, body) => { calls.push(['checkpoint', meta, body]); return { task: { id: body.taskId }, reply: { id: 'reply_checkpoint' } } },
    complete: async (meta, body) => { calls.push(['complete', meta, body]); return { task: { id: body.taskId, status: 'running' } } },
    release: async (meta, body) => { calls.push(['release', meta, body]); return { task: { id: body.taskId, status: 'completed' } } },
    continue: async (meta, body) => { calls.push(['continue', meta, body]); return { task: { id: 'task_continued', parentTaskId: body.taskId } } },
    mode: async (meta, body) => { calls.push(['mode', meta, body]); return { mode: body.mode } },
  }
  await withServer(service, async base => {
    const options = payload => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    let response = await fetch(`${base}/team/send${caller}`, options({ to: 'parallel-1', text: 'Do work.', requestId: 'r1' }))
    assert.equal(response.status, 202)
    assert.equal((await response.json()).task.id, 'task_one')
    response = await fetch(`${base}/team/reply${caller}`, options({ taskId: 'task_one', text: 'Progress.', requestId: 'r2' }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).reply.id, 'reply_one')
    response = await fetch(`${base}/team/checkpoint${caller}`, options({ taskId: 'task_one', text: 'CI pending.', pendingGates: ['ci'], requestId: 'r2c' }))
    assert.equal((await response.json()).reply.id, 'reply_checkpoint')
    response = await fetch(`${base}/team/complete${caller}`, options({ taskId: 'task_one', text: 'Ready.', requestId: 'r2d' }))
    assert.equal((await response.json()).mutation.requestId, 'r2d')
    response = await fetch(`${base}/team/release${caller}`, options({ taskId: 'task_one', requestId: 'r2e' }))
    assert.equal((await response.json()).task.status, 'completed')
    response = await fetch(`${base}/team/continue${caller}`, options({ taskId: 'task_one', text: 'Follow up.', requestId: 'r2f' }))
    assert.equal((await response.json()).task.parentTaskId, 'task_one')
    response = await fetch(`${base}/team/cancel${caller}`, options({ taskId: 'task_one', reason: 'Done elsewhere.', requestId: 'r3' }))
    assert.equal((await response.json()).task.status, 'cancelled')
    response = await fetch(`${base}/team/replace${caller}`, options({ taskId: 'task_one', text: 'New work.', requestId: 'r4' }))
    assert.equal((await response.json()).task.instruction, 'New work.')
    response = await fetch(`${base}/team/message${caller}`, options({ taskId: 'task_one', text: 'Proceed.', requestId: 'r5' }))
    assert.equal((await response.json()).message.id, 'message_one')
    response = await fetch(`${base}/team/mode${caller}`, options({ mode: 'draining' }))
    assert.equal((await response.json()).mode, 'draining')
  })
  assert.equal(calls[0][0], 'send')
  assert.equal(calls[1][0], 'reply')
  assert.deepEqual(calls.slice(2).map(call => call[0]),
    ['checkpoint', 'complete', 'release', 'continue', 'cancel', 'replace', 'message', 'mode'])
})

test('team HTTP rejects browser origins, non-loopback Host, wrong media type, and oversized bodies', async () => {
  const service = { context: async () => null, peers: async () => [], inbox: async () => [], task: async () => null, send: async () => ({}), reply: async () => ({}) }
  await withServer(service, async base => {
    let response = await fetch(`${base}/team/context${caller}`, { headers: { ...headers, origin: 'https://evil.example' } })
    assert.equal(response.status, 403)
    assert.equal((await response.json()).code, 'browser_request_rejected')
    const invalidHost = await rawGet(base, `/team/context${caller}`, { ...headers, host: 'evil.example' })
    assert.equal(invalidHost.status, 403)
    response = await fetch(`${base}/team/send${caller}`, { method: 'POST', headers, body: '{}' })
    assert.equal(response.status, 415)
    response = await fetch(`${base}/team/send${caller}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(300_000) }),
    })
    assert.equal(response.status, 413)
  })
})

test('team HTTP returns bounded expected errors without exposing internal failures', async () => {
  const service = {
    context: async () => { throw new TeamError('not_member', 'This session is not in a team.', 404) },
    peers: async () => { throw new Error('secret internal path') },
    inbox: async () => [], task: async () => null, send: async () => ({}), reply: async () => ({}),
  }
  await withServer(service, async base => {
    let response = await fetch(`${base}/team/context${caller}`, { headers })
    assert.deepEqual(await response.json(), { ok: false, code: 'not_member', error: 'This session is not in a team.' })
    response = await fetch(`${base}/team/peers${caller}`, { headers })
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), { ok: false, code: 'team_request_failed', error: 'team request failed' })
  })
})
