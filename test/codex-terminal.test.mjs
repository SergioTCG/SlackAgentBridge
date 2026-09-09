import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  codexTerminalFailure,
  codexTerminalFailureDecision,
  recordCodexPromptTurnStart,
  recordCodexTransportTurnStart,
  resetCodexPollerEvidence,
} from '../daemon/codex-terminal.mjs'

const CAPACITY = '⚠️ Selected model is at capacity. Please try a different model.'
const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')

const idlePane = failure => `OpenAI Codex (v0.150.0)
${failure}

› Ask Codex to do anything

  gpt-5.6-sol xhigh · ~/Code/Barrique`

test('Codex terminal failure recognizes the exact current capacity banner', () => {
  assert.deepEqual(codexTerminalFailure(idlePane(CAPACITY)), {
    key: 'model_capacity',
    text: 'Selected model is at capacity. Please try a different model.',
  })

  assert.deepEqual(codexTerminalFailure(idlePane(
    '⚠️ Selected model is at capacity. Please try a different\n  model.')),
  {
    key: 'model_capacity',
    text: 'Selected model is at capacity. Please try a different model.',
  })
})

test('Codex terminal failure ignores stale or conversational capacity text', () => {
  assert.equal(codexTerminalFailure(`${CAPACITY}\n${'old output\n'.repeat(20)}${idlePane('Ready.')}`), null)
  assert.equal(codexTerminalFailure(idlePane(
    'The terminal previously said "Selected model is at capacity. Please try a different model.", but the retry worked.')),
  null)
})

test('Codex terminal failure requires a stable idle observation', () => {
  const first = codexTerminalFailureDecision({ pane: idlePane(CAPACITY), ready: true })
  assert.deepEqual(first, {
    action: 'wait', key: 'model_capacity', confirmations: 1, failure: null,
  })

  assert.deepEqual(codexTerminalFailureDecision({
    pane: idlePane(CAPACITY), ready: true,
    previousKey: first.key, confirmations: first.confirmations,
  }), {
    action: 'failure', key: 'model_capacity', confirmations: 2,
    failure: {
      key: 'model_capacity',
      text: 'Selected model is at capacity. Please try a different model.',
    },
  })

  assert.deepEqual(codexTerminalFailureDecision({
    pane: idlePane(CAPACITY), ready: false,
    previousKey: 'model_capacity', confirmations: 1,
  }), {
    action: 'none', key: null, confirmations: 0, failure: null,
  })
})

test('Codex follow-up generations cannot inherit failure or idle evidence', () => {
  const poller = {
    failureKey: 'model_capacity', failureConfirmations: 1,
    idleObservation: { pane: 'old idle surface', confirmations: 1 },
    last: 'Codex is working',
  }

  resetCodexPollerEvidence(poller)

  assert.deepEqual(poller, {
    failureKey: null, failureConfirmations: 0, idleObservation: null,
    last: 'Codex is working',
  })
  assert.equal(codexTerminalFailureDecision({
    pane: idlePane(CAPACITY), ready: true,
    previousKey: poller.failureKey, confirmations: poller.failureConfirmations,
  }).action, 'wait')
})

test('each native Codex prompt gets an exact start without losing its transport boundary', () => {
  const session = {}
  assert.equal(recordCodexTransportTurnStart(session, 100), true)
  assert.equal(session.codexTurnStartedAt, 100)

  assert.equal(recordCodexPromptTurnStart(session, { startedAt: 110, turnId: 'turn-1' }), true)
  assert.equal(session.codexTurnStartedAt, 100)
  assert.equal(session.codexTurnId, 'turn-1')

  assert.equal(recordCodexPromptTurnStart(session, { startedAt: 120, turnId: 'turn-1' }), false)
  assert.equal(session.codexTurnStartedAt, 100)

  assert.equal(recordCodexPromptTurnStart(session, { startedAt: 200, turnId: 'turn-2' }), true)
  assert.equal(session.codexTurnStartedAt, 200)
  assert.equal(session.codexTurnId, 'turn-2')

  assert.equal(recordCodexPromptTurnStart(session, { startedAt: 150, turnId: 'turn-1' }), false)
  assert.equal(session.codexTurnStartedAt, 200)
  assert.equal(session.codexTurnId, 'turn-2')

  const awaiting = {}
  recordCodexTransportTurnStart(awaiting, 300)
  assert.equal(recordCodexPromptTurnStart(awaiting, { startedAt: 250, turnId: 'stale-turn' }), false)
  assert.equal(awaiting.codexTurnStartedAt, 300)
  assert.equal(awaiting.codexTurnAwaitingPromptHook, true)
  assert.equal(recordCodexPromptTurnStart(awaiting, { startedAt: 310, turnId: 'current-turn' }), true)
  assert.equal(awaiting.codexTurnStartedAt, 300)
  assert.equal(awaiting.codexTurnId, 'current-turn')
})

test('Codex live and restart paths finalize capacity failures visibly', () => {
  assert.match(daemon, /codexTerminalFailureDecision\([\s\S]*targetStartupState\('codex', pane\) === 'ready'/)
  assert.match(daemon, /Codex terminal failure finalize \(Stop hook missing\)[\s\S]*finalizeCodexTerminalFailure/)
  assert.match(daemon, /finalizeCodexTerminalFailure[\s\S]*clearStatus\(session\)[\s\S]*Codex turn failed/)
  assert.match(daemon, /recovered Codex terminal failure/)
  const failure = daemon.indexOf('const failureDecision = codexTerminalFailureDecision(')
  const idle = daemon.indexOf('const idleDecision = observeIdleCodexTurn(')
  assert.ok(failure > 0 && idle > failure, 'capacity failures must win before idle worker recovery')
})
