import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

function run(args, env, stdin = null) {
  return new Promise(resolve => {
    const child = spawn('bin/sab', ['team', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
    if (stdin !== null) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

test('sab team refuses to run outside a bridged tmux session', async () => {
  const result = await run(['context'], { ...process.env, CCS_BRIDGE: '', CCS_TMUX: '' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /live Slack Agent Bridge session/)
})

test('sab team uses JSON-safe task, wait, reply, inbox, and file requests', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    const accepted = resource => JSON.stringify({
      ok: true,
      ...resource,
      mutation: body ? {
        requestId: JSON.parse(body).requestId,
        status: 'accepted',
      } : undefined,
    })
    if (req.url.startsWith('/team/context')) return res.end(JSON.stringify({ ok: true, context: { role: 'coordinator' } }))
    if (req.url.startsWith('/team/peers')) return res.end(JSON.stringify({ ok: true, peers: [{ alias: 'parallel-1' }] }))
    if (req.url.startsWith('/team/inbox')) return res.end(JSON.stringify({ ok: true, tasks: [{ id: 'task_one' }], nextCursor: 'cursor-two' }))
    if (req.url.startsWith('/team/tasks/task_warning')) return res.end(JSON.stringify({
      ok: true, task: { id: 'task_warning', status: 'completed_with_warning', result: '', warning: 'Hook omitted.' },
    }))
    if (req.url.startsWith('/team/tasks/task_release')) return res.end(JSON.stringify({
      ok: true, task: { id: 'task_release', status: 'awaiting_release', result: 'Ready.', releaseReady: true },
    }))
    if (req.url.startsWith('/team/tasks/')) return res.end(JSON.stringify({ ok: true, task: { id: 'task_one', status: 'completed', result: 'Done.' } }))
    if (req.url.startsWith('/team/mutations/')) return res.end(JSON.stringify({
      ok: true, mutation: { requestId: decodeURIComponent(req.url.split('/').at(-1).split('?')[0]), status: 'accepted' },
    }))
    if (req.url.startsWith('/team/send')) return res.end(accepted({ created: true, task: { id: 'task_one', status: 'queued' } }))
    if (req.url.startsWith('/team/reply') && JSON.parse(body).text === 'Uncertain reply.') {
      res.writeHead(503)
      return res.end(JSON.stringify({ ok: false, error: 'temporary bridge failure' }))
    }
    if (req.url.startsWith('/team/reply')) return res.end(accepted({ reply: { id: 'reply_one', text: body ? JSON.parse(body).text : '' } }))
    if (req.url.startsWith('/team/checkpoint')) return res.end(accepted({ reply: { id: 'reply_checkpoint' } }))
    if (req.url.startsWith('/team/complete')) return res.end(accepted({ task: { id: 'task_one', completionRequestedAt: 'now' } }))
    if (req.url.startsWith('/team/release')) return res.end(accepted({ task: { id: 'task_one', status: 'completed' } }))
    if (req.url.startsWith('/team/continue') && JSON.parse(body).text === 'Uncertain continuation.') {
      res.writeHead(503)
      return res.end(JSON.stringify({ ok: false, error: 'temporary bridge failure' }))
    }
    if (req.url.startsWith('/team/continue')) return res.end(accepted({ task: { id: 'task_two', parentTaskId: 'task_one' } }))
    if (req.url.startsWith('/team/cancel')) return res.end(accepted({ task: { id: 'task_one', status: 'cancelled' } }))
    if (req.url.startsWith('/team/replace')) return res.end(accepted({ task: { id: 'task_one', instruction: JSON.parse(body).text } }))
    if (req.url.startsWith('/team/message') && JSON.parse(body).text === 'Uncertain delivery.') {
      res.writeHead(503)
      return res.end(JSON.stringify({ ok: false, error: 'provider unavailable' }))
    }
    if (req.url.startsWith('/team/message')) return res.end(accepted({ message: { id: 'message_one', text: JSON.parse(body).text } }))
    if (req.url.startsWith('/team/mode')) return res.end(JSON.stringify({ ok: true, mode: JSON.parse(body).mode }))
    res.writeHead(404); res.end(JSON.stringify({ ok: false }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SAB_TEAM_URL: `http://127.0.0.1:${server.address().port}`,
    CCS_BRIDGE: '1', CCS_TMUX: 'sab-test', CCS_PROVIDER: 'codex',
  }

  const context = await run(['context', '--json'], env)
  assert.equal(context.status, 0, context.stderr)
  assert.equal(JSON.parse(context.stdout).role, 'coordinator')
  const sent = await run(['send', '--to', 'parallel-1', '--stdin', '--request-id', 'stable-request-1'], env, 'Line one\n"quoted"; $(not shell)\n')
  assert.equal(sent.status, 0, sent.stderr)
  assert.equal(JSON.parse(sent.stdout).id, 'task_one')
  assert.equal(JSON.parse(sent.stdout).mutation.requestId, 'stable-request-1')
  const replied = await run(['reply', '--task', 'task_one', '--message', 'Progress.'], env)
  assert.equal(replied.status, 0, replied.stderr)
  assert.match(JSON.parse(replied.stdout).mutation.requestId, /^[0-9a-f-]{36}$/)
  const checkpoint = await run(['checkpoint', '--task', 'task_one', '--pending', 'ci,merge', '--message', 'Still running.'], env)
  assert.equal(checkpoint.status, 0, checkpoint.stderr)
  assert.match(JSON.parse(checkpoint.stdout).mutation.requestId, /^[0-9a-f-]{36}$/)
  const malformedCheckpoint = await run([
    'checkpoint', '--task', 'task_one', '--pending', ',', '--message', 'Malformed clear.',
  ], env)
  assert.equal(malformedCheckpoint.status, 2)
  assert.match(malformedCheckpoint.stderr, /pending.*none/i)
  assert.equal(requests.some(request => request.url.startsWith('/team/checkpoint') &&
    request.body?.text === 'Malformed clear.'), false)
  const completed = await run(['complete', '--task', 'task_one', '--message', 'Everything passed.'], env)
  const released = await run(['release', '--task', 'task_one'], env)
  const continued = await run(['continue', '--task', 'task_one', '--message', 'Follow up.'], env)
  for (const result of [completed, released, continued]) {
    assert.equal(result.status, 0, result.stderr)
    assert.match(JSON.parse(result.stdout).mutation.requestId, /^[0-9a-f-]{36}$/)
  }
  const uncertainContinuation = await run([
    'continue', '--task', 'task_one', '--message', 'Uncertain continuation.',
  ], env)
  assert.equal(uncertainContinuation.status, 1)
  const uncertainContinuationRequest = requests.find(request =>
    request.url.startsWith('/team/continue') && request.body?.text === 'Uncertain continuation.')
  assert.match(uncertainContinuation.stderr,
    new RegExp(`sab team mutation --request-id ${uncertainContinuationRequest.body.requestId}(?:\\s|$)`))
  assert.doesNotMatch(uncertainContinuation.stderr, /--task task_one/)
  assert.equal((await run(['mutation', '--request-id', 'stable-request-1', '--task', 'task_one'], env)).status, 0)
  const file = await run(['send-file', '--task', 'task_one', '--message', 'Report.', '--', 'report final.pdf'], env)
  assert.equal(file.status, 0, file.stderr)
  assert.match(JSON.parse(file.stdout).mutation.requestId, /^[0-9a-f-]{36}$/)
  const inbox = await run(['inbox', '--limit', '5', '--active', '--target', 'parallel-1', '--status', 'queued,running', '--since', '2026-01-01T00:00:00.000Z', '--json'], env)
  assert.deepEqual(JSON.parse(inbox.stdout), [{ id: 'task_one' }])
  assert.equal((await run(['inbox', '--after', 'task_old', '--limit', '5', '--json'], env)).status, 0)
  const page = await run(['inbox', '--limit', '5', '--page', '--cursor', 'cursor-one', '--json'], env)
  assert.deepEqual(JSON.parse(page.stdout), { tasks: [{ id: 'task_one' }], nextCursor: 'cursor-two' })
  const cancelled = await run(['cancel', '--task', 'task_one', '--reason', 'Done elsewhere.'], env)
  const replaced = await run(['replace', '--task', 'task_one', '--stdin'], env, 'New work.')
  const messaged = await run(['message', '--task', 'task_one', '--message', 'Proceed.'], env)
  for (const result of [cancelled, replaced, messaged]) {
    assert.equal(result.status, 0, result.stderr)
    assert.match(JSON.parse(result.stdout).mutation.requestId, /^[0-9a-f-]{36}$/)
  }
  const uncertainMessage = await run(['message', '--task', 'task_one', '--message', 'Uncertain delivery.'], env)
  assert.equal(uncertainMessage.status, 1)
  const uncertainRequest = requests.find(request =>
    request.url.startsWith('/team/message') && request.body?.text === 'Uncertain delivery.')
  assert.match(uncertainRequest.body.requestId, /^[0-9a-f-]{36}$/)
  assert.match(uncertainMessage.stderr, new RegExp(`retry safely with --request-id ${uncertainRequest.body.requestId}`))
  assert.match(uncertainMessage.stderr, /verify acceptance with sab team mutation/)
  const uncertainReply = await run(['reply', '--task', 'task_one', '--message', 'Uncertain reply.'], env)
  assert.equal(uncertainReply.status, 1)
  const uncertainReplyRequest = requests.find(request =>
    request.url.startsWith('/team/reply') && request.body?.text === 'Uncertain reply.')
  assert.match(uncertainReply.stderr, new RegExp(`retry safely with --request-id ${uncertainReplyRequest.body.requestId}`))
  assert.equal((await run(['mode', 'draining'], env)).status, 0)
  const waited = await run(['wait', '--task', 'task_one', '--timeout', '2', '--json'], env)
  assert.equal(waited.status, 0, waited.stderr)
  assert.equal(JSON.parse(waited.stdout).result, 'Done.')
  const warned = await run(['wait', '--task', 'task_warning', '--timeout', '2', '--json'], env)
  assert.equal(warned.status, 0, warned.stderr)
  assert.equal(JSON.parse(warned.stdout).status, 'completed_with_warning')
  const releasable = await run(['wait', '--task', 'task_release', '--timeout', '2', '--json'], env)
  assert.equal(releasable.status, 0, releasable.stderr)
  assert.equal(JSON.parse(releasable.stdout).status, 'awaiting_release')
  assert.equal(JSON.parse(releasable.stdout).releaseReady, true)

  const sendRequest = requests.find(request => request.url.startsWith('/team/send'))
  assert.equal(sendRequest.headers['x-ccs-provider'], 'codex')
  assert.match(sendRequest.url, /ppid=\d+&tmux=sab-test/)
  assert.equal(sendRequest.body.to, 'parallel-1')
  assert.equal(sendRequest.body.text, 'Line one\n"quoted"; $(not shell)')
  assert.equal(sendRequest.body.requestId, 'stable-request-1')
  assert.match(requests.find(request => request.url.includes('after=task_old')).url, /after=task_old/)
  assert.match(requests.find(request => request.url.includes('active=true')).url, /target=parallel-1/)
  const fileRequest = requests.filter(request => request.url.startsWith('/team/reply'))[1]
  assert.deepEqual(fileRequest.body.paths, [path.resolve('report final.pdf')])
})
