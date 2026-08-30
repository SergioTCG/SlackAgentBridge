import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { WebSocket } from 'ws'
import { createNodeInvitationStore } from '../daemon/node-enrollment.mjs'
import { createNodeRegistry } from '../daemon/node-registry.mjs'
import { createNodeEnvelope } from '../daemon/node-protocol.mjs'
import {
  connectAuthenticatedNode,
  createCoordinatorNodeTransport,
  enrollNodeWithCoordinator,
  listenForNodeConnections,
} from '../daemon/node-transport.mjs'

const ADMIN = 'U000ADMIN'
const OPERATOR = 'U000RADE'

async function fixture(t) {
  const state = {}
  const persist = () => {}
  const registry = createNodeRegistry({ state, adminUserId: ADMIN, persist, localName: 'Coordinator' })
  let nodeCounter = 0
  const invitations = createNodeInvitationStore({
    state, persist,
    nodeId: () => `node_rade${++nodeCounter}`,
  })
  const received = []
  let notify = null
  const transport = createCoordinatorNodeTransport({
    coordinatorId: 'coordinator_sergej', registry, invitations, persist,
    onEnvelope: async envelope => {
      received.push(envelope)
      notify?.(); notify = null
    },
  })
  const listener = await listenForNodeConnections({ transport, host: '127.0.0.1', port: 0 })
  t.after(async () => listener.close())
  return {
    state, registry, invitations, transport, listener, received,
    nextEnvelope: () => new Promise(resolve => { notify = resolve }),
  }
}

test('one-use enrollment pins the node key without giving the node Slack credentials', async t => {
  const f = await fixture(t)
  const invitation = f.invitations.issue({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const keys = generateKeyPairSync('ed25519')
  const result = await enrollNodeWithCoordinator({
    url: f.listener.url,
    token: invitation.token,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  })
  assert.equal(result.nodeId, invitation.nodeId)
  assert.equal(result.coordinatorId, 'coordinator_sergej')
  assert.match(f.registry.publicKeyFor(result.nodeId), /BEGIN PUBLIC KEY/)
  assert.equal(JSON.stringify(result).includes('token'), false)
  assert.equal(JSON.stringify(f.state).includes(invitation.token), false)

  await assert.rejects(enrollNodeWithCoordinator({
    url: f.listener.url,
    token: invitation.token,
    publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }), /enrollment_failed/)
})

test('authenticated connection accepts exact node envelopes and fences an older epoch', async t => {
  const f = await fixture(t)
  const invitation = f.invitations.issue({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await enrollNodeWithCoordinator({ url: f.listener.url, token: invitation.token, publicKey })

  const first = await connectAuthenticatedNode({
    url: f.listener.url, nodeId: invitation.nodeId, coordinatorId: 'coordinator_sergej', privateKey: keys.privateKey,
    heartbeatMs: 0,
  })
  assert.equal(first.epoch, 1)
  assert.deepEqual(f.transport.connections().map(item => [item.nodeId, item.epoch]), [[invitation.nodeId, 1]])

  const waiting = f.nextEnvelope()
  first.send(createNodeEnvelope({
    kind: 'event', id: 'evt_1', nodeId: invitation.nodeId, epoch: first.epoch,
    sentAt: new Date().toISOString(),
    payload: { type: 'session.started', target: { sessionId: 'S1', tmux: 'sab-one', provider: 'codex', pid: 123 }, body: {} },
  }))
  await waiting
  assert.equal(f.received[0].id, 'evt_1')

  const oldClosed = new Promise(resolve => first.socket.once('close', resolve))
  const second = await connectAuthenticatedNode({
    url: f.listener.url, nodeId: invitation.nodeId, coordinatorId: 'coordinator_sergej', privateKey: keys.privateKey,
    heartbeatMs: 0,
  })
  assert.equal(second.epoch, 2)
  await oldClosed
  assert.deepEqual(f.transport.connections().map(item => [item.nodeId, item.epoch]), [[invitation.nodeId, 2]])
  second.close()
})

test('wrong keys, coordinator identity mismatch, and non-loopback plaintext fail closed', async t => {
  const f = await fixture(t)
  const invitation = f.invitations.issue({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const keys = generateKeyPairSync('ed25519')
  await enrollNodeWithCoordinator({
    url: f.listener.url, token: invitation.token,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  })
  await assert.rejects(connectAuthenticatedNode({
    url: f.listener.url, nodeId: invitation.nodeId, coordinatorId: 'coordinator_other', privateKey: keys.privateKey,
    heartbeatMs: 0,
  }), /coordinator identity mismatch/)
  await assert.rejects(connectAuthenticatedNode({
    url: f.listener.url, nodeId: invitation.nodeId, coordinatorId: 'coordinator_sergej',
    privateKey: generateKeyPairSync('ed25519').privateKey, heartbeatMs: 0,
  }), /authentication_failed/)
  assert.throws(() => listenForNodeConnections({ transport: f.transport, host: '0.0.0.0', port: 0 }), /TLS is required/)
})

test('idle unauthenticated sockets are closed by the bounded handshake timer', async t => {
  const state = {}
  const registry = createNodeRegistry({ state, adminUserId: ADMIN })
  const invitations = createNodeInvitationStore({ state })
  const transport = createCoordinatorNodeTransport({
    coordinatorId: 'coordinator_sergej', registry, invitations, handshakeTimeoutMs: 20,
  })
  const listener = await listenForNodeConnections({ transport, host: '127.0.0.1', port: 0 })
  t.after(() => listener.close())
  const socket = new WebSocket(listener.url)
  const error = new Promise(resolve => socket.on('message', data => {
    const value = JSON.parse(String(data))
    if (value.kind === 'error') resolve(value.code)
  }))
  assert.equal(await error, 'handshake_timeout')
  await new Promise(resolve => socket.once('close', resolve))
  assert.deepEqual(transport.connections(), [])
})
