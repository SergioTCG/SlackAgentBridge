#!/usr/bin/env node
import fs from 'node:fs'

const BASE = String(process.env.SAB_AUTOMATION_URL || 'http://127.0.0.1:8877').replace(/\/$/, '')

function usage(message = '') {
  if (message) process.stderr.write(`sab automation: ${message}\n`)
  process.stderr.write(`Usage:
  sab automation create --external-key KEY --cwd DIR --provider claude|codex|pi \\
    [--collaborator USER_ID ...] --prompt-file FILE|- -- [PROVIDER_FLAGS...]
  sab automation status EXTERNAL_KEY
  sab automation stop EXTERNAL_KEY [--archive]

The prompt is read from a file (or stdin with -), then encoded as JSON without
shell interpolation. SAB_AUTOMATION_URL may override the loopback base URL.\n`)
  process.exit(message ? 2 : 0)
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
    process.stderr.write(`sab automation: bridge daemon unreachable (${error?.message || error})\n`)
    process.exit(1)
  }
  const raw = await response.text()
  let payload
  try { payload = JSON.parse(raw) }
  catch { payload = { ok: false, error: raw || `HTTP ${response.status}` } }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
  if (!response.ok || payload.ok === false) process.exitCode = 1
}

function requiredValue(args, index, option) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) usage(`${option} requires a value`)
  return value
}

const args = process.argv.slice(2)
const command = args.shift()
if (!command || command === '--help' || command === '-h') usage()

if (command === 'create') {
  let externalKey = null
  let cwd = null
  let provider = null
  let promptFile = null
  const collaborators = []
  let flags = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { flags = args.slice(i + 1); break }
    if (arg === '--external-key') { externalKey = requiredValue(args, i, arg); i++; continue }
    if (arg === '--cwd') { cwd = requiredValue(args, i, arg); i++; continue }
    if (arg === '--provider') { provider = requiredValue(args, i, arg); i++; continue }
    if (arg === '--collaborator') { collaborators.push(requiredValue(args, i, arg)); i++; continue }
    if (arg === '--prompt-file') { promptFile = requiredValue(args, i, arg); i++; continue }
    usage(`unknown create option: ${arg}`)
  }
  if (!externalKey || !cwd || !provider || promptFile === null) {
    usage('create requires --external-key, --cwd, --provider, and --prompt-file')
  }
  let initialPrompt
  try { initialPrompt = fs.readFileSync(promptFile === '-' ? 0 : promptFile, 'utf8') }
  catch (error) { usage(`could not read prompt file: ${error?.message || error}`) }
  await request('/automation/sessions', {
    method: 'POST', body: { externalKey, cwd, provider, flags, collaborators, initialPrompt },
  })
} else if (command === 'status') {
  if (args.length !== 1) usage('status requires exactly one external key')
  await request(`/automation/sessions/${encodeURIComponent(args[0])}`)
} else if (command === 'stop') {
  if (!args.length || args.length > 2 || (args.length === 2 && args[1] !== '--archive')) {
    usage('stop requires an external key and optional --archive')
  }
  await request(`/automation/sessions/${encodeURIComponent(args[0])}/stop`, {
    method: 'POST', body: { archive: args[1] === '--archive' },
  })
} else usage(`unknown command: ${command}`)
