import crypto from 'node:crypto'
import { LOCAL_NODE_ID, validateNodeId } from './nodes.mjs'

const SLACK_USER_RE = /^[UW][A-Z0-9]{2,31}$/

function validateSlackUserId(value) {
  const userId = String(value || '')
  if (!SLACK_USER_RE.test(userId)) throw new Error(`invalid Slack user ID: ${userId || '(empty)'}`)
  return userId
}

function validateNodeName(value) {
  const name = String(value || '').trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid execution node name')
  return name
}

function canonicalPublicKey(value) {
  let key
  try { key = crypto.createPublicKey(value) }
  catch { throw new Error('invalid execution node public key') }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('execution nodes require an Ed25519 public key')
  return {
    key,
    pem: key.export({ type: 'spki', format: 'pem' }).toString(),
    der: key.export({ type: 'spki', format: 'der' }),
  }
}

export function fingerprintNodePublicKey(value) {
  return fingerprintDer(canonicalPublicKey(value).der)
}

function fingerprintDer(der) {
  return `sha256:${crypto.createHash('sha256').update(der).digest('base64url')}`
}

function publicNode(record, { connected = false } = {}) {
  return {
    id: record.id,
    name: record.name,
    mode: record.mode,
    connected,
    operators: [...record.operators],
    revokedAt: record.revokedAt || null,
  }
}

