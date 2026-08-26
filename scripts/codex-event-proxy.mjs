#!/usr/bin/env node
import { WebSocket, WebSocketServer } from 'ws'
import { commentaryFromAppServerMessage } from '../daemon/codex-commentary.mjs'

function fail(message) {
  process.stderr.write(`sab-codex event proxy: ${message}\n`)
  process.exit(2)
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : null
}

const upstreamUrl = option('--upstream')
const agentPid = Number(option('--agent-pid'))
const tmux = option('--tmux') || ''
const daemonEndpoint = option('--daemon') || 'http://127.0.0.1:8877/codex/commentary'
if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(upstreamUrl || '')) fail('upstream must be a loopback WebSocket URL')
if (!Number.isSafeInteger(agentPid) || agentPid < 2) fail('missing correlated Codex process id')
if (!tmux || tmux.length > 128 || /[\u0000-\u001f\u007f]/.test(tmux)) fail('missing or invalid tmux identity')
if (!/^http:\/\/127\.0\.0\.1:\d+\/codex\/commentary$/.test(daemonEndpoint)) fail('daemon must be a loopback commentary endpoint')

const daemonUrl = new URL(daemonEndpoint)
daemonUrl.searchParams.set('ppid', String(agentPid))
daemonUrl.searchParams.set('tmux', tmux)
const deliveries = new Map()
const retryDelays = [0, 250, 1000, 3000, 7000, 15000]

async function deliver(commentary) {
  if (deliveries.has(commentary.itemId)) return deliveries.get(commentary.itemId)
  const pending = (async () => {
    for (const delay of retryDelays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        const response = await fetch(daemonUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-ccs-provider': 'codex' },
          body: JSON.stringify(commentary),
          signal: AbortSignal.timeout(15000),
        })
        if (response.ok) return
        if (![409, 429, 503].includes(response.status)) return
      } catch {}
    }
    process.stderr.write(`sab-codex event proxy: commentary delivery timed out (${commentary.itemId.slice(0, 12)})\n`)
  })().finally(() => deliveries.delete(commentary.itemId))
  deliveries.set(commentary.itemId, pending)
  return pending
}

function inspectFrame(data, isBinary) {
  if (isBinary) return
  try {
    const commentary = commentaryFromAppServerMessage(JSON.parse(data.toString('utf8')))
    if (commentary) void deliver(commentary)
  } catch {}
}

const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 128 << 20 })
let activeClient = null
let activeUpstream = null
const closeCode = value => Number.isInteger(value) && value >= 1000 && value < 5000 &&
  ![1004, 1005, 1006, 1015].includes(value) ? value : 1000

server.on('connection', (client, request) => {
  if (activeClient && activeClient.readyState !== WebSocket.CLOSED) {
    client.close(1013, 'one Codex TUI per bridge proxy')
    return
  }
  activeClient = client
  const offered = String(request.headers['sec-websocket-protocol'] || '')
    .split(',').map(value => value.trim()).filter(Boolean)
  const upstream = new WebSocket(upstreamUrl, offered.length ? offered : undefined, { maxPayload: 128 << 20 })
  activeUpstream = upstream
  const queued = []

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
    else if (upstream.readyState === WebSocket.CONNECTING && queued.length < 256) queued.push([data, isBinary])
  })
  upstream.on('open', () => {
    for (const [data, isBinary] of queued.splice(0)) upstream.send(data, { binary: isBinary })
  })
  upstream.on('message', (data, isBinary) => {
    inspectFrame(data, isBinary)
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(closeCode(code), reason.toString())
  })
  client.on('close', (code, reason) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close(closeCode(code), reason.toString())
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  })
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'Codex App Server unavailable')
  })
  client.on('error', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1011, 'Codex TUI disconnected')
  })
})

server.on('listening', () => {
  const address = server.address()
  process.stdout.write(`listening on: ws://127.0.0.1:${address.port}\n`)
})
server.on('error', error => fail(error.message))

function shutdown() {
  if (activeClient?.readyState === WebSocket.OPEN) activeClient.close(1001, 'bridge stopping')
  if (activeUpstream?.readyState === WebSocket.OPEN) activeUpstream.close(1001, 'bridge stopping')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
