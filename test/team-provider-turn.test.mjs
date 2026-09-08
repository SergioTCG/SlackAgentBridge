import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activateTeamProviderTurn, discardPendingTeamProviderTurn, hasTeamProviderTurnTracking,
  providerTurnForCompletion, retireTeamProviderTurn, stageTeamProviderTurn,
} from '../daemon/team-provider-turn.mjs'

test('provider finals resolve the immutable task generation of their native turn', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 1 })
  activateTeamProviderTurn(session, { providerTurnId: 'turn-one', startedAt: 1000 })

  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 2 })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'turn-one', observedAt: 1500,
  }), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })

  activateTeamProviderTurn(session, { providerTurnId: 'turn-two', startedAt: 2000 })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'turn-one', observedAt: 1500,
  }), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'turn-two', observedAt: 2500,
  }), {
    taskId: 'task_one', providerWorkGeneration: 2,
  })
  assert.deepEqual(providerTurnForCompletion(session, { observedAt: 1500 }), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })
})

test('hook acknowledgement promotes a staged generation exactly once and survives JSON persistence', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 4 })
  activateTeamProviderTurn(session, { providerTurnId: 'turn-four', startedAt: 4000 })
  activateTeamProviderTurn(session, {
    turn: { taskId: 'task_one', providerWorkGeneration: 4 },
    providerTurnId: 'turn-four', startedAt: 4100,
  })

  const recovered = JSON.parse(JSON.stringify(session))
  assert.equal(hasTeamProviderTurnTracking(recovered), true)
  assert.deepEqual(providerTurnForCompletion(recovered, { providerTurnId: 'turn-four' }), {
    taskId: 'task_one', providerWorkGeneration: 4,
  })
  assert.equal(recovered.teamProviderTurnHistory?.length || 0, 0)
})

test('known-undelivered staging is discarded and ordinary turns retire task ownership', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 1 })
  activateTeamProviderTurn(session, { providerTurnId: 'turn-one', startedAt: 1000 })
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 2 })
  assert.equal(discardPendingTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), true)
  assert.deepEqual(providerTurnForCompletion(session), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })

  retireTeamProviderTurn(session)
  assert.equal(providerTurnForCompletion(session), null)
  assert.deepEqual(providerTurnForCompletion(session, { providerTurnId: 'turn-one' }), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })
})
