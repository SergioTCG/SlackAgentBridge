import { validateNodeId } from './nodes.mjs'

export const NODE_PROTOCOL_VERSION = 1
export const MAX_NODE_CONTROL_FRAME_BYTES = 256 * 1024

export const NODE_OPERATIONS = Object.freeze([
  'session.create',
  'session.input',
  'session.interrupt',
  'session.stop',
  'session.update',
  'session.settings',
  'terminal.list',
  'terminal.open',
  'terminal.close',
  'node.health',
])

export const NODE_EVENT_TYPES = Object.freeze([
  'session.started',
  'session.ended',
  'session.binding_ready',
  'session.commentary',
  'session.final',
  'session.status',
  'session.question',
  'session.permission',
  'session.usage',
  'artifact.ready',
  'node.snapshot',
])

const OPERATION_SET = new Set(NODE_OPERATIONS)
const EVENT_SET = new Set(NODE_EVENT_TYPES)
const KINDS = new Set(['command', 'result', 'event', 'heartbeat'])
const ENVELOPE_FIELDS = new Set(['protocol', 'kind', 'id', 'nodeId', 'epoch', 'sentAt', 'payload'])
const TARGET_FIELDS = new Set(['channelId', 'sessionId', 'tmux', 'provider', 'pid'])
const SESSION_OPERATIONS = new Set([
  'session.input', 'session.interrupt', 'session.stop', 'session.update', 'session.settings',
])
const CHANNEL_EVENTS = new Set([
  'session.commentary', 'session.final', 'session.status', 'session.question',
  'session.permission', 'session.usage', 'artifact.ready',
])
const PROVIDERS = new Set(['claude', 'codex', 'pi'])

export class NodeProtocolError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NodeProtocolError'
    this.code = code
  }
}

function fail(code, message) {
  throw new NodeProtocolError(code, message)
}

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('invalid_field', `${name} must be a JSON object`)
  }
  return value
}

function exactFields(object, allowed, name) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail('unknown_field', `unknown ${name} field: ${key}`)
  }
}

function boundedString(value, name, max = 128) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('invalid_field', `invalid ${name}`)
  }
  return value
}

function messageId(value, name = 'message ID') {
  const id = boundedString(value, name, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) fail('invalid_field', `invalid ${name}`)
  return id
}

