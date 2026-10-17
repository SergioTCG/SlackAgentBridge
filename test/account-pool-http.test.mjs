import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { handleAccountPoolHttp } from '../daemon/account-pool-http.mjs'

async function serverFor(runtime) {
  const state = { channels: { CWORK: 'native-id' }, sessions: { 'native-id': { id: 'native-id', channel: 'CWORK' } } }
  const server = http.createServer(async (req, res) => {
    if (!await handleAccountPoolHttp(req, res, new URL(req.url, 'http://localhost'), runtime, state)) { res.writeHead(404); res.end('{}') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}
test('account pool endpoints are opt-in, loopback-script-only, strict and exact-session bound', async () => {
  const calls = []
  const runtime = { enabled: true, status: channel => ({ mode: 'shadow', channel }), refresh: async id => { calls.push(['refresh', id]); return { status: 'scope-unavailable' } },
    switchAccount: async (session, account, options) => { calls.push(['switch', session.id, account, options]); return { status: 'committed' } } }
  const server = await serverFor(runtime)
  const post = (body, headers = {}) => fetch(`${server.base}/account-pools/switch`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const body = { channel: 'CWORK', session: 'native-id', account: 'owner@example.test', requestId: 'exact-request' }
  try {
    assert.equal((await fetch(`${server.base}/account-pools/status?channel=CWORK`)).status, 200)
    for (const headers of [{ origin: 'http://evil.test' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await post(body, headers)).status, 403)
    const wrongHost = await new Promise(resolve => {
      const request = http.request(`${server.base}/account-pools/switch`, { method: 'POST', headers: { host: 'evil.test', 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode) })
      request.end(JSON.stringify(body))
    })
    assert.equal(wrongHost, 403)
    assert.equal((await post(body, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post({ ...body, channel: '#mutable' })).status, 400)
    assert.equal((await post({ ...body, session: 'not-current' })).status, 409)
    assert.equal((await post({ ...body, token: 'NEVER-OUTPUT' })).status, 400)
    assert.equal(calls.length, 0)
    assert.equal((await post(body)).status, 200)
    assert.deepEqual(calls[0], ['switch', 'native-id', 'owner@example.test', { requestId: 'exact-request', expectedSessionId: 'native-id' }])
    assert.equal((await post({ ...body, preserveTask: 'task-exact' })).status, 200)
    assert.equal(calls[1][3].preserveTask, 'task-exact')
    assert.equal((await post({ ...body, preserveTask: true })).status, 400)
    runtime.enabled = false
    assert.equal((await post(body)).status, 404)
  } finally { await server.close() }
})

test('JSON-safe account CLI constructs payloads without evaluating inputs or exposing native errors', async () => {
  const calls = []
  const server = await serverFor({ enabled: true, status: channel => ({ channel }), refresh: async account => { calls.push(account); return { status: 'scope-unavailable' } },
    switchAccount: async (session, account, options) => { calls.push({ account, ...options }); return { status: 'committed', requestId: options.requestId } } })
  try {
    const run = args => new Promise((resolve, reject) => {
      const child = spawn(new URL('../bin/sab', import.meta.url).pathname, ['account', 'pool', ...args, '--json'], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SAB_ACCOUNT_URL: server.base }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }))
    })
    const result = await run(['switch', '--channel', 'CWORK', '--session', 'native-id', '--account', 'owner@example.test', '--request-id', 'safe-quoted'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).requestId, 'safe-quoted')
    assert.equal(calls[0].account, 'owner@example.test')
    const bad = await run(['switch', '--channel', 'CWORK', '--account', 'owner@example.test', '--request-id', 'missing-session'])
    assert.notEqual(bad.code, 0)
    assert.equal(calls.length, 1)
  } finally { await server.close() }
})

test('owner group CLI sends a quoted name as JSON and management rejects browser and secret-bearing input', async () => {
  const calls = []
  const server = await serverFor({ enabled: true, inventory: () => ({ registryRevision: 4 }), manage: input => { calls.push(input); return { status: 'staged' } } })
  try {
    const run = args => new Promise((resolve, reject) => {
      const child = spawn(new URL('../bin/sab', import.meta.url).pathname, ['account', 'group', ...args, '--json'], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SAB_ACCOUNT_URL: server.base }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
      child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }))
    })
    assert.equal((await run(['list'])).code, 0)
    const result = await run(['rename', 'owner', 'A "quoted" group', '--revision', '4', '--request-id', 'rename-once'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(calls[0], { requestId: 'rename-once', expectedRevision: 4, operation: { type: 'group-rename', group: 'owner', name: 'A "quoted" group' } })
    const request = { ...calls[0], operation: { type: 'account-drain', account: 'one', token: 'NEVER' } }
    const post = headers => fetch(`${server.base}/account-pools/manage`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(request) })
    assert.equal((await post({ origin: 'http://evil.test' })).status, 403)
    assert.equal((await post({})).status, 400)
    assert.equal(calls.length, 1)
  } finally { await server.close() }
})
