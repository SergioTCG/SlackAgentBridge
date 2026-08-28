import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectSlackRuntime } from '../daemon/slack-runtime.mjs'

test('all-in-one runtime creates one Slack client and one Socket Mode owner', () => {
  const calls = []
  class WebClientStub {
    constructor(token) { this.token = token; calls.push(['web', token]) }
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
  assert.equal(runtime.socket.options.appToken, 'app-test')
  assert.deepEqual(calls, [['web', 'bot-test'], ['socket', 'app-test']])
})
