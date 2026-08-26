#!/usr/bin/env node

const BASE = String(process.env.SAB_TERMINAL_URL || 'http://127.0.0.1:8877').replace(/\/$/, '')

function usage(message = '') {
  if (message) process.stderr.write(`sab terminal: ${message}\n`)
  process.stderr.write(`Usage:
  sab terminal list [--json]
  sab terminal open <session|tmux|here>
  sab terminal close <session|tmux|here>
  sab terminal open-all|show-all|close-all
`)
  process.exit(message ? 2 : 0)
}

async function request(pathname, { method = 'GET', body } = {}) {
  let response
  try {
    response = await fetch(`${BASE}${pathname}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (error) {
    process.stderr.write(`sab terminal: bridge daemon unreachable (${error?.message || error})\n`)
    process.exit(1)
  }
  const raw = await response.text()
  let payload
  try { payload = JSON.parse(raw) }
  catch { payload = { ok: false, error: raw || `HTTP ${response.status}` } }
  if (!response.ok || payload.ok === false) {
    process.stderr.write(`sab terminal: ${payload.error || `HTTP ${response.status}`}\n`)
    process.exit(1)
  }
  return payload
}

const args = process.argv.slice(2)
let command = args.shift()
if (!command || command === '-h' || command === '--help') usage()
if (command === 'show-all') command = 'open-all'

if (command === 'list') {
  if (args.some(arg => arg !== '--json')) usage('list accepts only --json')
  const payload = await request('/terminals')
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(payload)}\n`)
  else if (!payload.terminals?.length) process.stdout.write('No active SAB sessions.\n')
  else {
    for (const terminal of payload.terminals) {
      process.stdout.write(`${terminal.session}\t${terminal.provider}\t${terminal.attached ? 'open' : 'closed'}\t${terminal.cwd}\n`)
    }
  }
} else if (command === 'open' || command === 'close') {
  if (args.length !== 1) usage(`${command} requires exactly one session selector`)
  const selector = args[0] === 'here' ? (process.env.CCS_TMUX || 'here') : args[0]
  const payload = await request(`/terminals/${command}`, { method: 'POST', body: { selector } })
  process.stdout.write(`${payload.message}\n`)
} else if (command === 'open-all' || command === 'close-all') {
  if (args.length) usage(`${command} takes no selector`)
  const action = command === 'open-all' ? 'open' : 'close'
  const payload = await request(`/terminals/${action}`, { method: 'POST', body: { all: true } })
  process.stdout.write(`${payload.message}\n`)
} else usage(`unknown command: ${command}`)
