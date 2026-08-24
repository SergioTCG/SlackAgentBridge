import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { handleAutomationHttp } from '../daemon/automation-http.mjs'

async function withServer(lifecycle, run) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!(await handleAutomationHttp(req, res, url, lifecycle))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('automation HTTP create/status/stop preserves encoded external keys and response codes', async () => {
  const key = 'github:org/repo#123'
  const known = new Map()
  const calls = []
  const lifecycle = {
    create(body) {
      calls.push(['create', body])
      const existing = known.get(body.externalKey)
      if (existing) return { automation: existing, created: false }
      const automation = { externalKey: body.externalKey, tmux: 'sab-auto-1', status: 'pending' }
      known.set(body.externalKey, automation)
      return { automation, created: true }
    },
    status(externalKey) {
      const item = known.get(externalKey)
      return item ? { ...item, sessionId: null, channelId: null } : null
    },
    async stop(externalKey, options) {
      calls.push(['stop', externalKey, options])
      const item = known.get(externalKey)
      if (!item) return null
      item.status = 'stopped'
      return { ...item }
    },
  }
  await withServer(lifecycle, async base => {
    const create = await fetch(`${base}/automation/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ externalKey: key, cwd: '/tmp', provider: 'claude', flags: [], collaborators: [], initialPrompt: 'go' }),
    })
    assert.equal(create.status, 202)
    assert.deepEqual(await create.json(), { ok: true, created: true, externalKey: key, tmux: 'sab-auto-1', status: 'pending' })

    const status = await fetch(`${base}/automation/sessions/${encodeURIComponent(key)}`)
    assert.equal(status.status, 200)
    assert.equal((await status.json()).externalKey, key)

    const stop = await fetch(`${base}/automation/sessions/${encodeURIComponent(key)}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive: true }),
    })
    assert.equal(stop.status, 200)
    assert.equal((await stop.json()).status, 'stopped')
    assert.deepEqual(calls.at(-1), ['stop', key, { archive: true }])
  })
})

test('automation HTTP rejects malformed JSON, oversized bodies, bad stop options, and missing keys', async () => {
  const lifecycle = {
    create: () => assert.fail('invalid JSON must not reach lifecycle'),
    status: () => null,
    stop: async () => assert.fail('invalid stop must not reach lifecycle'),
  }
  await withServer(lifecycle, async base => {
    const malformed = await fetch(`${base}/automation/sessions`, { method: 'POST', body: '{' })
    assert.equal(malformed.status, 400)
    const oversized = await fetch(`${base}/automation/sessions`, { method: 'POST', body: 'x'.repeat(400_000) })
    assert.equal(oversized.status, 413)
    const invalidStop = await fetch(`${base}/automation/sessions/${encodeURIComponent('missing')}/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archive: 'yes' }),
    })
    assert.equal(invalidStop.status, 400)
    const missing = await fetch(`${base}/automation/sessions/${encodeURIComponent('missing')}`)
    assert.equal(missing.status, 404)
  })
})
