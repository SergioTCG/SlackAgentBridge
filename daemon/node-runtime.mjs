import fs from 'node:fs'
import { validateCoordinatorUrl } from './node-keys.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function parseListen(value) {
  let url
  try { url = new URL(`tcp://${String(value || '')}`) }
  catch { throw new Error('invalid SAB_NODE_LISTEN; expected HOST:PORT') }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('invalid SAB_NODE_LISTEN; expected HOST:PORT')
  }
  const port = Number(url.port)
  if (!url.hostname || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('invalid SAB_NODE_LISTEN; expected HOST:PORT')
  }
  return { host: url.hostname, port }
}

function readRegularFile(file, label, { privateFile = false } = {}) {
  if (!file) throw new Error(`${label} is required`)
  let stat
  try { stat = fs.statSync(file) }
  catch { throw new Error(`${label} is not readable`) }
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`)
  if (privateFile && (stat.mode & 0o077) !== 0) throw new Error(`${label} must use mode 0600`)
  return fs.readFileSync(file)
}

export function readNodeListenerConfiguration(env = process.env) {
  if (!env.SAB_NODE_LISTEN) return { enabled: false }
  const { host, port } = parseListen(env.SAB_NODE_LISTEN)
  const loopback = LOOPBACK_HOSTS.has(host)
  const hasTlsKey = Boolean(env.SAB_NODE_TLS_KEY)
  const hasTlsCert = Boolean(env.SAB_NODE_TLS_CERT)
  if (hasTlsKey !== hasTlsCert) throw new Error('SAB node TLS key and certificate must be configured together')
  if (!loopback && (!hasTlsKey || !hasTlsCert)) throw new Error('non-loopback SAB node listener requires TLS')
  const tls = hasTlsKey ? {
    key: readRegularFile(env.SAB_NODE_TLS_KEY, 'SAB_NODE_TLS_KEY', { privateFile: true }),
    cert: readRegularFile(env.SAB_NODE_TLS_CERT, 'SAB_NODE_TLS_CERT'),
  } : null
  const formattedHost = host.includes(':') ? `[${host}]` : host
  const derivedUrl = `${tls ? 'wss' : 'ws'}://${formattedHost}:${port}/nodes`
  if (!loopback && !env.SAB_NODE_PUBLIC_URL) throw new Error('non-loopback SAB node listener requires SAB_NODE_PUBLIC_URL')
  const publicUrl = validateCoordinatorUrl(env.SAB_NODE_PUBLIC_URL || derivedUrl)
  const parsedPublic = new URL(publicUrl)
  if (parsedPublic.pathname !== '/nodes' || parsedPublic.search) throw new Error('SAB_NODE_PUBLIC_URL must end at /nodes')
  if (!loopback && parsedPublic.protocol !== 'wss:') throw new Error('non-loopback SAB_NODE_PUBLIC_URL must use wss')
  return { enabled: true, host, port, publicUrl, tls }
}
