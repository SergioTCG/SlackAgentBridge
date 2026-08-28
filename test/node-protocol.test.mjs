import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_NODE_CONTROL_FRAME_BYTES,
  NODE_PROTOCOL_VERSION,
  NodeProtocolError,
  createNodeEnvelope,
  parseNodeEnvelope,
} from '../daemon/node-protocol.mjs'

const now = Date.parse('2026-08-28T12:00:00.000Z')

test('node command envelopes are strict, bounded, and round-trip as JSON', () => {
  const command = createNodeEnvelope({
    kind: 'command',
    id: 'cmd_01jabcdef',
    nodeId: 'node_rade',
    epoch: 7,
    sentAt: '2026-08-28T12:00:00.000Z',
    payload: {
      operation: 'session.input',
      deadlineAt: '2026-08-28T12:01:00.000Z',
      target: { channelId: 'C123', sessionId: '01j-session', tmux: 'sab-rade', provider: 'codex' },
      body: { text: 'hello' },
    },
  }, { now })
  assert.equal(command.protocol, NODE_PROTOCOL_VERSION)
  assert.deepEqual(parseNodeEnvelope(JSON.stringify(command), { now }), command)
})

test('commands reject unknown operations, expired deadlines, and incomplete targets', () => {
  const base = {
    kind: 'command', id: 'cmd_1', nodeId: 'node_rade', epoch: 1,
    sentAt: '2026-08-28T12:00:00.000Z',
    payload: {
      operation: 'session.input', deadlineAt: '2026-08-28T12:01:00.000Z',
      target: { channelId: 'C1', sessionId: 'S1' }, body: {},
    },
  }
  assert.throws(() => createNodeEnvelope({ ...base, payload: { ...base.payload, operation: 'shell.eval' } }, { now }), /unknown node operation/)
  assert.throws(() => createNodeEnvelope({ ...base, payload: { ...base.payload, deadlineAt: '2026-08-28T11:59:59.000Z' } }, { now }), /command deadline has expired/)
  assert.throws(() => createNodeEnvelope({ ...base, payload: { ...base.payload, target: { channelId: 'C1' } } }, { now }), /session target requires sessionId/)
})

test('results correlate one command and expose bounded actionable failures', () => {
  const result = createNodeEnvelope({
    kind: 'result', id: 'result_1', nodeId: 'node_rade', epoch: 2,
    sentAt: '2026-08-28T12:00:00.000Z',
    payload: {
      commandId: 'cmd_1', ok: false,
      error: { code: 'cwd_missing', message: 'The project directory does not exist.', action: 'Choose a directory on node Rade.' },
    },
  }, { now })
  assert.equal(result.payload.error.code, 'cwd_missing')
  assert.throws(() => createNodeEnvelope({
    ...result,
    payload: { commandId: 'cmd_1', ok: false, error: { code: 'bad code', message: 'x', action: 'retry' } },
  }, { now }), /invalid node error code/)
})

test('events use an allowlist and exact route identity', () => {
  const event = createNodeEnvelope({
    kind: 'event', id: 'evt_1', nodeId: 'node_rade', epoch: 9,
    sentAt: '2026-08-28T12:00:00.000Z',
    payload: {
      type: 'session.commentary',
      target: { channelId: 'C1', sessionId: 'S1', tmux: 'sab-rade', provider: 'codex', pid: 123 },
      body: { text: 'Still working.' },
    },
  }, { now })
  assert.equal(event.payload.type, 'session.commentary')
  assert.throws(() => createNodeEnvelope({ ...event, payload: { ...event.payload, type: 'transcript.dump' } }, { now }), /unknown node event type/)
})

test('protocol, identities, timestamps, extra fields, and frame size fail closed', () => {
  const valid = {
    protocol: NODE_PROTOCOL_VERSION,
    kind: 'heartbeat', id: 'heartbeat_1', nodeId: 'node_rade', epoch: 1,
    sentAt: '2026-08-28T12:00:00.000Z', payload: { capabilities: ['session.create'] },
  }
  assert.throws(() => parseNodeEnvelope({ ...valid, protocol: 99 }, { now }), /unsupported node protocol/)
  assert.throws(() => parseNodeEnvelope({ ...valid, nodeId: '../local' }, { now }), /invalid execution node ID/)
  assert.throws(() => parseNodeEnvelope({ ...valid, epoch: 0 }, { now }), /invalid connection epoch/)
  assert.throws(() => parseNodeEnvelope({ ...valid, sentAt: 'today' }, { now }), /invalid sentAt/)
  assert.throws(() => parseNodeEnvelope({ ...valid, surprise: true }, { now }), /unknown envelope field/)
  assert.throws(() => parseNodeEnvelope('x'.repeat(MAX_NODE_CONTROL_FRAME_BYTES + 1), { now }), error => {
    assert.ok(error instanceof NodeProtocolError)
    assert.equal(error.code, 'frame_too_large')
    return true
  })
})
