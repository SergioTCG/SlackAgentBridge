import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createNodeRegistry, fingerprintNodePublicKey } from '../daemon/node-registry.mjs'

const ADMIN = 'U000ADMIN'
const RADE = 'U000RADE'

function publicKey() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
}

function fixture() {
  const state = {}
  let saves = 0
  const registry = createNodeRegistry({
    state,
    adminUserId: ADMIN,
    localName: 'Sergej Mac Studio',
    now: () => Date.parse('2026-08-28T12:00:00.000Z'),
    persist: () => { saves++ },
  })
  return { state, registry, saves: () => saves }
}

test('the compatibility-local node is implicit and does not migrate state', () => {
  const { state, registry, saves } = fixture()
  assert.deepEqual(registry.listFor(ADMIN), [{
    id: 'local', name: 'Sergej Mac Studio', mode: 'local', connected: true,
    operators: [ADMIN], revokedAt: null,
  }])
  assert.deepEqual(state, {})
  assert.equal(saves(), 0)
  assert.equal(registry.canOperate(ADMIN, 'local'), true)
  assert.equal(registry.canOperate(RADE, 'local'), false)
})

test('verified enrollment is atomic and idempotent only for the pinned key', () => {
  const { state, registry, saves } = fixture()
  const key = publicKey()
  const enrolled = registry.registerEnrolledNode({ nodeId: 'node_rade', name: 'Rade MacBook', operatorId: RADE, publicKey: key })
  assert.equal(enrolled.created, true)
  assert.equal(state.nodes.node_rade.keyFingerprint, fingerprintNodePublicKey(key))
  assert.deepEqual(state.nodes.node_rade.operators, [RADE])
  assert.equal(saves(), 1)

  const replay = registry.registerEnrolledNode({ nodeId: 'node_rade', name: 'Ignored replay name', operatorId: RADE, publicKey: key })
  assert.equal(replay.created, false)
  assert.equal(replay.node.name, 'Rade MacBook')
  assert.equal(saves(), 1)
  assert.throws(() => registry.registerEnrolledNode({
    nodeId: 'node_rade', name: 'Impostor', operatorId: RADE, publicKey: publicKey(),
  }), /different public key/)
  assert.equal(saves(), 1)
})

test('node operators are scoped and defaults resolve only authorized active nodes', () => {
  const { state, registry } = fixture()
  registry.registerEnrolledNode({ nodeId: 'node_rade', name: 'Rade MacBook', operatorId: RADE, publicKey: publicKey() })
  assert.equal(registry.canOperate(RADE, 'node_rade'), true)
  assert.equal(registry.canOperate(RADE, 'local'), false)
  assert.equal(registry.canOperate(ADMIN, 'node_rade'), true)
  assert.equal(registry.resolveFor(RADE, 'Rade MacBook').id, 'node_rade')
  assert.equal(registry.setDefault(RADE, 'node_rade').id, 'node_rade')
  assert.equal(registry.defaultFor(RADE).id, 'node_rade')

  registry.revoke('node_rade')
  assert.equal(registry.canOperate(RADE, 'node_rade'), false)
  assert.equal(registry.defaultFor(RADE), null)
  assert.equal(state.nodeDefaults, undefined)
  assert.throws(() => registry.resolveFor(RADE, 'node_rade'), /not available/)
})

test('friendly names may change but ambiguous names never choose a machine', () => {
  const { registry } = fixture()
  registry.registerEnrolledNode({ nodeId: 'node_one', name: 'Mobile', operatorId: RADE, publicKey: publicKey() })
  registry.registerEnrolledNode({ nodeId: 'node_two', name: 'mobile', operatorId: RADE, publicKey: publicKey() })
  assert.throws(() => registry.resolveFor(RADE, 'MOBILE'), /ambiguous/)
  registry.rename('node_two', 'Spare')
  assert.equal(registry.resolveFor(RADE, 'mobile').id, 'node_one')
})

test('authenticated connection epochs advance durably and revoked keys disappear', () => {
  const { registry, saves } = fixture()
  const key = publicKey()
  registry.registerEnrolledNode({ nodeId: 'node_rade', name: 'Rade', operatorId: RADE, publicKey: key })
  assert.equal(registry.publicKeyFor('node_rade'), key)
  assert.equal(registry.nextConnectionEpoch('node_rade'), 1)
  assert.equal(registry.advanceConnectionEpoch('node_rade'), 1)
  assert.equal(registry.nextConnectionEpoch('node_rade'), 2)
  assert.equal(saves(), 2)
  registry.revoke('node_rade')
  assert.equal(registry.publicKeyFor('node_rade'), null)
  assert.throws(() => registry.advanceConnectionEpoch('node_rade'), /not active/)
})
