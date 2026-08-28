import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { WebSocket, WebSocketServer } from 'ws'
import { createNodeChallengeStore, signNodeChallenge } from './node-auth.mjs'
import { fingerprintNodePublicKey } from './node-registry.mjs'
import {
  MAX_NODE_CONTROL_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  createNodeEnvelope,
  parseNodeEnvelope,
} from './node-protocol.mjs'
import { validateCoordinatorUrl } from './node-keys.mjs'
import { validateNodeId } from './nodes.mjs'

const NODE_PATH = '/nodes'
const HANDSHAKE_TIMEOUT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 45_000
const MAX_PENDING_CONNECTIONS = 128
const MAX_PUBLIC_KEY_BYTES = 4096
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function decodeJson(data) {
  const buffer = Buffer.from(data)
  if (buffer.length > MAX_NODE_CONTROL_FRAME_BYTES) throw new Error('node frame is too large')
  let value
  try { value = JSON.parse(buffer.toString('utf8')) }
  catch { throw new Error('node frame is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('node frame must be a JSON object')
  return value
}

function sendJson(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('node connection is not open')
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > MAX_NODE_CONTROL_FRAME_BYTES) throw new Error('node frame is too large')
  socket.send(json)
}

function errorFrame(code) {
  return { protocol: NODE_PROTOCOL_VERSION, kind: 'error', code, message: code }
}

function closeWithError(socket, code) {
  try { sendJson(socket, errorFrame(code)) } catch {}
  try { socket.close(4003, code.slice(0, 100)) } catch {}
}

function handshakeFrame(value, expectedKind) {
  if (value.protocol !== NODE_PROTOCOL_VERSION) throw new Error('unsupported_protocol')
  if (value.kind !== expectedKind) throw new Error('unexpected_handshake')
  return value
}

export function createCoordinatorNodeTransport({
  coordinatorId,
  registry,
  invitations,
  onEnvelope = async () => {},
  now = Date.now,
  handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const coordinator = validateNodeId(coordinatorId)
  if (!registry || !invitations) throw new Error('node transport requires a registry and invitation store')
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 10) throw new Error('invalid node handshake timeout')
  if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1000) throw new Error('invalid node heartbeat timeout')
  const challenges = createNodeChallengeStore({ coordinatorId: coordinator, now })
  const active = new Map()
  const peers = new Set()

  function connectionRows() {
    return [...active.entries()].map(([nodeId, entry]) => ({
      nodeId,
      epoch: entry.epoch,
      connectedAt: entry.connectedAt,
      lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
    })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  }

  function accept(socket) {
    if (peers.size >= MAX_PENDING_CONNECTIONS) {
      closeWithError(socket, 'too_many_connections')
      return
    }
    peers.add(socket)
    const context = { phase: 'initial', nodeId: null, epoch: null }
    const handshakeTimer = setTimeout(() => {
      if (!['active', 'enrolled'].includes(context.phase)) closeWithError(socket, 'handshake_timeout')
    }, handshakeTimeoutMs)
    handshakeTimer.unref?.()

    async function processFrame(data, isBinary) {
      if (isBinary) throw new Error('binary_control_frame')
      const value = decodeJson(data)
      if (context.phase === 'initial') {
        if (value.kind === 'enroll') {
          handshakeFrame(value, 'enroll')
          const rawToken = String(value.token || '')
          const publicKey = String(value.publicKey || '')
          if (Buffer.byteLength(publicKey) > MAX_PUBLIC_KEY_BYTES) throw new Error('enrollment_failed')
          let fingerprint
          try { fingerprint = fingerprintNodePublicKey(publicKey) }
          catch { throw new Error('enrollment_failed') }
          let invitation
          try {
            invitation = invitations.claim(rawToken, fingerprint)
            registry.registerEnrolledNode({
              nodeId: invitation.nodeId,
              name: invitation.name,
              operatorId: invitation.operatorId,
              publicKey,
            })
            invitation = invitations.complete(rawToken, fingerprint)
          } catch (error) {
            log('node enrollment rejected', error?.message || String(error))
            throw new Error('enrollment_failed')
          }
          sendJson(socket, {
            protocol: NODE_PROTOCOL_VERSION,
            kind: 'enrolled',
            nodeId: invitation.nodeId,
            coordinatorId: coordinator,
            operatorId: invitation.operatorId,
            name: invitation.name,
            keyFingerprint: fingerprint,
          })
          context.phase = 'enrolled'
          clearTimeout(handshakeTimer)
          // Enrollment is a one-shot ceremony, never a session transport. The
          // node reconnects with signed challenge authentication afterwards.
          try { socket.close(1000, 'enrollment complete') } catch {}
          return
        }
        handshakeFrame(value, 'hello')
        const nodeId = validateNodeId(value.nodeId)
        if (!registry.publicKeyFor(nodeId)) throw new Error('unknown_node')
        const challenge = challenges.issue({ nodeId, epoch: registry.nextConnectionEpoch(nodeId) })
        context.phase = 'challenged'
        context.nodeId = nodeId
        sendJson(socket, { protocol: NODE_PROTOCOL_VERSION, kind: 'challenge', ...challenge })
        return
      }

      if (context.phase === 'challenged') {
        handshakeFrame(value, 'authenticate')
        if (value.nodeId !== context.nodeId) throw new Error('authentication_failed')
        let challenge
        try {
          challenge = challenges.verify({
            challengeId: value.challengeId,
            nodeId: context.nodeId,
            signature: value.signature,
            publicKey: registry.publicKeyFor(context.nodeId),
          })
        } catch (error) {
          log('node authentication rejected', context.nodeId, error?.message || String(error))
          throw new Error('authentication_failed')
        }
        const epoch = registry.advanceConnectionEpoch(context.nodeId)
        if (epoch !== challenge.epoch) throw new Error('authentication_race')
        const prior = active.get(context.nodeId)
        context.phase = 'active'
        clearTimeout(handshakeTimer)
        context.epoch = epoch
        const entry = {
          socket,
          epoch,
          connectedAt: new Date(now()).toISOString(),
          lastSeenAt: now(),
        }
        active.set(context.nodeId, entry)
        sendJson(socket, {
          protocol: NODE_PROTOCOL_VERSION,
          kind: 'ready',
          nodeId: context.nodeId,
          coordinatorId: coordinator,
          epoch,
          heartbeatTimeoutMs,
        })
        if (prior && prior.socket !== socket) {
          try { sendJson(prior.socket, errorFrame('superseded_connection')) } catch {}
          try { prior.socket.close(4001, 'superseded connection') } catch {}
        }
        return
      }

      if (context.phase !== 'active') throw new Error('unexpected_handshake')
      const envelope = parseNodeEnvelope(value, { now: now() })
      if (envelope.nodeId !== context.nodeId || envelope.epoch !== context.epoch) throw new Error('stale_node_epoch')
      if (!['result', 'event', 'heartbeat'].includes(envelope.kind)) throw new Error('invalid_node_direction')
      const current = active.get(context.nodeId)
      if (!current || current.socket !== socket || current.epoch !== context.epoch) throw new Error('stale_node_epoch')
      current.lastSeenAt = now()
      if (envelope.kind !== 'heartbeat') await onEnvelope(envelope)
    }

    socket.on('message', (data, isBinary) => {
      processFrame(data, isBinary).catch(error => {
        const code = /^[a-z][a-z0-9_]{0,63}$/.test(error?.message || '') ? error.message : 'invalid_node_frame'
        log('node transport frame rejected', context.nodeId || 'unbound', code)
        closeWithError(socket, code)
      })
    })
    socket.on('close', () => {
      clearTimeout(handshakeTimer)
      peers.delete(socket)
      if (context.nodeId && active.get(context.nodeId)?.socket === socket) active.delete(context.nodeId)
    })
    socket.on('error', error => log('node transport socket error', context.nodeId || 'unbound', error?.message || String(error)))
  }

  function send(nodeId, envelope) {
    const id = validateNodeId(nodeId)
    const connection = active.get(id)
    if (!connection) throw new Error(`execution node ${id} is offline`)
    const parsed = parseNodeEnvelope(envelope, { now: now() })
    if (parsed.kind !== 'command' || parsed.nodeId !== id || parsed.epoch !== connection.epoch) {
      throw new Error('coordinator command does not match the active node epoch')
    }
    sendJson(connection.socket, parsed)
  }

  function disconnect(nodeId, reason = 'node_disconnected') {
    const id = validateNodeId(nodeId)
    const connection = active.get(id)
    if (!connection) return false
    active.delete(id)
    try { sendJson(connection.socket, errorFrame(reason)) } catch {}
    try { connection.socket.close(4001, reason.slice(0, 100)) } catch {}
    return true
  }

  const sweep = setInterval(() => {
    const current = now()
    for (const [nodeId, connection] of active) {
      if (current - connection.lastSeenAt <= heartbeatTimeoutMs) continue
      log('node heartbeat expired', nodeId, connection.epoch)
      closeWithError(connection.socket, 'heartbeat_timeout')
    }
  }, Math.max(1000, Math.floor(heartbeatTimeoutMs / 3)))
  sweep.unref?.()

  function close() {
    clearInterval(sweep)
    for (const socket of peers) {
      try { socket.terminate() } catch {}
    }
    peers.clear()
    active.clear()
  }

  return Object.freeze({ accept, close, connections: connectionRows, disconnect, send })
}

export function listenForNodeConnections({ transport, host = '127.0.0.1', port = 8878, tls = null } = {}) {
  if (!transport || typeof transport.accept !== 'function') throw new Error('node listener requires a coordinator transport')
  const loopback = LOOPBACK_HOSTS.has(host)
  if (!loopback && (!tls?.key || !tls?.cert)) throw new Error('TLS is required for a non-loopback node listener')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('invalid node listener port')

  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, (_req, res) => { res.writeHead(404); res.end() })
    : http.createServer((_req, res) => { res.writeHead(404); res.end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_NODE_CONTROL_FRAME_BYTES })
  server.on('upgrade', (req, socket, head) => {
    let pathname = ''
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch {}
    if (pathname !== NODE_PATH) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  })
  wss.on('connection', socket => transport.accept(socket))

  return new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const address = server.address()
      const actualHost = address.address.includes(':') ? `[${address.address}]` : address.address
      const scheme = tls ? 'wss' : 'ws'
      resolve({
        url: `${scheme}://${actualHost}:${address.port}${NODE_PATH}`,
        address,
        close: async () => {
          transport.close()
          for (const client of wss.clients) { try { client.terminate() } catch {} }
          await new Promise(done => wss.close(() => done()))
          await new Promise(done => server.close(() => done()))
        },
      })
    })
  })
}

