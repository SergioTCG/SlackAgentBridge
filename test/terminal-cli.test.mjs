import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'

function run(args, env) {
  return new Promise(resolve => {
    const child = spawn('bin/sab', ['terminal', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('sab terminal uses JSON-safe list and action requests', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'GET') res.end(JSON.stringify({ ok: true, terminals: [{ session: 'abcd1234', provider: 'codex', attached: false, cwd: '/work/a' }] }))
    else res.end(JSON.stringify({ ok: true, message: 'Opened 1, focused 0, already open 0.', failures: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = { ...process.env, SAB_TERMINAL_URL: `http://127.0.0.1:${server.address().port}` }

  const list = await run(['list', '--json'], env)
  assert.equal(list.status, 0, list.stderr)
  assert.equal(JSON.parse(list.stdout).terminals[0].session, 'abcd1234')
  const open = await run(['open', 'abcd1234'], env)
  assert.equal(open.status, 0, open.stderr)
  assert.deepEqual(requests, [
    { method: 'GET', url: '/terminals', body: null },
    { method: 'POST', url: '/terminals/open', body: { selector: 'abcd1234' } },
  ])
})
