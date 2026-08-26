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

test('event proxy forwards every frame but reports only completed commentary', async () => {
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
    ]
    const received = []
    client.on('message', data => received.push(JSON.parse(data.toString())))
    for (const frame of frames) serverSocket.send(JSON.stringify(frame))

    await waitFor(() => deliveries.length === 1 && received.length === frames.length)
    assert.deepEqual(received, frames)
    assert.equal(deliveries[0].provider, 'codex')
    assert.match(deliveries[0].url, /^\/codex\/commentary\?ppid=\d+&tmux=ccs-test$/)
    assert.deepEqual(deliveries[0].body, {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'comment-1', text: 'The remote job remains healthy.',
    })
  } finally {
    client?.terminate()
    proxy.kill('SIGTERM')
    await Promise.race([once(proxy, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))])
    upstream.close()
    daemon.close()
  }
  assert.equal(stderr, '')
})
