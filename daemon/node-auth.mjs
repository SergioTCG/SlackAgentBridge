import crypto from 'node:crypto'
import { NODE_PROTOCOL_VERSION } from './node-protocol.mjs'
import { validateNodeId } from './nodes.mjs'

const CHALLENGE_TTL_MS = 30 * 1000
const MAX_CHALLENGES = 1000

export function ensureCoordinatorId(state, {
  persist = () => {},
  randomId = () => `coordinator_${crypto.randomBytes(10).toString('hex')}`,
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('coordinator identity requires state')
  if (state.coordinatorId) return validateNodeId(state.coordinatorId)
  const id = validateNodeId(randomId())
  if (id === 'local') throw new Error('coordinator identity cannot use the local node ID')
  state.coordinatorId = id
  persist()
  return id
}

function validateChallenge(challenge) {
  if (!challenge || typeof challenge !== 'object' || Array.isArray(challenge)) throw new Error('invalid node challenge')
  const coordinatorId = validateNodeId(challenge.coordinatorId)
  const nodeId = validateNodeId(challenge.nodeId)
  const challengeId = String(challenge.challengeId || '')
  const nonce = String(challenge.nonce || '')
  const expiresAt = String(challenge.expiresAt || '')
  if (challenge.protocol !== NODE_PROTOCOL_VERSION) throw new Error('unsupported node challenge protocol')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(challengeId)) throw new Error('invalid node challenge ID')
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('invalid node challenge nonce')
  if (!Number.isSafeInteger(challenge.epoch) || challenge.epoch < 1) throw new Error('invalid node challenge epoch')
  const expiry = Date.parse(expiresAt)
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt) throw new Error('invalid node challenge expiry')
  return { protocol: NODE_PROTOCOL_VERSION, coordinatorId, nodeId, challengeId, nonce, epoch: challenge.epoch, expiresAt }
}

export function nodeChallengePayload(challenge) {
  const value = validateChallenge(challenge)
  return Buffer.from([
    'SAB-NODE-AUTH-V1',
    String(value.protocol),
    value.coordinatorId,
    value.nodeId,
    value.challengeId,
    value.nonce,
    String(value.epoch),
    value.expiresAt,
  ].join('\n'), 'utf8')
}

export function signNodeChallenge(challenge, privateKey) {
  let key
  try { key = crypto.createPrivateKey(privateKey) }
  catch {
    // `createPrivateKey` does not accept an already-public KeyObject. It does
    // accept private KeyObjects in supported Node releases, but retain an
    // explicit type check for a clearer failure when it does not.
    key = privateKey
  }
  if (!key || key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('node authentication requires an Ed25519 private key')
  return crypto.sign(null, nodeChallengePayload(challenge), key).toString('base64url')
}

function verifySignature(challenge, signature, publicKey) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
  let key
  try { key = crypto.createPublicKey(publicKey) }
  catch { key = publicKey }
  if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('node authentication requires an Ed25519 public key')
  return crypto.verify(null, nodeChallengePayload(challenge), key, Buffer.from(signature, 'base64url'))
}

export function createNodeChallengeStore({
  coordinatorId,
  now = Date.now,
  nonce = () => crypto.randomBytes(32),
  challengeId = () => `challenge_${crypto.randomBytes(16).toString('hex')}`,
  ttlMs = CHALLENGE_TTL_MS,
} = {}) {
  const coordinator = validateNodeId(coordinatorId)
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > CHALLENGE_TTL_MS) throw new Error('invalid node challenge lifetime')
  const pending = new Map()

  function prune() {
    const current = now()
    for (const [id, value] of pending) if (Date.parse(value.expiresAt) < current) pending.delete(id)
  }

  function issue({ nodeId, epoch }) {
    prune()
    if (pending.size >= MAX_CHALLENGES) throw new Error('too many pending node authentication challenges')
    const node = validateNodeId(nodeId)
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error('invalid node challenge epoch')
    let id = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      id = String(challengeId() || '')
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !pending.has(id)) break
      id = ''
    }
    if (!id) throw new Error('could not create a unique node challenge')
    const bytes = Buffer.from(nonce())
    if (bytes.length !== 32) throw new Error('node challenge nonce must contain 32 bytes')
    const issuedAt = now()
    const challenge = validateChallenge({
      protocol: NODE_PROTOCOL_VERSION,
      coordinatorId: coordinator,
      nodeId: node,
      challengeId: id,
      nonce: bytes.toString('base64url'),
      epoch,
      expiresAt: new Date(issuedAt + ttlMs).toISOString(),
    })
    pending.set(id, challenge)
    return { ...challenge }
  }

  function verify({ challengeId: requestedId, nodeId, signature, publicKey }) {
    const id = String(requestedId || '')
    const challenge = pending.get(id)
    if (!challenge) throw new Error('node challenge is invalid or already used')
    pending.delete(id) // every verdict consumes the nonce, including failures
    const node = validateNodeId(nodeId)
    if (challenge.nodeId !== node) throw new Error('node challenge does not belong to this node')
    if (Date.parse(challenge.expiresAt) < now()) throw new Error('node challenge has expired')
    if (!verifySignature(challenge, signature, publicKey)) throw new Error('node challenge signature is invalid')
    return { ...challenge }
  }

  return Object.freeze({ issue, prune, size: () => pending.size, verify })
}
