import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectSlackRuntime } from '../daemon/slack-runtime.mjs'

test('all-in-one runtime creates its Slack clients and one Socket Mode owner', () => {
  const calls = []
  class WebClientStub {
    constructor(token, options) { this.token = token; this.options = options; calls.push(['web', token]) }
  }
  class SocketModeStub {
    constructor(options) { this.options = options; calls.push(['socket', options.appToken]) }
  }
  const runtime = createDirectSlackRuntime({
    botToken: 'bot-test',
    appToken: 'app-test',
    WebClientImpl: WebClientStub,
    SocketModeClientImpl: SocketModeStub,
  })
  assert.equal(runtime.mode, 'all-in-one')
  assert.equal(runtime.web.token, 'bot-test')
  assert.equal(runtime.web.options, undefined, 'ordinary calls keep the client defaults')
  // Non-idempotent creation uses one attempt and never waits out a rate limit.
  assert.equal(runtime.webOnce.token, 'bot-test')
  assert.deepEqual(runtime.webOnce.options, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true })
  assert.equal(runtime.socket.options.appToken, 'app-test')
  assert.deepEqual(calls, [['web', 'bot-test'], ['web', 'bot-test'], ['socket', 'app-test']])
})
