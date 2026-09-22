import test from 'node:test'
import assert from 'node:assert/strict'
import { unwrapPastedContent } from '../daemon/util.mjs'
import { artifactDeliveryInstruction } from '../daemon/artifacts.mjs'

const FAKE_GRANT = 'TESTGRANT0123456789abcdefGHIJKL'

// Claude Code wraps a multi-line bracketed paste in a `<pasted_content …>`
// envelope before its UserPromptSubmit hook fires. The bridge recognizes its own
// Slack injections by comparing that prompt with the text it remembered
// injecting, so the envelope must not change the compared payload. When it did,
// every Slack prompt was mirrored back into the channel as local typing —
// artifact-delivery preamble and live upload grant included.
test('a pasted_content envelope unwraps to exactly the injected text', () => {
  const injected = `Dinner will land ca 19.30, what do I prepare?${artifactDeliveryInstruction(FAKE_GRANT)}`
  const wrapped = `<pasted_content id="b45a">\n${injected}\n</pasted_content id="b45a">`
  assert.equal(unwrapPastedContent(wrapped), injected.trim())
  assert.equal(unwrapPastedContent(wrapped), unwrapPastedContent(injected))
})

test('envelope variants unwrap: no attributes, bare close tag, CRLF', () => {
  assert.equal(unwrapPastedContent('<pasted_content>\nhello\n</pasted_content>'), 'hello')
  assert.equal(unwrapPastedContent('<pasted_content id="x">\nhello\n</pasted_content>'), 'hello')
  assert.equal(unwrapPastedContent('<pasted_content id="x">\r\nhello\r\n</pasted_content id="x">'), 'hello')
})

test('ordinary prompts are returned unchanged apart from trimming', () => {
  assert.equal(unwrapPastedContent('  just typed this  '), 'just typed this')
  assert.equal(unwrapPastedContent('talk about <pasted_content> tags'), 'talk about <pasted_content> tags')
  assert.equal(unwrapPastedContent(''), '')
  assert.equal(unwrapPastedContent(null), '')
})

// Only a complete envelope is an envelope. A half-open fragment is ordinary
// text, and stripping it would let a crafted prompt impersonate an injection.
test('incomplete envelopes are not unwrapped', () => {
  assert.equal(unwrapPastedContent('<pasted_content id="x">\nhello'), '<pasted_content id="x">\nhello')
  assert.equal(unwrapPastedContent('hello\n</pasted_content id="x">'), 'hello\n</pasted_content id="x">')
})

test('nested envelopes unwrap to the payload within a bounded depth', () => {
  const nested = '<pasted_content id="a">\n<pasted_content id="b">\npayload\n</pasted_content id="b">\n</pasted_content id="a">'
  assert.equal(unwrapPastedContent(nested), 'payload')
})
