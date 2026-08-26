import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { handleTerminalHttp } from '../daemon/terminal-http.mjs'

async function startServer(t, control) {
  const server = http.createServer(async (req, res) => {
    const handled = await handleTerminalHttp(req, res, new URL(req.url, 'http://localhost'), control)
    if (!handled) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return `http://127.0.0.1:${server.address().port}`
}

function rawRequest(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('terminal HTTP lists and mutates through the control boundary', async t => {
  const calls = []
  const base = await startServer(t, {
    list: async () => [{ session: 'abc12345', attached: false }],
    act: async (action, input) => {
      calls.push([action, input])
      return { action, total: 1, changed: 1, focused: 0, unchanged: 0, failures: [], message: 'done' }
    },
  })

  const listed = await fetch(`${base}/terminals`).then(response => response.json())
  assert.equal(listed.terminals[0].session, 'abc12345')

  const opened = await fetch(`${base}/terminals/open`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ selector: 'abc12345' }),
  })
  assert.equal(opened.status, 200)
  assert.deepEqual(calls, [['open', { selector: 'abc12345', all: false }]])
})

test('terminal HTTP rejects browser, non-loopback, non-JSON, and malformed mutations', async t => {
  let mutations = 0
  const base = await startServer(t, {
    list: async () => [],
    act: async () => { mutations++; return { failures: [] } },
  })

  const cases = [
    { headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{}' , status: 403 },
    { headers: { host: 'example.com', 'content-type': 'application/json' }, body: '{}', status: 403 },
    { headers: { 'content-type': 'text/plain' }, body: '{}', status: 415 },
    { headers: { 'content-type': 'application/json' }, body: '{', status: 400 },
    { headers: { 'content-type': 'application/json' }, body: '{}', status: 400 },
    { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: 'yes' }), status: 400 },
  ]
  for (const item of cases) {
    const response = await rawRequest(`${base}/terminals/close`, item)
    assert.equal(response.status, item.status, response.text)
  }
  assert.equal(mutations, 0)
})

test('terminal HTTP returns conflict without hiding exact action failures', async t => {
  const base = await startServer(t, {
    list: async () => [],
    act: async () => ({ failures: [{ session: 'abc12345', error: 'tmux unavailable' }], message: '0 closed; 1 failed.' }),
  })
  const response = await fetch(`${base}/terminals/close`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ all: true }),
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).failures[0].session, 'abc12345')
})
