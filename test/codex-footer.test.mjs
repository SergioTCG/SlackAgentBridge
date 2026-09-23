import test from 'node:test'
import assert from 'node:assert/strict'
import { codexFooterSettings, codexSettingsMismatch, shouldPromoteCodexFooter } from '../daemon/codex-footer.mjs'

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

// Newer Codex TUIs render the footer title-cased. The requested id is the
// lowercase slug, so storing the display casing made every session look like a
// capacity fallback ("started with GPT-6-Sol although gpt-6-sol was requested").
test('a title-cased footer is stored as the lowercase model id', () => {
  assert.deepEqual(codexFooterSettings(`
  GPT-6-Sol xhigh · ~/Code/Barrique`), {
    model: 'gpt-6-sol', effort: 'xhigh', explicitChange: false,
  })
  assert.deepEqual(codexFooterSettings(`• Model changed to GPT-6-Sol XHIGH

  GPT-6-Sol xhigh · ~/Code/Barrique`), {
    model: 'gpt-6-sol', effort: 'xhigh', explicitChange: true,
  })
})

test('casing alone is never a settings mismatch', () => {
  assert.deepEqual(codexSettingsMismatch({
    requestedModel: 'gpt-6-sol', model: 'GPT-6-Sol', requestedEffort: 'xhigh', effort: 'XHIGH',
  }), { model: false, effort: false })
})

// The warning exists to catch a real fallback. That must survive the fix.
test('a genuinely different model or effort is still a mismatch', () => {
  assert.deepEqual(codexSettingsMismatch({
    requestedModel: 'gpt-6-sol', model: 'gpt-6-luna', requestedEffort: 'xhigh', effort: 'xhigh',
  }), { model: true, effort: false })
  assert.deepEqual(codexSettingsMismatch({
    requestedModel: 'gpt-6-sol', model: 'GPT-6-Sol', requestedEffort: 'xhigh', effort: 'medium',
  }), { model: false, effort: true })
})

test('missing settings are not reported as a mismatch', () => {
  assert.deepEqual(codexSettingsMismatch({ model: 'gpt-6-sol', effort: 'xhigh' }), { model: false, effort: false })
  assert.deepEqual(codexSettingsMismatch({ requestedModel: 'gpt-6-sol', requestedEffort: 'xhigh' }), { model: false, effort: false })
  assert.deepEqual(codexSettingsMismatch(), { model: false, effort: false })
})
