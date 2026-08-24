import test from 'node:test'
import assert from 'node:assert/strict'

import { inviteAndWhitelistCollaborator, inviteAndResolveCollaborator } from '../daemon/collaborators.mjs'

test('collaborator setup invites before resolving and whitelisting', async () => {
  const order = []
  const state = { whitelist: {} }
  const result = await inviteAndWhitelistCollaborator({
    state, channel: 'C1', userId: 'U098WAUUX5M',
    invite: async () => { order.push('invite') },
    resolveUserName: async () => { order.push('resolve'); return 'Rade' },
    persist: () => order.push('persist'),
  })
  assert.deepEqual(order, ['invite', 'resolve', 'persist'])
  assert.deepEqual(state.whitelist.C1, { U098WAUUX5M: 'Rade' })
  assert.deepEqual(result, { userId: 'U098WAUUX5M', name: 'Rade', invitation: 'invited' })
})

test('already_in_channel is an idempotent invitation success', async () => {
  const result = await inviteAndResolveCollaborator({
    channel: 'C1', userId: 'U098WAUUX5M',
    invite: async () => { throw { data: { error: 'already_in_channel' } } },
    resolveUserName: async () => 'Rade',
  })
  assert.equal(result.invitation, 'already_member')
  assert.equal(result.name, 'Rade')
})

test('invitation failure leaves the existing whitelist unchanged', async () => {
  const state = { whitelist: { C1: { UEXISTING1: 'Existing' } } }
  await assert.rejects(inviteAndWhitelistCollaborator({
    state, channel: 'C1', userId: 'U098WAUUX5M',
    invite: async () => { throw { data: { error: 'missing_scope' } } },
    resolveUserName: async () => assert.fail('name lookup must follow invitation'),
    persist: () => assert.fail('failure must not persist a whitelist change'),
  }), error => error.code === 'missing_scope' && /invite/i.test(error.message))
  assert.deepEqual(state.whitelist.C1, { UEXISTING1: 'Existing' })
})