function clientError(value, fallback) {
  const code = value?.kind === 'error' && typeof value.code === 'string' ? value.code : fallback
  return new Error(`SAB node connection failed: ${code}`)
}

export function enrollNodeWithCoordinator({
  url,
  token,
  publicKey,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  WebSocketImpl = WebSocket,
} = {}) {
  const coordinatorUrl = validateCoordinatorUrl(url)
  if (typeof token !== 'string' || token.length < 16 || /\s/.test(token)) throw new Error('invalid node invitation token')
  if (typeof publicKey !== 'string' || Buffer.byteLength(publicKey) > MAX_PUBLIC_KEY_BYTES) throw new Error('invalid node public key')
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(coordinatorUrl, { maxPayload: MAX_NODE_CONTROL_FRAME_BYTES })
    let settled = false
    const timer = setTimeout(() => finish(new Error('SAB node enrollment timed out')), timeoutMs)
    timer.unref?.()
    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch {}
      if (error) reject(error); else resolve(value)
    }
    socket.once('open', () => {
      try { sendJson(socket, { protocol: NODE_PROTOCOL_VERSION, kind: 'enroll', token, publicKey }) }
      catch (error) { finish(error) }
    })
    socket.on('message', data => {
      try {
        const value = decodeJson(data)
        if (value.kind === 'error') return finish(clientError(value, 'enrollment_failed'))
        handshakeFrame(value, 'enrolled')
        finish(null, {
          nodeId: validateNodeId(value.nodeId),
          coordinatorId: validateNodeId(value.coordinatorId),
          operatorId: String(value.operatorId),
          name: String(value.name),
          keyFingerprint: String(value.keyFingerprint),
        })
      } catch (error) { finish(error) }
    })
    socket.once('error', error => finish(error))
    socket.once('close', () => { if (!settled) finish(new Error('SAB node enrollment connection closed')) })
  })
}

