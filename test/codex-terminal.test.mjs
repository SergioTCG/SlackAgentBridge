import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  codexTerminalFailure,
  codexTerminalFailureDecision,
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

test('Codex live and restart paths finalize capacity failures visibly', () => {
  assert.match(daemon, /codexTerminalFailureDecision\([\s\S]*targetStartupState\('codex', pane\) === 'ready'/)
  assert.match(daemon, /Codex terminal failure finalize \(Stop hook missing\)[\s\S]*finalizeCodexTerminalFailure/)
  assert.match(daemon, /finalizeCodexTerminalFailure[\s\S]*clearStatus\(session\)[\s\S]*Codex turn failed/)
  assert.match(daemon, /recovered Codex terminal failure/)
})
