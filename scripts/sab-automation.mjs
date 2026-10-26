#!/usr/bin/env node
import fs from 'node:fs'
import { SLACK_CHANNEL_NAME } from '../daemon/automation.mjs'
import { normalizeProvider, normalizeRemoteLaunchFlags } from '../daemon/providers.mjs'

const BASE = String(process.env.SAB_AUTOMATION_URL || 'http://127.0.0.1:8877').replace(/\/$/, '')

function usage(message = '') {
  if (message) process.stderr.write(`sab automation: ${message}\n`)
  process.stderr.write(`Usage:
  sab automation create --external-key KEY --cwd DIR --provider claude|codex|pi \\
    [--collaborator USER_ID ...] (--prompt-file FILE|- | --task-file FILE|-) \\
    [--channel-name NAME] [--team TEAM [--alias ALIAS]] -- [PROVIDER_FLAGS...]
  sab automation status EXTERNAL_KEY
  sab automation stop EXTERNAL_KEY [--archive]
  sab automation release EXTERNAL_KEY --session ID --channel ID --tmux NAME --request-id ID
  sab automation validate-flags --provider claude|codex|pi -- [PROVIDER_FLAGS...]

The prompt is read from a file (or stdin with -), then encoded as JSON without
shell interpolation. SAB_AUTOMATION_URL may override the loopback base URL.

--channel-name creates the Slack channel under exactly that name before launch;
an existing name fails without launching anything. --team must run inside the
live SAB session that coordinates TEAM, during an owner or automatic turn: the
new channel joins TEAM as worker ALIAS, and --task-file becomes its first team
task, delivered as the initial prompt.\n`)
  process.exit(message ? 2 : 0)
}

// Team-bound creation is authorized by the calling coordinator session, which
// the daemon proves from this process's ancestry and tmux exactly as for
// `sab team`. The values identify; they are not secrets.
function callerQuery() {
  if (!process.env.CCS_BRIDGE || !process.env.CCS_TMUX) {
    usage('--team must run inside the live Slack Agent Bridge session that coordinates the team')
  }
  return new URLSearchParams({ ppid: String(process.ppid), tmux: process.env.CCS_TMUX }).toString()
}

const callerProvider = () => ['codex', 'pi'].includes(process.env.CCS_PROVIDER) ? process.env.CCS_PROVIDER : 'claude'

async function request(pathname, { method = 'GET', body, caller = false } = {}) {
  let response
  try {
    response = await fetch(`${BASE}${pathname}${caller ? `?${callerQuery()}` : ''}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(caller ? { 'x-ccs-provider': callerProvider() } : {}),
      },
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

if (command === 'validate-flags') {
  let provider = null
  let flags = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { flags = args.slice(i + 1); break }
    if (arg === '--provider') { provider = requiredValue(args, i, arg); i++; continue }
    usage(`unknown validate-flags option: ${arg}`)
  }
  provider = normalizeProvider(provider, '')
  if (!provider) usage('validate-flags requires --provider claude|codex|pi')
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, provider, flags: normalizeRemoteLaunchFlags(provider, flags) })}\n`)
  } catch (error) {
    usage(String(error?.message || error))
  }
} else if (command === 'create') {
  let externalKey = null
  let cwd = null
  let provider = null
  let promptFile = null
  let taskFile = null
  let channelName = null
  let team = null
  let alias = null
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
    if (arg === '--task-file') { taskFile = requiredValue(args, i, arg); i++; continue }
    if (arg === '--channel-name') { channelName = requiredValue(args, i, arg); i++; continue }
    if (arg === '--team') { team = requiredValue(args, i, arg); i++; continue }
    if (arg === '--alias') { alias = requiredValue(args, i, arg); i++; continue }
    usage(`unknown create option: ${arg}`)
  }
  if (!externalKey || !cwd || !provider || (promptFile === null && taskFile === null)) {
    usage('create requires --external-key, --cwd, --provider, and --prompt-file or --task-file')
  }
  if (promptFile !== null && taskFile !== null) usage('choose only one of --prompt-file or --task-file')
  if (taskFile !== null && !team) usage('--task-file requires --team')
  if (alias !== null && !team) usage('--alias requires --team')
  if (channelName !== null && !SLACK_CHANNEL_NAME.test(channelName)) {
    usage('--channel-name must be 1-80 lowercase letters, digits, hyphens or underscores')
  }
  const readInput = (file, label) => {
    try { return fs.readFileSync(file === '-' ? 0 : file, 'utf8') }
    catch (error) { usage(`could not read ${label} file: ${error?.message || error}`) }
  }
  const initialPrompt = promptFile === null ? '' : readInput(promptFile, 'prompt')
  const task = taskFile === null ? null : readInput(taskFile, 'task')
  if (task !== null && !task.trim()) usage('the task file is empty')
  await request('/automation/sessions', {
    method: 'POST',
    caller: Boolean(team),
    body: {
      externalKey, cwd, provider, flags, collaborators, initialPrompt,
      ...(channelName === null ? {} : { channelName }),
      ...(team ? { team: { name: team, ...(alias === null ? {} : { alias }), ...(task === null ? {} : { task }) } } : {}),
    },
  })
} else if (command === 'status') {
  if (args.length !== 1) usage('status requires exactly one external key')
  await request(`/automation/sessions/${encodeURIComponent(args[0])}`)
} else if (command === 'release') {
  const key = args.shift(), options = {}
  const fields = { '--session': 'sessionId', '--channel': 'channelId', '--tmux': 'tmux', '--request-id': 'requestId' }
  for (let i = 0; i < args.length; i += 2) {
    const field = fields[args[i]]
    if (!field || options[field]) usage('unknown or duplicate release option')
    options[field] = requiredValue(args, i, args[i])
  }
  if (!key || Object.keys(options).length !== 4) usage('release requires an external key and exact --session, --channel, --tmux and --request-id')
  await request(`/automation/sessions/${encodeURIComponent(key)}/release`, { method: 'POST', body: options })
} else if (command === 'stop') {
  if (!args.length || args.length > 2 || (args.length === 2 && args[1] !== '--archive')) {
    usage('stop requires an external key and optional --archive')
  }
  await request(`/automation/sessions/${encodeURIComponent(args[0])}/stop`, {
    method: 'POST', body: { archive: args[1] === '--archive' },
  })
} else usage(`unknown command: ${command}`)
