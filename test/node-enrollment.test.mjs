import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createNodeInvitationStore } from '../daemon/node-enrollment.mjs'

const OPERATOR = 'U000RADE'
const FINGERPRINT = `sha256:${'a'.repeat(43)}`

function fixture() {
  const state = {}
  let current = Date.parse('2026-08-28T12:00:00.000Z')
  let saves = 0
  const tokens = ['first-secret-token', 'second-secret-token']
  const ids = ['node_rade', 'node_spare']
  const store = createNodeInvitationStore({
    state,
    now: () => current,
    persist: () => { saves++ },
    token: () => tokens.shift(),
    nodeId: () => ids.shift(),
  })
  return { state, store, saves: () => saves, advance: ms => { current += ms } }
}

test('invitation persists only a token hash and immutable onboarding intent', () => {
  const { state, store, saves } = fixture()
  const invitation = store.issue({ operatorId: OPERATOR, name: 'Rade MacBook', ttlMs: 60_000 })
  assert.equal(invitation.token, 'first-secret-token')
  assert.equal(invitation.nodeId, 'node_rade')
  assert.equal(JSON.stringify(state).includes(invitation.token), false)
  const hash = createHash('sha256').update(invitation.token).digest('hex')
  assert.deepEqual(state.nodeInvitations[hash], {
    nodeId: 'node_rade', operatorId: OPERATOR, name: 'Rade MacBook',
    issuedAt: '2026-08-28T12:00:00.000Z', expiresAt: '2026-08-28T12:01:00.000Z',
    status: 'issued', keyFingerprint: null, claimedAt: null, completedAt: null,
  })
  assert.equal(saves(), 1)
})

test('claim is replay-safe only for the same node key and completes idempotently', () => {
  const { state, store, saves } = fixture()
  const { token } = store.issue({ operatorId: OPERATOR, name: 'Rade MacBook' })
  const first = store.claim(token, FINGERPRINT)
  assert.equal(first.status, 'claimed')
  assert.equal(store.claim(token, FINGERPRINT).nodeId, first.nodeId)
  assert.throws(() => store.claim(token, `sha256:${'b'.repeat(43)}`), /different node key/)
  const complete = store.complete(token, FINGERPRINT)
  assert.equal(complete.status, 'completed')
  assert.equal(store.complete(token, FINGERPRINT).status, 'completed')
  assert.equal(store.claim(token, FINGERPRINT).status, 'completed')
  assert.equal(Object.values(state.nodeInvitations).length, 1)
  assert.equal(saves(), 3) // issue, first claim, first completion
})

test('expired, unknown, malformed, and revoked invitations fail closed', () => {
  const { store, advance } = fixture()
  const first = store.issue({ operatorId: OPERATOR, name: 'Rade MacBook', ttlMs: 10_000 })
  advance(10_001)
  assert.throws(() => store.claim(first.token, FINGERPRINT), /expired/)
  assert.throws(() => store.claim('not-a-token', FINGERPRINT), /invalid or expired/)
  const second = store.issue({ operatorId: OPERATOR, name: 'Spare' })
  store.revoke(second.nodeId)
  assert.throws(() => store.claim(second.token, FINGERPRINT), /invalid or expired/)
})

test('pending invitation names may not ambiguously shadow each other', () => {
  const { store } = fixture()
  store.issue({ operatorId: OPERATOR, name: 'Mobile' })
  assert.throws(() => store.issue({ operatorId: OPERATOR, name: 'mobile' }), /already pending/)
})
