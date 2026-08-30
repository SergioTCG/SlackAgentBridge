import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createNodeInvitationStore } from '../daemon/node-enrollment.mjs'
import { createNodeRegistry } from '../daemon/node-registry.mjs'
import { createCoordinatorNodeTransport, listenForNodeConnections } from '../daemon/node-transport.mjs'

function runCli(args, env, input = null) {
  return new Promise(resolve => {
    const child = spawn('bin/sab', ['node', ...args], { env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
    if (input !== null) child.stdin.end(input)
  })
}

test('sab node sends JSON-safe invitation, list, and exact revoke requests', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/nodes/invitations') res.end(JSON.stringify({ ok: true, invitation: { nodeId: 'node_rade', token: 'secret' } }))
    else if (req.url.endsWith('/revoke')) res.end(JSON.stringify({ ok: true, nodeId: 'node_rade', revoked: true }))
    else res.end(JSON.stringify({ ok: true, nodes: [] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = { ...process.env, SAB_NODE_URL: `http://127.0.0.1:${server.address().port}` }

  assert.equal((await runCli(['invite', '--operator', 'U000RADE', '--name', 'Rade; $(touch nope)', '--ttl-seconds', '600'], env)).status, 0)
  assert.equal((await runCli(['list'], env)).status, 0)
  assert.equal((await runCli(['revoke', 'node_rade'], env)).status, 0)
  assert.deepEqual(requests, [
    { method: 'POST', url: '/nodes/invitations', body: { operatorId: 'U000RADE', name: 'Rade; $(touch nope)', ttlSeconds: 600 } },
    { method: 'GET', url: '/nodes', body: null },
    { method: 'POST', url: '/nodes/node_rade/revoke', body: {} },
  ])
})

test('sab node enroll stores only a pinned identity and never prints or persists its token', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-node-cli-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const state = {}
  const invitations = createNodeInvitationStore({ state, nodeId: () => 'node_rade' })
  const invitation = invitations.issue({ operatorId: 'U000RADE', name: 'Rade MacBook' })
  const registry = createNodeRegistry({ state, adminUserId: 'U000ADMIN' })
  const transport = createCoordinatorNodeTransport({ coordinatorId: 'coordinator_test', registry, invitations })
  const listener = await listenForNodeConnections({ transport, host: '127.0.0.1', port: 0 })
  t.after(() => listener.close())
  const tokenFile = path.join(temp, 'invitation')
  fs.writeFileSync(tokenFile, `${invitation.token}\n`, { mode: 0o600 })
  const config = path.join(temp, 'config')
  const result = await runCli([
    'enroll', '--coordinator', listener.url, '--token-file', tokenFile,
  ], { ...process.env, CCS_CONFIG_DIR: config })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.nodeId, 'node_rade')
  assert.equal(result.stdout.includes(invitation.token), false)
  const connection = fs.readFileSync(path.join(config, 'node.json'), 'utf8')
  assert.equal(connection.includes(invitation.token), false)
  assert.equal(fs.statSync(path.join(config, 'node.json')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(config, 'node-key.pem')).mode & 0o777, 0o600)

  const status = await runCli(['status'], { ...process.env, CCS_CONFIG_DIR: config })
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).connection.nodeId, 'node_rade')
})

test('sab node enroll rejects invitation secrets passed on argv or in a group-readable file', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-node-cli-secret-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const env = { ...process.env, CCS_CONFIG_DIR: path.join(temp, 'config') }
  const argv = await runCli(['enroll', '--coordinator', 'ws://127.0.0.1:8878/nodes', '--token', 'do-not-accept-this-secret'], env)
  assert.equal(argv.status, 2)
  const tokenFile = path.join(temp, 'invitation')
  fs.writeFileSync(tokenFile, 'a-secure-length-invitation-token', { mode: 0o644 })
  const file = await runCli(['enroll', '--coordinator', 'ws://127.0.0.1:8878/nodes', '--token-file', tokenFile], env)
  assert.equal(file.status, 2)
  assert.match(file.stderr, /mode 0600/)
  fs.chmodSync(tokenFile, 0o600)
  const symlink = path.join(temp, 'invitation-link')
  fs.symlinkSync(tokenFile, symlink)
  const linked = await runCli(['enroll', '--coordinator', 'ws://127.0.0.1:8878/nodes', '--token-file', symlink], env)
  assert.equal(linked.status, 2)
  assert.match(linked.stderr, /regular file/)
})
