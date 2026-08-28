#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrCreateNodeKey, readNodeConnection, writeNodeConnection } from '../daemon/node-keys.mjs'
import { enrollNodeWithCoordinator } from '../daemon/node-transport.mjs'

const BASE = String(process.env.SAB_NODE_URL || 'http://127.0.0.1:8877').replace(/\/$/, '')
const CONFIG_DIR = process.env.CCS_CONFIG_DIR || path.join(os.homedir(), '.config', 'ccs')

function usage(message = '') {
  if (message) process.stderr.write(`sab node: ${message}\n`)
  process.stderr.write(`Usage:
  sab node invite --operator SLACK_USER_ID --name NAME [--ttl-seconds N]
  sab node list
  sab node revoke NODE_ID
  sab node enroll --coordinator wss://HOST:PORT/nodes --token-file FILE|-
  sab node status

Invitation tokens must be read from a mode-0600 file or stdin; they are never
accepted as command-line arguments. SAB_NODE_URL may override the coordinator's
loopback management API. CCS_CONFIG_DIR may override local node key storage.\n`)
  process.exit(message ? 2 : 0)
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function request(pathname, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetch(`${BASE}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    process.stderr.write(`sab node: bridge daemon unreachable (${error?.message || error})\n`)
    process.exit(1)
  }
  const raw = await response.text()
  let payload
  try { payload = JSON.parse(raw) }
  catch { payload = { ok: false, error: raw || `HTTP ${response.status}` } }
  output(payload)
  if (!response.ok || payload.ok === false) process.exitCode = 1
  return payload
}

function valueAfter(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) usage(`${option} requires a value`)
  return value
}

function readInvitationToken(file) {
  let stat = null
  try {
    if (file !== '-') stat = fs.lstatSync(file)
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)) {
      usage('the invitation token file must be a regular file readable only by its owner (mode 0600)')
    }
    const token = fs.readFileSync(file === '-' ? 0 : file, 'utf8').trim()
    if (token.length < 16 || /\s/.test(token)) usage('the invitation token is invalid')
    return token
  } catch (error) {
    usage(`could not read invitation token: ${error?.message || error}`)
  }
}

const args = process.argv.slice(2)
const command = args.shift()
if (!command || command === '--help' || command === '-h') usage()

if (command === 'invite') {
  let operatorId = null
  let name = null
  let ttlSeconds
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--operator') { operatorId = valueAfter(args, i, arg); i++; continue }
    if (arg === '--name') { name = valueAfter(args, i, arg); i++; continue }
    if (arg === '--ttl-seconds') {
      const raw = valueAfter(args, i, arg); i++
      ttlSeconds = Number(raw)
      if (!Number.isSafeInteger(ttlSeconds)) usage('--ttl-seconds requires an integer')
      continue
    }
    usage(`unknown invite option: ${arg}`)
  }
  if (!operatorId || !name) usage('invite requires --operator and --name')
  await request('/nodes/invitations', {
    method: 'POST', body: { operatorId, name, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) },
  })
} else if (command === 'list') {
  if (args.length) usage('list accepts no arguments')
  await request('/nodes')
} else if (command === 'revoke') {
  if (args.length !== 1) usage('revoke requires exactly one node ID')
  await request(`/nodes/${encodeURIComponent(args[0])}/revoke`, { method: 'POST', body: {} })
} else if (command === 'enroll') {
  let coordinatorUrl = null
  let tokenFile = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--coordinator') { coordinatorUrl = valueAfter(args, i, arg); i++; continue }
    if (arg === '--token-file') { tokenFile = valueAfter(args, i, arg); i++; continue }
    usage(`unknown enroll option: ${arg}`)
  }
  if (!coordinatorUrl || !tokenFile) usage('enroll requires --coordinator and --token-file')
  if (readNodeConnection(CONFIG_DIR)) usage('this machine is already enrolled; revoke it at the coordinator before replacing its identity')
  const token = readInvitationToken(tokenFile)
  const keys = loadOrCreateNodeKey(CONFIG_DIR)
  let enrollment
  try {
    enrollment = await enrollNodeWithCoordinator({ url: coordinatorUrl, token, publicKey: keys.publicKey })
  } catch (error) {
    process.stderr.write(`sab node: enrollment failed (${error?.message || error})\n`)
    process.exit(1)
  }
  if (enrollment.keyFingerprint !== keys.keyFingerprint) {
    process.stderr.write('sab node: enrollment failed (coordinator returned a different key fingerprint)\n')
    process.exit(1)
  }
  const connection = writeNodeConnection(CONFIG_DIR, {
    nodeId: enrollment.nodeId,
    coordinatorId: enrollment.coordinatorId,
    coordinatorUrl,
    keyFingerprint: keys.keyFingerprint,
  })
  output({ ok: true, enrolled: true, ...connection, operatorId: enrollment.operatorId, name: enrollment.name })
} else if (command === 'status') {
  if (args.length) usage('status accepts no arguments')
  let connection
  try { connection = readNodeConnection(CONFIG_DIR) }
  catch (error) {
    process.stderr.write(`sab node: ${error?.message || error}\n`)
    process.exit(1)
  }
  output({ ok: true, enrolled: Boolean(connection), connection })
} else usage(`unknown command: ${command}`)
