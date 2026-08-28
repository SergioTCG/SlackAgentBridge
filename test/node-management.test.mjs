import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createNodeInvitationStore } from '../daemon/node-enrollment.mjs'
import { createNodeManagement } from '../daemon/node-management.mjs'
import { createNodeRegistry } from '../daemon/node-registry.mjs'

const ADMIN = 'U000ADMIN'
const OPERATOR = 'U000RADE'

function fixture() {
  const state = {}
  let disconnected = null
  const invitations = createNodeInvitationStore({ state, nodeId: () => 'node_rade' })
  const registry = createNodeRegistry({ state, adminUserId: ADMIN })
  const transport = {
    connections: () => [],
    disconnect: nodeId => {
      if (state.nodes?.[nodeId]) assert.ok(state.nodes[nodeId].revokedAt, 'registry must be persisted before disconnect')
      disconnected = nodeId
      return true
    },
  }
  const management = createNodeManagement({
    coordinatorId: 'coordinator_test', adminUserId: ADMIN, invitations, registry, transport,
    resolveOperator: async userId => {
      if (userId !== OPERATOR) throw Object.assign(new Error('user_not_found'), { code: 'user_not_found' })
      return { id: userId }
    },
    listenerStatus: () => ({ enabled: true, publicUrl: 'wss://coordinator.example.test:8878/nodes' }),
  })
  return { state, invitations, registry, management, disconnected: () => disconnected }
}

test('node management verifies the Slack operator before minting an invitation', async () => {
  const f = fixture()
  await assert.rejects(f.management.issueInvitation({
    operatorId: 'U000OTHER', name: 'Other Mac',
  }), /not an available member/)
  assert.equal(f.state.nodeInvitations, undefined)
  const invitation = await f.management.issueInvitation({
    operatorId: OPERATOR, name: 'Rade MacBook', ttlSeconds: 30,
  })
  assert.equal(invitation.operatorId, OPERATOR)
  assert.equal(JSON.stringify(f.state).includes(invitation.token), false)
})

test('node management revocation handles pending and enrolled nodes exactly and idempotently', async () => {
  const f = fixture()
  const invitation = await f.management.issueInvitation({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const pending = await f.management.revoke(invitation.nodeId)
  assert.equal(pending.invitationsRevoked, 1)
  assert.equal(f.disconnected(), invitation.nodeId)
  await assert.rejects(f.management.revoke(invitation.nodeId), /not found/)

  const second = await f.management.issueInvitation({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
  f.registry.registerEnrolledNode({ nodeId: second.nodeId, name: second.name, operatorId: second.operatorId, publicKey })
  f.invitations.complete(second.token, f.state.nodes[second.nodeId].keyFingerprint)
  const enrolled = await f.management.revoke(second.nodeId)
  assert.equal(enrolled.revoked, true)
  assert.ok(f.state.nodes[second.nodeId].revokedAt)
  const replay = await f.management.revoke(second.nodeId)
  assert.equal(replay.revoked, true)
})

test('node status never returns pinned public keys or invitation hashes', async () => {
  const f = fixture()
  const invitation = await f.management.issueInvitation({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const status = f.management.status()
  assert.equal(status.coordinatorId, 'coordinator_test')
  assert.equal(status.invitations[0].nodeId, invitation.nodeId)
  assert.equal(JSON.stringify(status).includes(invitation.token), false)
  assert.equal(JSON.stringify(status).includes('publicKey'), false)
})
