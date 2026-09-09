import test from 'node:test'
import assert from 'node:assert/strict'

import {
  activatePendingTeamProviderTurn, activateTeamProviderTurn, beginTeamProviderPollerObservation,
  clearDeferredTeamProviderFinal, deferPendingTeamProviderFinal,
  deferredTeamProviderFinal, discardPendingTeamProviderTurn, hasTeamProviderTurnTracking,
  pendingTeamProviderTurn, providerPromptTurnMarker, providerTurnForCompletion,
  providerPromptAcknowledgesTask, providerTurnForTaskLifecycle,
  refreshTeamProviderPollerTurn, retireTeamProviderTurn, stageTeamProviderTurn,
  teamProviderPollerObservationCurrent,
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
  assert.equal(providerTurnForCompletion(session, {
    providerTurnId: 'unknown-newer-turn',
  }), null)
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

test('prompt acknowledgement can recover the exact pending turn after an uncertain provider write', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 3 }, { now: 3000 })

  const initial = providerPromptTurnMarker(
    '<sab-team-task id="task_one" team="team_one" generation="3" source="coordinator">',
  )
  assert.deepEqual(initial, { taskId: 'task_one', providerWorkGeneration: 3 })
  assert.deepEqual(pendingTeamProviderTurn(session, initial), {
    taskId: 'task_one', providerWorkGeneration: 3,
  })

  const followUp = providerPromptTurnMarker(
    '<sab-team-message task="task_one" generation="3" source="coordinator">',
  )
  assert.deepEqual(followUp, { taskId: 'task_one', providerWorkGeneration: 3 })
  assert.equal(pendingTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), null)

  activateTeamProviderTurn(session, {
    turn: pendingTeamProviderTurn(session, followUp),
    providerTurnId: 'turn-three',
    startedAt: 3100,
  })
  assert.equal(session.teamProviderTurnPending, undefined)
  assert.deepEqual(providerTurnForCompletion(session, { providerTurnId: 'turn-three' }), {
    taskId: 'task_one', providerWorkGeneration: 3,
  })
})

test('authenticated worker proof promotes an exact pending turn after restart', () => {
  const staged = {}
  stageTeamProviderTurn(staged, {
    taskId: 'task_one', providerWorkGeneration: 1, inheritProviderTurnId: true,
  }, { now: 3000 })
  const session = JSON.parse(JSON.stringify(staged))

  assert.deepEqual(activatePendingTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }, { startedAt: 3100 }), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })
  assert.equal(session.teamProviderTurnPending, undefined)
  assert.equal(session.teamProviderTurn.inheritProviderTurnId, true)
  assert.deepEqual(providerTurnForCompletion(session), {
    taskId: 'task_one', providerWorkGeneration: 1,
  })
  assert.equal(activatePendingTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }), null)
})

test('staged provider input retains its pre-submit event boundary when promoted', () => {
  const session = {}
  stageTeamProviderTurn(session, {
    taskId: 'task_fast', providerWorkGeneration: 1,
  }, { now: 1000 })

  // Promotion happens only after the provider transport returns. A Stop event
  // can already have been observed by then, so the durable staged boundary—not
  // promotion wall-clock time—must order that final against this work.
  activatePendingTeamProviderTurn(session, {
    taskId: 'task_fast', providerWorkGeneration: 1,
  })

  assert.equal(session.teamProviderTurn.startedAt, 1000)
  assert.deepEqual(providerTurnForCompletion(session, {
    observedAt: 1001,
  }), {
    taskId: 'task_fast', providerWorkGeneration: 1,
  })
})

test('a delayed final retains its historical task identity during a newer task', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_old', providerWorkGeneration: 1 })
  activateTeamProviderTurn(session, { providerTurnId: 'turn-old', startedAt: 1000 })
  stageTeamProviderTurn(session, { taskId: 'task_new', providerWorkGeneration: 1 })
  activateTeamProviderTurn(session, { providerTurnId: 'turn-new', startedAt: 2000 })

  assert.deepEqual(providerTurnForTaskLifecycle(session, {
    taskId: 'task_new', providerWorkGeneration: 1,
    providerTurnId: 'turn-old', observedAt: 1500,
  }), {
    taskId: 'task_old', providerWorkGeneration: 1,
  })
})

test('a delayed initial acknowledgement cannot promote a newer pending generation', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 1 }, { now: 1000 })
  const initial = providerPromptTurnMarker(
    '<sab-team-task id="task_one" team="team_one" generation="1" source="coordinator">',
  )
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 2 }, { now: 2000 })

  assert.equal(pendingTeamProviderTurn(session, initial), null)
  assert.deepEqual(pendingTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), { taskId: 'task_one', providerWorkGeneration: 2 })
  assert.equal(providerPromptAcknowledgesTask(session, {
    taskId: 'task_one', currentGeneration: 2, promptTurn: initial,
    submittedTurn: { taskId: 'task_one', providerWorkGeneration: 2 }, injected: true,
  }), false)
})

