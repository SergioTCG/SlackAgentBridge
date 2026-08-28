import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fingerprintNodePublicKey } from './node-registry.mjs'
import { validateNodeId } from './nodes.mjs'

const KEY_FILE = 'node-key.pem'
const CONNECTION_FILE = 'node.json'
const KEY_FINGERPRINT_RE = /^sha256:[A-Za-z0-9_-]{43}$/

export function validateCoordinatorUrl(value) {
  let url
  try { url = new URL(String(value || '')) }
  catch { throw new Error('invalid coordinator URL') }
  if (url.username || url.password || url.hash) throw new Error('coordinator URL must not contain credentials or a fragment')
  const loopback = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('remote coordinator URLs must use wss')
  }
  return url.toString()
}

function ensurePrivateDirectory(configDir) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(configDir, 0o700) } catch {}
}

function readPrivateKey(file) {
  const pem = fs.readFileSync(file, 'utf8')
  let privateKey
  try { privateKey = crypto.createPrivateKey(pem) }
  catch { throw new Error('invalid SAB node private key') }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('SAB node private key must be Ed25519')
  try { fs.chmodSync(file, 0o600) } catch {}
  return privateKey
}

export function loadOrCreateNodeKey(configDir) {
  ensurePrivateDirectory(configDir)
  const file = path.join(configDir, KEY_FILE)
  let privateKey
  if (fs.existsSync(file)) privateKey = readPrivateKey(file)
  else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(temp, pem, { mode: 0o600, flag: 'wx' })
    try { fs.renameSync(temp, file) }
    catch (error) {
      try { fs.unlinkSync(temp) } catch {}
      if (!fs.existsSync(file)) throw error
      privateKey = readPrivateKey(file)
    }
    try { fs.chmodSync(file, 0o600) } catch {}
  }
  const publicKeyObject = crypto.createPublicKey(privateKey)
  const publicKey = publicKeyObject.export({ type: 'spki', format: 'pem' }).toString()
  return {
    privateKey,
    publicKey,
    keyFingerprint: fingerprintNodePublicKey(publicKey),
    path: file,
  }
}

function validateConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid SAB node connection config')
  const allowed = new Set(['version', 'nodeId', 'coordinatorId', 'coordinatorUrl', 'keyFingerprint'])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unknown SAB node connection field: ${key}`)
  if (value.version !== 1) throw new Error('unsupported SAB node connection version')
  const nodeId = validateNodeId(value.nodeId)
  const coordinatorId = validateNodeId(value.coordinatorId)
  const coordinatorUrl = validateCoordinatorUrl(value.coordinatorUrl)
  const keyFingerprint = String(value.keyFingerprint || '')
  if (!KEY_FINGERPRINT_RE.test(keyFingerprint)) throw new Error('invalid SAB node key fingerprint')
  return { version: 1, nodeId, coordinatorId, coordinatorUrl, keyFingerprint }
}

export function writeNodeConnection(configDir, value) {
  ensurePrivateDirectory(configDir)
  const connection = validateConnection({ version: 1, ...value })
  const file = path.join(configDir, CONNECTION_FILE)
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(temp, JSON.stringify(connection, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
  return connection
}

export function readNodeConnection(configDir) {
  const file = path.join(configDir, CONNECTION_FILE)
  if (!fs.existsSync(file)) return null
  let value
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { throw new Error('invalid SAB node connection config') }
  try { fs.chmodSync(file, 0o600) } catch {}
  return validateConnection(value)
}
