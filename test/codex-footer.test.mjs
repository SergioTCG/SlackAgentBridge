import test from 'node:test'
import assert from 'node:assert/strict'
import { codexFooterSettings, shouldPromoteCodexFooter } from '../daemon/codex-footer.mjs'

test('Codex footer reports the live model and effort', () => {
  assert.deepEqual(codexFooterSettings(`old output about gpt-5.6-luna medium

› Ask Codex to do anything
  gpt-5.6-sol xhigh · ~/Code/Barrique`), {
    model: 'gpt-5.6-sol', effort: 'xhigh',
  })
})

test('Codex footer ignores model text outside the bounded footer area', () => {
  assert.equal(codexFooterSettings(`gpt-5.6-luna medium · conversational text
${'ordinary output\n'.repeat(13)}
› Ask Codex to do anything`), null)
})

test('only an idle native settings change becomes durable resume intent', () => {
  assert.equal(shouldPromoteCodexFooter(), true)
  assert.equal(shouldPromoteCodexFooter({ turnStartedAt: Date.now() }), false)
  assert.equal(shouldPromoteCodexFooter({ pollerActive: true }), false)
  assert.equal(shouldPromoteCodexFooter({ restarting: true }), false)
  assert.equal(shouldPromoteCodexFooter({ updating: true }), false)
})
