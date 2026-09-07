import test from 'node:test'
import assert from 'node:assert/strict'
import { codexFooterSettings, shouldPromoteCodexFooter } from '../daemon/codex-footer.mjs'

test('Codex footer reports the live model and effort', () => {
  assert.deepEqual(codexFooterSettings(`old output about gpt-5.6-luna medium

› Ask Codex to do anything
  gpt-5.6-sol xhigh · ~/Code/Barrique`), {
    model: 'gpt-5.6-sol', effort: 'xhigh', explicitChange: false,
  })
})

test('only an explicit native model confirmation can change durable intent', () => {
  assert.deepEqual(codexFooterSettings(`• Model changed to gpt-5.6-sol xhigh

› Ask Codex to do anything
  gpt-5.6-sol xhigh · ~/Code/Barrique`), {
    model: 'gpt-5.6-sol', effort: 'xhigh', explicitChange: true,
  })
  assert.deepEqual(codexFooterSettings(`⚠️ Selected model is at capacity. Please try a different model.

› Ask Codex to do anything
  gpt-5.6-luna medium · ~/Code/Barrique`), {
    model: 'gpt-5.6-luna', effort: 'medium', explicitChange: false,
  })
  assert.deepEqual(codexFooterSettings(`⚠️ Selected model is at capacity. Please try a different model.
• Model changed to gpt-5.6-sol xhigh

› Ask Codex to do anything
  gpt-5.6-sol xhigh · ~/Code/Barrique`), {
    model: 'gpt-5.6-sol', effort: 'xhigh', explicitChange: true,
  })
})

test('Codex footer ignores model text outside the bounded footer area', () => {
  assert.equal(codexFooterSettings(`gpt-5.6-luna medium · conversational text
${'ordinary output\n'.repeat(13)}
› Ask Codex to do anything`), null)
})

test('only an explicit native settings change becomes durable resume intent', () => {
  assert.equal(shouldPromoteCodexFooter(), false)
  assert.equal(shouldPromoteCodexFooter({ explicitChange: true }), true)
  assert.equal(shouldPromoteCodexFooter({ explicitChange: true, turnStartedAt: Date.now() }), false)
  assert.equal(shouldPromoteCodexFooter({ turnStartedAt: Date.now() }), false)
  assert.equal(shouldPromoteCodexFooter({ pollerActive: true }), false)
  assert.equal(shouldPromoteCodexFooter({ explicitChange: true, pollerActive: true }), false)
  assert.equal(shouldPromoteCodexFooter({ restarting: true }), false)
  assert.equal(shouldPromoteCodexFooter({ updating: true }), false)
})
