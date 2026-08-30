import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { handleNodeHttp } from '../daemon/node-http.mjs'
import { NodeManagementError } from '../daemon/node-management.mjs'

async function startServer(t, management) {
  const server = http.createServer(async (req, res) => {
    const handled = await handleNodeHttp(req, res, new URL(req.url, 'http://localhost'), () => management)
    if (!handled) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

function rawRequest(url, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('node HTTP issues a one-use invitation, lists safe status, and revokes the exact node', async t => {
  const calls = []
  const management = {
    async issueInvitation(body) {
      calls.push(['invite', body])
      return {
        token: 'one-use-secret', nodeId: 'node_rade', operatorId: 'U000RADE', name: 'Rade MacBook',
        status: 'issued', issuedAt: '2026-08-28T12:00:00.000Z', expiresAt: '2026-08-28T12:10:00.000Z',
      }
    },
    status() {
      return {
        coordinatorId: 'coordinator_sergej', listener: { enabled: false },
        nodes: [{ id: 'local', name: 'This Mac', connected: true }],
        invitations: [{ nodeId: 'node_rade', operatorId: 'U000RADE', name: 'Rade MacBook', status: 'issued' }],
      }
    },
    async revoke(nodeId) { calls.push(['revoke', nodeId]); return { nodeId, revoked: true, disconnected: false } },
  }
  const base = await startServer(t, management)

  const invited = await fetch(`${base}/nodes/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operatorId: 'U000RADE', name: 'Rade MacBook', ttlSeconds: 600 }),
  })
  assert.equal(invited.status, 201)
  assert.equal((await invited.json()).invitation.token, 'one-use-secret')

  const listed = await fetch(`${base}/nodes`).then(response => response.json())
  assert.equal(JSON.stringify(listed).includes('one-use-secret'), false)
  assert.equal(listed.nodes[0].id, 'local')

  const revoked = await fetch(`${base}/nodes/${encodeURIComponent('node_rade')}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(revoked.status, 200)
  assert.equal((await revoked.json()).nodeId, 'node_rade')
  assert.deepEqual(calls, [
    ['invite', { operatorId: 'U000RADE', name: 'Rade MacBook', ttlSeconds: 600 }],
    ['revoke', 'node_rade'],
  ])
})

test('node HTTP rejects browser, non-loopback, non-JSON, oversized, and malformed mutations', async t => {
  let mutations = 0
  const base = await startServer(t, {
    issueInvitation: async () => { mutations++; return {} },
    status: () => ({ coordinatorId: 'coordinator_test', listener: { enabled: false }, nodes: [], invitations: [] }),
    revoke: async () => { mutations++; return {} },
  })
  const cases = [
    { headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{}', status: 403 },
    { headers: { host: 'example.com', 'content-type': 'application/json' }, body: '{}', status: 403 },
    { headers: { 'content-type': 'text/plain' }, body: '{}', status: 415 },
    { headers: { 'content-type': 'application/json' }, body: '{', status: 400 },
    { headers: { 'content-type': 'application/json' }, body: 'x'.repeat(20_000), status: 413 },
  ]
  for (const item of cases) {
    const response = await rawRequest(`${base}/nodes/invitations`, item)
    assert.equal(response.status, item.status, response.text)
  }
  const revokeFields = await rawRequest(`${base}/nodes/node_rade/revoke`, {
    headers: { 'content-type': 'application/json' }, body: '{"unexpected":true}',
  })
  assert.equal(revokeFields.status, 400)
  assert.equal(mutations, 0)
})

test('node HTTP initialization and management errors are actionable but do not leak internals', async t => {
  const base = await startServer(t, {
    issueInvitation: async () => { throw new NodeManagementError('operator_unavailable', 'Slack user is unavailable') },
    status: () => { throw new Error('SLACK_BOT_TOKEN=secret') },
    revoke: async () => null,
  })
  const invitation = await fetch(`${base}/nodes/invitations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.deepEqual(await invitation.json(), { ok: false, code: 'operator_unavailable', error: 'Slack user is unavailable' })
  const status = await fetch(`${base}/nodes`)
  const payload = await status.json()
  assert.equal(status.status, 500)
  assert.equal(payload.error, 'node management request failed')
  assert.equal(JSON.stringify(payload).includes('secret'), false)
})