export function connectAuthenticatedNode({
  url,
  nodeId,
  coordinatorId,
  privateKey,
  heartbeatMs = 15_000,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
  onEnvelope = async () => {},
  onError = () => {},
  WebSocketImpl = WebSocket,
} = {}) {
  const coordinatorUrl = validateCoordinatorUrl(url)
  const node = validateNodeId(nodeId)
  const expectedCoordinator = validateNodeId(coordinatorId)
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) throw new Error('invalid heartbeat interval')

  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(coordinatorUrl, { maxPayload: MAX_NODE_CONTROL_FRAME_BYTES })
    let settled = false
    let ready = null
    let heartbeat = null
    const timer = setTimeout(() => finish(new Error('SAB node authentication timed out')), timeoutMs)
    timer.unref?.()

    function finish(error, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { try { socket.close() } catch {}; reject(error) }
      else resolve(value)
    }

    function sendHeartbeat() {
      if (!ready || socket.readyState !== WebSocket.OPEN) return
      try {
        sendJson(socket, createNodeEnvelope({
          kind: 'heartbeat',
          id: `heartbeat_${crypto.randomBytes(12).toString('hex')}`,
          nodeId: node,
          epoch: ready.epoch,
          sentAt: new Date().toISOString(),
          payload: { capabilities: [] },
        }))
      } catch (error) { onError(error) }
    }

    socket.once('open', () => {
      try { sendJson(socket, { protocol: NODE_PROTOCOL_VERSION, kind: 'hello', nodeId: node }) }
      catch (error) { finish(error) }
    })
    socket.on('message', data => {
      try {
        const value = decodeJson(data)
        if (value.kind === 'error') {
          const error = clientError(value, ready ? 'connection_failed' : 'authentication_failed')
          if (!ready) finish(error); else onError(error)
          return
        }
        if (!ready) {
          if (value.kind === 'challenge') {
            if (validateNodeId(value.coordinatorId) !== expectedCoordinator) {
              return finish(new Error('SAB coordinator identity mismatch'))
            }
            if (validateNodeId(value.nodeId) !== node) return finish(new Error('SAB node identity mismatch'))
            const signature = signNodeChallenge(value, privateKey)
            sendJson(socket, {
              protocol: NODE_PROTOCOL_VERSION,
              kind: 'authenticate',
              nodeId: node,
              challengeId: value.challengeId,
              signature,
            })
            return
          }
          handshakeFrame(value, 'ready')
          if (validateNodeId(value.coordinatorId) !== expectedCoordinator) return finish(new Error('SAB coordinator identity mismatch'))
          if (validateNodeId(value.nodeId) !== node) return finish(new Error('SAB node identity mismatch'))
          if (!Number.isSafeInteger(value.epoch) || value.epoch < 1) return finish(new Error('invalid SAB node connection epoch'))
          ready = { epoch: value.epoch }
          const connection = {
            socket,
            nodeId: node,
            coordinatorId: expectedCoordinator,
            epoch: value.epoch,
            send(envelope) {
              const parsed = parseNodeEnvelope(envelope)
              if (parsed.nodeId !== node || parsed.epoch !== ready.epoch || !['result', 'event', 'heartbeat'].includes(parsed.kind)) {
                throw new Error('node envelope does not match this authenticated connection')
              }
              sendJson(socket, parsed)
            },
            close() {
              if (heartbeat) clearInterval(heartbeat)
              try { socket.close(1000, 'node closing') } catch {}
            },
          }
          if (heartbeatMs) {
            heartbeat = setInterval(sendHeartbeat, heartbeatMs)
            heartbeat.unref?.()
          }
          sendHeartbeat()
          finish(null, connection)
          return
        }
        const envelope = parseNodeEnvelope(value)
        if (envelope.kind !== 'command' || envelope.nodeId !== node || envelope.epoch !== ready.epoch) {
          throw new Error('coordinator envelope does not match this authenticated connection')
        }
        Promise.resolve(onEnvelope(envelope)).catch(onError)
      } catch (error) {
        if (!ready) finish(error)
        else { onError(error); try { socket.close(4003, 'invalid coordinator frame') } catch {} }
      }
    })
    socket.once('error', error => { if (!ready) finish(error); else onError(error) })
    socket.once('close', () => {
      if (heartbeat) clearInterval(heartbeat)
      if (!settled) finish(new Error('SAB node authentication connection closed'))
    })
  })
}
