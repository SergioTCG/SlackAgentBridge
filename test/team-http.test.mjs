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
  const service = {
    context: async meta => { seen.push(meta); return { role: 'coordinator' } },
    peers: async () => [{ alias: 'parallel-1' }],
    inbox: async (_meta, options) => [{ id: `limit-${options.limit}-after-${options.after}` }],
    task: async (_meta, id) => ({ id, status: 'running' }),
    send: async () => assert.fail('unexpected send'),
    reply: async () => assert.fail('unexpected reply'),
  }
  await withServer(service, async base => {
    let response = await fetch(`${base}/team/context${caller}`, { headers })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, context: { role: 'coordinator' } })
    response = await fetch(`${base}/team/peers${caller}`, { headers })
    assert.deepEqual((await response.json()).peers, [{ alias: 'parallel-1' }])
    response = await fetch(`${base}/team/inbox${caller}&limit=5&after=task_old`, { headers })
    assert.deepEqual((await response.json()).tasks, [{ id: 'limit-5-after-task_old' }])
    response = await fetch(`${base}/team/tasks/task_123${caller}`, { headers })
    assert.deepEqual((await response.json()).task, { id: 'task_123', status: 'running' })
  })
  assert.deepEqual(seen[0], { ppid: '123', tmux: 'sab-test', provider: 'codex' })
})

test('team HTTP accepts JSON-safe send and reply requests', async () => {
  const calls = []
  const service = {
    context: async () => null, peers: async () => [], inbox: async () => [], task: async () => null,
    send: async (meta, body) => { calls.push(['send', meta, body]); return { task: { id: 'task_one' }, created: true } },
    reply: async (meta, body) => { calls.push(['reply', meta, body]); return { reply: { id: 'reply_one' } } },
  }
  await withServer(service, async base => {
    const options = payload => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    let response = await fetch(`${base}/team/send${caller}`, options({ to: 'parallel-1', text: 'Do work.', requestId: 'r1' }))
    assert.equal(response.status, 202)
    assert.equal((await response.json()).task.id, 'task_one')
    response = await fetch(`${base}/team/reply${caller}`, options({ taskId: 'task_one', text: 'Progress.', requestId: 'r2' }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).reply.id, 'reply_one')
  })
  assert.equal(calls[0][0], 'send')
  assert.equal(calls[1][0], 'reply')
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
