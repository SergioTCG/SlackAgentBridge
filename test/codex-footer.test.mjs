import test from 'node:test'
import assert from 'node:assert/strict'
import { codexFooterSettings } from '../daemon/codex-footer.mjs'

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
