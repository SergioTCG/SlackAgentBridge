import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  createNodeChallengeStore,
  ensureCoordinatorId,
  signNodeChallenge,
} from '../daemon/node-auth.mjs'

test('coordinator identity is generated once and persisted without secrets', () => {
  const state = {}
  let saves = 0
  const first = ensureCoordinatorId(state, { randomId: () => 'coordinator_sergej', persist: () => { saves++ } })
  const second = ensureCoordinatorId(state, { randomId: () => 'coordinator_other', persist: () => { saves++ } })
  assert.equal(first, 'coordinator_sergej')
  assert.equal(second, first)
  assert.deepEqual(state, { coordinatorId: 'coordinator_sergej' })
  assert.equal(saves, 1)
})

test('node proves its pinned Ed25519 key against a one-use bounded challenge', () => {
  const keys = generateKeyPairSync('ed25519')
  let current = Date.parse('2026-08-28T12:00:00.000Z')
  const challenges = createNodeChallengeStore({
    coordinatorId: 'coordinator_sergej',
    now: () => current,
    nonce: () => Buffer.alloc(32, 7),
    challengeId: () => 'challenge_1',
  })
  const challenge = challenges.issue({ nodeId: 'node_rade', epoch: 4 })
  const signature = signNodeChallenge(challenge, keys.privateKey)
  assert.equal(challenges.verify({ challengeId: challenge.challengeId, nodeId: 'node_rade', signature, publicKey: keys.publicKey }).epoch, 4)
  assert.throws(() => challenges.verify({ challengeId: challenge.challengeId, nodeId: 'node_rade', signature, publicKey: keys.publicKey }), /invalid or already used/)

  const tampered = challenges.issue({ nodeId: 'node_rade', epoch: 5 })
  const tamperedSignature = signNodeChallenge({ ...tampered, epoch: 6 }, keys.privateKey)
  assert.throws(() => challenges.verify({ challengeId: tampered.challengeId, nodeId: 'node_rade', signature: tamperedSignature, publicKey: keys.publicKey }), /signature is invalid/)
})

test('expired challenges and cross-node signatures fail closed', () => {
  const keys = generateKeyPairSync('ed25519')
  let current = Date.parse('2026-08-28T12:00:00.000Z')
  let counter = 0
  const challenges = createNodeChallengeStore({
    coordinatorId: 'coordinator_sergej', now: () => current,
    challengeId: () => `challenge_${++counter}`,
  })
  const crossNode = challenges.issue({ nodeId: 'node_rade', epoch: 1 })
  const signature = signNodeChallenge(crossNode, keys.privateKey)
  assert.throws(() => challenges.verify({ challengeId: crossNode.challengeId, nodeId: 'node_spare', signature, publicKey: keys.publicKey }), /does not belong/)

  const expired = challenges.issue({ nodeId: 'node_rade', epoch: 2 })
  current += 31_000
  assert.throws(() => challenges.verify({ challengeId: expired.challengeId, nodeId: 'node_rade', signature: signNodeChallenge(expired, keys.privateKey), publicKey: keys.publicKey }), /expired/)
})
