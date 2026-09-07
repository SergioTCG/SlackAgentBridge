import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'

const proxyScript = new URL('../scripts/codex-event-proxy.mjs', import.meta.url)

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
})

const waitFor = async (condition, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = condition()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for proxy activity')
}

test('event proxy forwards every frame and reports commentary plus completed final answers', async () => {
  const deliveries = []
  const daemon = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    deliveries.push({ url: request.url, provider: request.headers['x-ccs-provider'], body: JSON.parse(body) })
    response.writeHead(202); response.end('accepted')
  })
  const daemonPort = await listen(daemon)
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(upstream, 'listening')
  const upstreamPort = upstream.address().port
  const proxy = spawn(process.execPath, [proxyScript.pathname,
    '--upstream', `ws://127.0.0.1:${upstreamPort}`,
    '--agent-pid', String(process.pid),
    '--tmux', 'ccs-test',
    '--daemon', `http://127.0.0.1:${daemonPort}/codex/commentary`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  proxy.stdout.on('data', chunk => { stdout += chunk })
  proxy.stderr.on('data', chunk => { stderr += chunk })

  let client
  try {
    const proxyUrl = await waitFor(() => stdout.match(/ws:\/\/127\.0\.0\.1:\d+/)?.[0])
    const serverConnection = once(upstream, 'connection')
    client = new WebSocket(proxyUrl)
    await once(client, 'open')
    const [serverSocket] = await serverConnection
    const frames = [
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: 'The remote job remains healthy.' } } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution', command: 'git diff' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'comment-1', delta: 'partial' } },
      // Some App Server clients receive a summary completion without the full
      // item list. The proxy must correlate the already completed final item
      // and release it only once the whole turn is complete.
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-2', item: { id: 'final-2', type: 'agentMessage', phase: 'final_answer', text: 'Must not escape.' } } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'failed', items: [] } } },
      // A later duplicate completion cannot recover the discarded failed turn.
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed', items: [] } } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-3', status: 'completed', items: [
        { id: 'final-3', type: 'agentMessage', phase: 'final_answer', text: 'Direct completion.' },
      ] } } },
    ]
    const received = []
    client.on('message', data => received.push(JSON.parse(data.toString())))
    for (const frame of frames.slice(0, 4)) serverSocket.send(JSON.stringify(frame))
    await waitFor(() => deliveries.length === 1 && received.length === 4)
    assert.equal(deliveries.some(delivery => delivery.url.startsWith('/codex/final')), false,
      'a final item must remain staged until its turn completes')
    for (const frame of frames.slice(4)) serverSocket.send(JSON.stringify(frame))

    await waitFor(() => deliveries.length === 3 && received.length === frames.length)
    assert.deepEqual(received, frames)
    const commentary = deliveries.find(delivery => delivery.url.startsWith('/codex/commentary'))
    const finals = deliveries.filter(delivery => delivery.url.startsWith('/codex/final'))
    assert.equal(commentary.provider, 'codex')
    assert.match(commentary.url, /^\/codex\/commentary\?ppid=\d+&tmux=ccs-test$/)
    assert.deepEqual(commentary.body, {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'comment-1', text: 'The remote job remains healthy.',
    })
    assert.equal(finals[0].provider, 'codex')
    assert.match(finals[0].url, /^\/codex\/final\?ppid=\d+&tmux=ccs-test$/)
    assert.deepEqual(finals.map(delivery => delivery.body), [{
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', text: 'Done.',
    }, {
      threadId: 'thread-1', turnId: 'turn-3', itemId: 'final-3', text: 'Direct completion.',
    }])
  } finally {
    client?.terminate()
    proxy.kill('SIGTERM')
    await Promise.race([once(proxy, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
    upstream.close()
    daemon.close()
  }
  assert.equal(stderr, '')
})