test('steered native turns resolve the newest generation without delayed-hook rollback', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 1 })
  activateTeamProviderTurn(session, { startedAt: 1000 })
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 2 }, { now: 2000 })
  activateTeamProviderTurn(session, {
    turn: {
      taskId: 'task_one', providerWorkGeneration: 2,
      inheritProviderTurnId: true,
    },
    startedAt: 2000,
  })

  // The delayed acknowledgement for generation 1 is retained as history but
  // must not replace generation 2 as the current accepted work. Because this
  // follow-up steered the active native turn, that late acknowledgement also
  // supplies the native id which was not yet known at delivery time.
  activateTeamProviderTurn(session, {
    turn: { taskId: 'task_one', providerWorkGeneration: 1 },
    providerTurnId: 'shared-turn', startedAt: 1500,
  })
  assert.equal(session.teamProviderTurn.providerWorkGeneration, 2)
  assert.equal(session.teamProviderTurn.providerTurnId, 'shared-turn')
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'shared-turn', observedAt: 1750,
  }), { taskId: 'task_one', providerWorkGeneration: 1 })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'shared-turn', observedAt: 2500,
  }), { taskId: 'task_one', providerWorkGeneration: 2 })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'shared-turn',
  }), { taskId: 'task_one', providerWorkGeneration: 2 })
})

test('bounded history preserves distinct generations that share one native turn id', () => {
  const session = {}
  for (let generation = 1; generation <= 3; generation++) {
    stageTeamProviderTurn(session, {
      taskId: 'task_one', providerWorkGeneration: generation,
      inheritProviderTurnId: generation > 1,
    }, { now: generation * 1000 })
    activatePendingTeamProviderTurn(session, {
      taskId: 'task_one', providerWorkGeneration: generation,
    }, { providerTurnId: 'shared-turn' })
  }

  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'shared-turn', observedAt: 1500,
  }), { taskId: 'task_one', providerWorkGeneration: 1 })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'shared-turn', observedAt: 2500,
  }), { taskId: 'task_one', providerWorkGeneration: 2 })
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'shared-turn', observedAt: 3500,
  }), { taskId: 'task_one', providerWorkGeneration: 3 })
})

test('a provider final crossing an unresolved submission boundary is retained durably', () => {
  const session = {}
  stageTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }, { now: 2000 })

  assert.equal(deferPendingTeamProviderFinal(session, {
    provider: 'codex', providerTurnId: 'old-turn', observedAt: 1500,
    lastAssistantMessage: 'Old final.',
  }), null)
  assert.deepEqual(deferPendingTeamProviderFinal(session, {
    provider: 'codex', providerTurnId: 'turn-two', observedAt: 2100,
    lastAssistantMessage: 'Fast final.',
  }), { taskId: 'task_one', providerWorkGeneration: 2 })

  const recovered = JSON.parse(JSON.stringify(session))
  assert.deepEqual(deferredTeamProviderFinal(recovered, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), {
    taskId: 'task_one',
    providerWorkGeneration: 2,
    provider: 'codex',
    providerTurnId: 'turn-two',
    observedAt: 2100,
    lastAssistantMessage: 'Fast final.',
    usage: null,
    contextUsage: null,
  })
  activatePendingTeamProviderTurn(recovered, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }, { providerTurnId: 'turn-two' })
  assert.equal(pendingTeamProviderTurn(recovered), null)
  assert.equal(deferredTeamProviderFinal(recovered)?.lastAssistantMessage, 'Fast final.')
  assert.equal(clearDeferredTeamProviderFinal(recovered, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }), false)
  assert.equal(clearDeferredTeamProviderFinal(recovered, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }), true)
  assert.equal(deferredTeamProviderFinal(recovered), null)
})

test('a previous accepted turn keeps its final when a follow-up is only staged', () => {
  const session = {}
  stageTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }, { now: 1000 })
  activatePendingTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 1,
  }, { providerTurnId: 'turn-one' })
  stageTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 2,
  }, { now: 2000 })

  // Staging precedes tmux Enter. A Stop from the accepted first turn can land
  // after that intent timestamp and must still resolve to generation one.
  assert.equal(deferPendingTeamProviderFinal(session, {
    provider: 'codex', providerTurnId: 'turn-one', observedAt: 2100,
    lastAssistantMessage: 'Generation one final.',
  }), null)
  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'turn-one', observedAt: 2100,
  }), { taskId: 'task_one', providerWorkGeneration: 1 })
  assert.equal(deferredTeamProviderFinal(session), null)
})

test('an inherited native turn id remains provisional for a distinct follow-up turn', () => {
  const session = {}
  stageTeamProviderTurn(session, { taskId: 'task_one', providerWorkGeneration: 1 })
  activateTeamProviderTurn(session, { providerTurnId: 'turn-one', startedAt: 1000 })
  stageTeamProviderTurn(session, {
    taskId: 'task_one', providerWorkGeneration: 2, inheritProviderTurnId: true,
  }, { now: 2000 })
  activateTeamProviderTurn(session, {
    turn: session.teamProviderTurnPending,
    providerTurnId: 'turn-one',
    startedAt: 2000,
  })

  assert.deepEqual(providerTurnForCompletion(session, {
    providerTurnId: 'turn-two', observedAt: 2500,
  }), { taskId: 'task_one', providerWorkGeneration: 2 })
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

test('an in-flight poller observation cannot be retagged to a newer task generation', () => {
  const poller = {
    stopped: false,
    teamTaskTurn: Object.freeze({ taskId: 'task_one', providerWorkGeneration: 1 }),
    teamTaskRevision: 0,
  }
  const observation = beginTeamProviderPollerObservation(poller)

  refreshTeamProviderPollerTurn(poller, {
    taskId: 'task_one', providerWorkGeneration: 2,
  })

  assert.deepEqual(observation.teamTaskTurn, {
    taskId: 'task_one', providerWorkGeneration: 1,
  })
  assert.deepEqual(poller.teamTaskTurn, {
    taskId: 'task_one', providerWorkGeneration: 2,
  })
  assert.equal(teamProviderPollerObservationCurrent(poller, observation), false)
  assert.equal(teamProviderPollerObservationCurrent(poller,
    beginTeamProviderPollerObservation(poller)), true)
})
