import crypto from 'node:crypto'
import { validateNodeId } from './nodes.mjs'

const SLACK_USER_RE = /^[UW][A-Z0-9]{2,31}$/
const KEY_FINGERPRINT_RE = /^sha256:[A-Za-z0-9_-]{43}$/
const DEFAULT_TTL_MS = 10 * 60 * 1000
const MAX_TTL_MS = 60 * 60 * 1000
const CLAIM_RECOVERY_MS = 24 * 60 * 60 * 1000

function invitationHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function validateOperator(value) {
  const operatorId = String(value || '')
  if (!SLACK_USER_RE.test(operatorId)) throw new Error('invalid Slack operator ID')
  return operatorId
}

function validateName(value) {
  const name = String(value || '').trim()
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('invalid execution node name')
  return name
}

function validateFingerprint(value) {
  const fingerprint = String(value || '')
  if (!KEY_FINGERPRINT_RE.test(fingerprint)) throw new Error('invalid node key fingerprint')
  return fingerprint
}

function publicInvitation(record, token = undefined) {
  return {
    ...(token === undefined ? {} : { token }),
    nodeId: record.nodeId,
    operatorId: record.operatorId,
    name: record.name,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    status: record.status,
    keyFingerprint: record.keyFingerprint,
    claimedAt: record.claimedAt,
    completedAt: record.completedAt,
  }
}

export function createNodeInvitationStore({
  state,
  persist = () => {},
  now = Date.now,
  token = () => crypto.randomBytes(32).toString('base64url'),
  nodeId = () => `node_${crypto.randomBytes(10).toString('hex')}`,
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('node invitation store requires state')

  function records() {
    return state.nodeInvitations || {}
  }

  function prune() {
    if (!state.nodeInvitations) return 0
    const current = now()
    let removed = 0
    for (const [hash, record] of Object.entries(state.nodeInvitations)) {
      const cutoff = record.status === 'issued' ? Date.parse(record.expiresAt) : Date.parse(record.recoveryUntil || record.expiresAt)
      if (!Number.isFinite(cutoff) || cutoff < current) { delete state.nodeInvitations[hash]; removed++ }
    }
    if (!Object.keys(state.nodeInvitations).length) delete state.nodeInvitations
    if (removed) persist()
    return removed
  }

  function issue({ operatorId, name, ttlMs = DEFAULT_TTL_MS }) {
    prune()
    const operator = validateOperator(operatorId)
    const displayName = validateName(name)
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL_MS) throw new Error('invalid invitation lifetime')
    const duplicate = Object.values(records()).find(record =>
      ['issued', 'claimed'].includes(record.status) && record.name.toLocaleLowerCase() === displayName.toLocaleLowerCase())
    if (duplicate) throw new Error(`an invitation for execution node name ${displayName} is already pending`)

    let raw = ''
    let hash = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      raw = String(token() || '')
      if (raw.length < 16 || /\s/.test(raw)) continue
      hash = invitationHash(raw)
      if (!records()[hash]) break
      raw = ''; hash = ''
    }
    if (!raw || !hash) throw new Error('could not create a unique node invitation')

    let id = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      id = validateNodeId(nodeId())
      const used = state.nodes?.[id] || Object.values(records()).some(record => record.nodeId === id)
      if (!used && id !== 'local') break
      id = ''
    }
    if (!id) throw new Error('could not create a unique execution node ID')

    const issuedAtMs = now()
    const record = {
      nodeId: id,
      operatorId: operator,
      name: displayName,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + ttlMs).toISOString(),
      status: 'issued',
      keyFingerprint: null,
      claimedAt: null,
      completedAt: null,
    }
    if (!state.nodeInvitations) state.nodeInvitations = {}
    state.nodeInvitations[hash] = record
    persist()
    return publicInvitation(record, raw)
  }

  function find(rawToken) {
    const raw = String(rawToken || '')
    if (raw.length < 16 || /\s/.test(raw)) return null
    return records()[invitationHash(raw)] || null
  }

  function claim(rawToken, requestedFingerprint) {
    const fingerprint = validateFingerprint(requestedFingerprint)
    const record = find(rawToken)
    if (!record) throw new Error('node invitation is invalid or expired')
    const current = now()
    if (record.status === 'issued' && Date.parse(record.expiresAt) < current) {
      delete state.nodeInvitations[invitationHash(rawToken)]
      if (!Object.keys(state.nodeInvitations).length) delete state.nodeInvitations
      persist()
      throw new Error('node invitation has expired')
    }
    if (!['issued', 'claimed', 'completed'].includes(record.status)) throw new Error('node invitation is invalid or expired')
    if (record.keyFingerprint && record.keyFingerprint !== fingerprint) {
      throw new Error('node invitation was already claimed by a different node key')
    }
    if (record.status === 'issued') {
      record.status = 'claimed'
      record.keyFingerprint = fingerprint
      record.claimedAt = new Date(current).toISOString()
      record.recoveryUntil = new Date(current + CLAIM_RECOVERY_MS).toISOString()
      persist()
    } else if (Date.parse(record.recoveryUntil || record.expiresAt) < current) {
      throw new Error('node invitation recovery window has expired')
    }
    return publicInvitation(record)
  }

  function complete(rawToken, requestedFingerprint) {
    const record = claim(rawToken, requestedFingerprint)
    const stored = find(rawToken)
    if (stored.status !== 'completed') {
      stored.status = 'completed'
      stored.completedAt = new Date(now()).toISOString()
      persist()
    }
    return publicInvitation(stored || record)
  }

  function revoke(requestedNodeId) {
    const id = validateNodeId(requestedNodeId)
    let removed = 0
    for (const [hash, record] of Object.entries(records())) {
      if (record.nodeId !== id) continue
      delete state.nodeInvitations[hash]
      removed++
    }
    if (state.nodeInvitations && !Object.keys(state.nodeInvitations).length) delete state.nodeInvitations
    if (removed) persist()
    return removed
  }

  function list() {
    prune()
    return Object.values(records()).map(record => publicInvitation(record))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  return Object.freeze({ claim, complete, issue, list, prune, revoke })
}
