import test from 'node:test'
import assert from 'node:assert/strict'
import { createSocketModeCoordinator } from '../daemon/coordinator.mjs'

function socketFixture() {
  const handlers = new Map()
  let starts = 0
  return {
    socket: {
      on: (name, handler) => {
        if (handlers.has(name)) throw new Error(`duplicate listener: ${name}`)
        handlers.set(name, handler)
      },
      start: async () => { starts++; return 'connected' },
    },
    handlers,
    starts: () => starts,
  }
}

test('coordinator acknowledges Socket Mode delivery before business routing', async () => {
  const fixture = socketFixture()
  const order = []
  const coordinator = createSocketModeCoordinator({
    socket: fixture.socket,
    handlers: {
      message: async packet => { order.push(['handled', packet.event.text]) },
    },
  })
  const started = await coordinator.start()
  assert.equal(started, 'connected')
  await fixture.handlers.get('message')({
    event: { text: 'hello' },
    ack: async () => { order.push(['acked']) },
  })
  assert.deepEqual(order, [['acked'], ['handled', 'hello']])
  assert.equal(fixture.starts(), 1)
})

test('acknowledgement failure does not suppress routing and handler errors stay bounded', async () => {
  const fixture = socketFixture()
  const errors = []
  let handled = 0
  const coordinator = createSocketModeCoordinator({
    socket: fixture.socket,
    handlers: {
      message: async () => { handled++; throw new Error('routing failed') },
    },
    onError: async (kind, error) => { errors.push([kind, error.message]) },
  })
  await coordinator.start()
  await assert.doesNotReject(fixture.handlers.get('message')({ ack: async () => { throw new Error('already acked') } }))
  assert.equal(handled, 1)
  assert.deepEqual(errors, [['message', 'routing failed']])
})

test('coordinator binds handlers and starts the sole socket exactly once', async () => {
  const fixture = socketFixture()
  const coordinator = createSocketModeCoordinator({
    socket: fixture.socket,
    handlers: { message: async () => {}, slash_commands: async () => {}, interactive: async () => {} },
  })
  await Promise.all([coordinator.start(), coordinator.start()])
  assert.deepEqual([...fixture.handlers.keys()], ['message', 'slash_commands', 'interactive'])
  assert.equal(fixture.starts(), 1)
})