function timestamp(value, name) {
  if (typeof value !== 'string') fail('invalid_field', `invalid ${name}`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('invalid_field', `invalid ${name}`)
  return parsed
}

function bodyObject(value) {
  if (value == null) return {}
  return plainObject(value, 'payload.body')
}

function validateTarget(value, { required = false, session = false, channel = false } = {}) {
  if (value == null && !required) return null
  const target = plainObject(value, 'payload.target')
  exactFields(target, TARGET_FIELDS, 'target')
  for (const field of ['channelId', 'sessionId', 'tmux']) {
    if (target[field] != null) boundedString(target[field], `target.${field}`, 256)
  }
  if (target.provider != null && !PROVIDERS.has(target.provider)) fail('invalid_field', 'invalid target.provider')
  if (target.pid != null && (!Number.isSafeInteger(target.pid) || target.pid <= 1)) fail('invalid_field', 'invalid target.pid')
  if (session && !target.sessionId) fail('invalid_target', 'session target requires sessionId')
  if (channel && !target.channelId) fail('invalid_target', 'session target requires channelId')
  return target
}

function validateCommand(payload, now) {
  exactFields(payload, new Set(['operation', 'deadlineAt', 'target', 'body']), 'command payload')
  const operation = boundedString(payload.operation, 'node operation', 80)
  if (!OPERATION_SET.has(operation)) fail('unknown_operation', `unknown node operation: ${operation}`)
  const deadline = timestamp(payload.deadlineAt, 'command deadlineAt')
  if (deadline < now) fail('expired_command', 'command deadline has expired')
  const session = SESSION_OPERATIONS.has(operation) || operation === 'terminal.open' || operation === 'terminal.close'
  const channel = SESSION_OPERATIONS.has(operation)
  validateTarget(payload.target, { required: session, session, channel })
  bodyObject(payload.body)
}

function validateResult(payload) {
  exactFields(payload, new Set(['commandId', 'ok', 'value', 'error']), 'result payload')
  messageId(payload.commandId, 'command ID')
  if (typeof payload.ok !== 'boolean') fail('invalid_field', 'result ok must be boolean')
  if (payload.ok) {
    if (payload.error != null) fail('invalid_field', 'successful result cannot contain an error')
    return
  }
  if (payload.value != null) fail('invalid_field', 'failed result cannot contain a value')
  const error = plainObject(payload.error, 'result error')
  exactFields(error, new Set(['code', 'message', 'action']), 'result error')
  if (typeof error.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(error.code)) fail('invalid_field', 'invalid node error code')
  boundedString(error.message, 'node error message', 1000)
  boundedString(error.action, 'node error action', 1000)
}

function validateEvent(payload) {
  exactFields(payload, new Set(['type', 'target', 'body']), 'event payload')
  const type = boundedString(payload.type, 'node event type', 80)
  if (!EVENT_SET.has(type)) fail('unknown_event', `unknown node event type: ${type}`)
  const session = type !== 'node.snapshot'
  validateTarget(payload.target, { required: session, session, channel: CHANNEL_EVENTS.has(type) })
  bodyObject(payload.body)
}

function validateHeartbeat(payload) {
  exactFields(payload, new Set(['capabilities', 'activeSessions']), 'heartbeat payload')
  if (!Array.isArray(payload.capabilities) || payload.capabilities.length > 64) {
    fail('invalid_field', 'heartbeat capabilities must be a bounded array')
  }
  for (const capability of payload.capabilities) boundedString(capability, 'heartbeat capability', 80)
  if (payload.activeSessions != null && (!Number.isSafeInteger(payload.activeSessions) || payload.activeSessions < 0)) {
    fail('invalid_field', 'invalid heartbeat activeSessions')
  }
}

function decode(input) {
  if (typeof input === 'string' || Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const bytes = Buffer.byteLength(input)
    if (bytes > MAX_NODE_CONTROL_FRAME_BYTES) fail('frame_too_large', 'node control frame is too large')
    try { return JSON.parse(Buffer.from(input).toString('utf8')) }
    catch { fail('invalid_json', 'node control frame is not valid JSON') }
  }
  let encoded
  try { encoded = JSON.stringify(input) } catch { fail('invalid_json', 'node control frame is not JSON-safe') }
  if (Buffer.byteLength(encoded || '') > MAX_NODE_CONTROL_FRAME_BYTES) fail('frame_too_large', 'node control frame is too large')
  return input
}

export function parseNodeEnvelope(input, { now = Date.now() } = {}) {
  const envelope = plainObject(decode(input), 'node envelope')
  exactFields(envelope, ENVELOPE_FIELDS, 'envelope')
  if (envelope.protocol !== NODE_PROTOCOL_VERSION) fail('unsupported_protocol', `unsupported node protocol: ${envelope.protocol}`)
  if (!KINDS.has(envelope.kind)) fail('unknown_kind', `unknown node message kind: ${envelope.kind}`)
  messageId(envelope.id)
  try { validateNodeId(envelope.nodeId) }
  catch (error) { fail('invalid_node', String(error?.message || error)) }
  if (!Number.isSafeInteger(envelope.epoch) || envelope.epoch < 1) fail('invalid_epoch', 'invalid connection epoch')
  timestamp(envelope.sentAt, 'sentAt')
  const payload = plainObject(envelope.payload, 'payload')
  if (envelope.kind === 'command') validateCommand(payload, now)
  else if (envelope.kind === 'result') validateResult(payload)
  else if (envelope.kind === 'event') validateEvent(payload)
  else validateHeartbeat(payload)
  return envelope
}

export function createNodeEnvelope(fields, options) {
  return parseNodeEnvelope({ protocol: NODE_PROTOCOL_VERSION, ...fields }, options)
}