export function createNodeRegistry({
  state,
  adminUserId,
  localName = 'This Mac',
  now = Date.now,
  persist = () => {},
  isConnected = () => false,
}) {
  if (!state || typeof state !== 'object') throw new Error('node registry requires state')
  const admin = validateSlackUserId(adminUserId)
  const local = Object.freeze({
    id: LOCAL_NODE_ID,
    name: validateNodeName(localName),
    mode: 'local',
    operators: Object.freeze([admin]),
    revokedAt: null,
  })

  function record(nodeId) {
    const id = validateNodeId(nodeId)
    return id === LOCAL_NODE_ID ? local : state.nodes?.[id] || null
  }

  function active(nodeId) {
    const found = record(nodeId)
    return found && !found.revokedAt ? found : null
  }

  function canOperate(userId, nodeId) {
    const user = validateSlackUserId(userId)
    const found = active(nodeId)
    return Boolean(found && (user === admin || found.operators.includes(user)))
  }

  function listFor(userId) {
    const user = validateSlackUserId(userId)
    const records = [local, ...Object.values(state.nodes || {})]
      .filter(item => !item.revokedAt && (user === admin || item.operators.includes(user)))
      .sort((a, b) => a.id === LOCAL_NODE_ID ? -1 : b.id === LOCAL_NODE_ID ? 1 : a.name.localeCompare(b.name))
    return records.map(item => publicNode(item, {
      connected: item.id === LOCAL_NODE_ID || isConnected(item.id),
    }))
  }

  function registerEnrolledNode({ nodeId, name, operatorId, publicKey }) {
    const id = validateNodeId(nodeId)
    if (id === LOCAL_NODE_ID) throw new Error('the implicit local node cannot be enrolled')
    const operator = validateSlackUserId(operatorId)
    const displayName = validateNodeName(name)
    const canonical = canonicalPublicKey(publicKey)
    const keyFingerprint = fingerprintDer(canonical.der)
    const existing = state.nodes?.[id]
    if (existing) {
      if (existing.keyFingerprint !== keyFingerprint) throw new Error(`execution node ${id} is pinned to a different public key`)
      if (!existing.operators.includes(operator)) throw new Error(`execution node ${id} is assigned to a different operator`)
      return { created: false, node: publicNode(existing, { connected: isConnected(id) }) }
    }

    const enrolledAt = new Date(now()).toISOString()
    const next = {
      id,
      name: displayName,
      mode: 'remote',
      publicKey: canonical.pem,
      keyFingerprint,
      operators: [operator],
      enrolledAt,
      revokedAt: null,
      connectionEpoch: 0,
    }
    if (!state.nodes) state.nodes = {}
    state.nodes[id] = next
    persist()
    return { created: true, node: publicNode(next, { connected: isConnected(id) }) }
  }

  function resolveFor(userId, selector) {
    const value = String(selector || '').trim()
    if (!value) throw new Error('an execution node selector is required')
    const candidates = listFor(userId)
    const exactId = candidates.find(item => item.id === value)
    if (exactId) return exactId
    const matches = candidates.filter(item => item.name.localeCompare(value, undefined, { sensitivity: 'accent' }) === 0)
    if (matches.length > 1) throw new Error(`execution node name is ambiguous: ${value}`)
    if (!matches.length) throw new Error(`execution node is not available to this operator: ${value}`)
    return matches[0]
  }

  function setDefault(userId, selector) {
    const user = validateSlackUserId(userId)
    const node = resolveFor(user, selector)
    if (!state.nodeDefaults) state.nodeDefaults = {}
    if (state.nodeDefaults[user] !== node.id) {
      state.nodeDefaults[user] = node.id
      persist()
    }
    return node
  }

  function defaultFor(userId) {
    const user = validateSlackUserId(userId)
    const id = state.nodeDefaults?.[user]
    if (!id || !canOperate(user, id)) return null
    const found = active(id)
    return publicNode(found, { connected: id === LOCAL_NODE_ID || isConnected(id) })
  }

  function rename(nodeId, name) {
    const id = validateNodeId(nodeId)
    if (id === LOCAL_NODE_ID) throw new Error('the compatibility-local node name is configuration, not persisted state')
    const found = state.nodes?.[id]
    if (!found || found.revokedAt) throw new Error(`execution node is not active: ${id}`)
    const next = validateNodeName(name)
    if (found.name !== next) { found.name = next; persist() }
    return publicNode(found, { connected: isConnected(id) })
  }

  function revoke(nodeId) {
    const id = validateNodeId(nodeId)
    if (id === LOCAL_NODE_ID) throw new Error('the implicit local node cannot be revoked')
    const found = state.nodes?.[id]
    if (!found) throw new Error(`unknown execution node: ${id}`)
    if (!found.revokedAt) {
      found.revokedAt = new Date(now()).toISOString()
      if (state.nodeDefaults) {
        for (const [user, value] of Object.entries(state.nodeDefaults)) {
          if (value === id) delete state.nodeDefaults[user]
        }
        if (!Object.keys(state.nodeDefaults).length) delete state.nodeDefaults
      }
      persist()
    }
    return publicNode(found, { connected: false })
  }

  function publicKeyFor(nodeId) {
    const found = active(nodeId)
    return found?.mode === 'remote' && typeof found.publicKey === 'string' ? found.publicKey : null
  }

  function nextConnectionEpoch(nodeId) {
    const found = active(nodeId)
    if (!found || found.mode !== 'remote') throw new Error(`execution node is not active: ${nodeId}`)
    const current = Number.isSafeInteger(found.connectionEpoch) && found.connectionEpoch >= 0 ? found.connectionEpoch : 0
    if (current >= Number.MAX_SAFE_INTEGER - 1) throw new Error(`execution node epoch is exhausted: ${nodeId}`)
    return current + 1
  }

  function advanceConnectionEpoch(nodeId) {
    const found = active(nodeId)
    if (!found || found.mode !== 'remote') throw new Error(`execution node is not active: ${nodeId}`)
    found.connectionEpoch = nextConnectionEpoch(nodeId)
    found.lastConnectedAt = new Date(now()).toISOString()
    persist()
    return found.connectionEpoch
  }

  return Object.freeze({
    advanceConnectionEpoch,
    canOperate,
    defaultFor,
    listFor,
    nextConnectionEpoch,
    publicKeyFor,
    record,
    registerEnrolledNode,
    rename,
    resolveFor,
    revoke,
    setDefault,
  })
}
