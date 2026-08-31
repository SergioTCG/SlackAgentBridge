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
    if (req.url.startsWith('/team/context')) return res.end(JSON.stringify({ ok: true, context: { role: 'coordinator' } }))
    if (req.url.startsWith('/team/peers')) return res.end(JSON.stringify({ ok: true, peers: [{ alias: 'parallel-1' }] }))
    if (req.url.startsWith('/team/inbox')) return res.end(JSON.stringify({ ok: true, tasks: [{ id: 'task_one' }] }))
    if (req.url.startsWith('/team/tasks/')) return res.end(JSON.stringify({ ok: true, task: { id: 'task_one', status: 'completed', result: 'Done.' } }))
    if (req.url.startsWith('/team/send')) return res.end(JSON.stringify({ ok: true, created: true, task: { id: 'task_one', status: 'queued' } }))
    if (req.url.startsWith('/team/reply')) return res.end(JSON.stringify({ ok: true, reply: { id: 'reply_one', text: body ? JSON.parse(body).text : '' } }))
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
  const replied = await run(['reply', '--task', 'task_one', '--message', 'Progress.'], env)
  assert.equal(replied.status, 0, replied.stderr)
  const file = await run(['send-file', '--task', 'task_one', '--message', 'Report.', '--', 'report final.pdf'], env)
  assert.equal(file.status, 0, file.stderr)
  const inbox = await run(['inbox', '--after', 'task_old', '--limit', '5', '--json'], env)
  assert.deepEqual(JSON.parse(inbox.stdout), [{ id: 'task_one' }])
  const waited = await run(['wait', '--task', 'task_one', '--timeout', '2', '--json'], env)
  assert.equal(waited.status, 0, waited.stderr)
  assert.equal(JSON.parse(waited.stdout).result, 'Done.')

  const sendRequest = requests.find(request => request.url.startsWith('/team/send'))
  assert.equal(sendRequest.headers['x-ccs-provider'], 'codex')
  assert.match(sendRequest.url, /ppid=\d+&tmux=sab-test/)
  assert.equal(sendRequest.body.to, 'parallel-1')
  assert.equal(sendRequest.body.text, 'Line one\n"quoted"; $(not shell)')
  assert.equal(sendRequest.body.requestId, 'stable-request-1')
  assert.match(requests.find(request => request.url.startsWith('/team/inbox')).url, /after=task_old/)
  const fileRequest = requests.filter(request => request.url.startsWith('/team/reply'))[1]
  assert.deepEqual(fileRequest.body.paths, [path.resolve('report final.pdf')])
})
