#!/usr/bin/env node
import { WebSocket, WebSocketServer } from 'ws'
import {
  codexFinalFromAppServerMessage,
  commentaryFromAppServerMessage,
  finalAnswerItemFromAppServerMessage,
} from '../daemon/codex-commentary.mjs'

function fail(message) {
  process.stderr.write(`sab Codex event proxy: ${message}\n`)
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
const finalDaemonUrl = new URL(daemonUrl)
finalDaemonUrl.pathname = '/codex/final'
const deliveries = new Map()
let deliveryTail = Promise.resolve()
let shuttingDown = false
let activeRequest = null
let stableDeliveryFailure = null
let resolveShutdownSignal
const shutdownSignal = new Promise(resolve => { resolveShutdownSignal = resolve })
const retryDelays = [0, 250, 1000, 3000, 7000, 15000]
const SHUTDOWN_DRAIN_MS = 30000
const pendingFinalAnswers = new Map()
const MAX_PENDING_FINALS = 128

async function waitForRetry(delay, label) {
  if (shuttingDown && label === 'commentary') return false
  if (!delay) return true
  if (label === 'final') {
    // Stable finals retain their real backoff even after SIGTERM. Collapsing
    // retries into a burst makes transient daemon/Slack pressure permanent.
    await new Promise(resolve => setTimeout(resolve, delay))
    return true
  }
  await Promise.race([
    new Promise(resolve => setTimeout(resolve, delay)),
    shutdownSignal,
  ])
  // Commentary is useful progress, but must not strand a stable fallback final
  // behind backoff when the TUI is exiting.
  return !shuttingDown
}

async function postDelivery(endpoint, payload, label) {
  const controller = new AbortController()
  const request = { controller, label }
  activeRequest = request
  const timeout = setTimeout(() => controller.abort(), shuttingDown ? 3000 : 15000)
  try {
    return await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccs-provider': 'codex' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
    if (activeRequest === request) activeRequest = null
  }
}

function deliver({ key, payload, endpoint, label }) {
  if (deliveries.has(key)) return deliveries.get(key)
  // App Server frames arrive in semantic order, but independent fetches can
  // complete out of order under Slack backoff or daemon latency. That can put a
  // later final ahead of an earlier final—or a final ahead of its commentary—
  // and make the daemon reject the delayed event as stale. Reserve the key
  // synchronously, then serialize stable commentary/final deliveries in the
  // exact order in which inspectFrame accepted them.
  const pending = deliveryTail.then(async () => {
    let lastFailure = null
    for (const delay of retryDelays) {
      if (!(await waitForRetry(delay, label))) return
      try {
        const response = await postDelivery(endpoint, payload, label)
        if (response.ok) return
        lastFailure = new Error(`HTTP ${response.status}`)
        if (![409, 429, 503].includes(response.status)) break
      } catch (error) {
        lastFailure = error
      }
      if (shuttingDown && label === 'commentary') return
    }
    const failure = new Error(`${label} delivery failed (${payload.itemId.slice(0, 12)}): ${String(lastFailure?.message || 'retry budget exhausted')}`)
    process.stderr.write(`sab Codex event proxy: ${failure.message}\n`)
    if (label === 'final') throw failure
  })
  deliveries.set(key, pending)
  deliveryTail = pending.catch(error => {
    if (label === 'final' && !stableDeliveryFailure) stableDeliveryFailure = error
  })
  void pending.then(
    () => { if (deliveries.get(key) === pending) deliveries.delete(key) },
    () => { if (deliveries.get(key) === pending) deliveries.delete(key) },
  )
  return pending
}

function finalKey(value) {
  return `${value.threadId}\u0000${value.turnId}`
}

function finalFromFrame(message) {
  const item = finalAnswerItemFromAppServerMessage(message)
  if (item) {
    const key = finalKey(item)
    pendingFinalAnswers.delete(key)
    pendingFinalAnswers.set(key, item)
    while (pendingFinalAnswers.size > MAX_PENDING_FINALS) pendingFinalAnswers.delete(pendingFinalAnswers.keys().next().value)
    return null
  }
  if (message?.method !== 'turn/completed') return null
  const threadId = message.params?.threadId
  const turnId = message.params?.turn?.id
  const key = finalKey({ threadId, turnId })
  const staged = pendingFinalAnswers.get(key) || null
  pendingFinalAnswers.delete(key)
  return codexFinalFromAppServerMessage(message) ||
    (message.params?.turn?.status === 'completed' ? staged : null)
}

function inspectFrame(data, isBinary) {
  if (isBinary) return
  try {
    const message = JSON.parse(data.toString('utf8'))
    const commentary = commentaryFromAppServerMessage(message)
    if (commentary) void deliver({
      key: `commentary:${commentary.threadId}\u0000${commentary.turnId}\u0000${commentary.itemId}`,
      payload: commentary,
      endpoint: daemonUrl,
      label: 'commentary',
    })
    const final = finalFromFrame(message)
    if (final) void deliver({
      key: `final:${finalKey(final)}`,
      payload: final,
      endpoint: finalDaemonUrl,
      label: 'final',
    })
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

let shutdownPromise = null
function shutdown() {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  resolveShutdownSignal()
  if (activeRequest?.label === 'commentary') activeRequest.controller.abort()
  if (activeClient?.readyState === WebSocket.OPEN) activeClient.close(1001, 'bridge stopping')
  if (activeUpstream?.readyState === WebSocket.OPEN) activeUpstream.close(1001, 'bridge stopping')
  server.close()
  const timeout = new Promise(resolve => setTimeout(() => resolve(false), SHUTDOWN_DRAIN_MS))
  shutdownPromise = Promise.race([
    deliveryTail.then(() => !stableDeliveryFailure),
    timeout,
  ]).then(drained => {
    if (!drained) {
      process.stderr.write('sab Codex event proxy: shutdown drain timed out; a stable delivery may require daemon recovery\n')
    }
    process.exit(drained ? 0 : 1)
  })
  return shutdownPromise
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
