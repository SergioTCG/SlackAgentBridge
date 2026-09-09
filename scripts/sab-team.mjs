#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { TEAM_MESSAGE_MAX_BYTES } from '../daemon/teams.mjs'

const DEFAULT_BASE = 'http://127.0.0.1:8877'
if (process.env.SAB_TEAM_URL && process.env.NODE_ENV !== 'test') {
  process.stderr.write('sab team: SAB_TEAM_URL is reserved for tests\n')
  process.exit(2)
}
const BASE = String(process.env.SAB_TEAM_URL || DEFAULT_BASE).replace(/\/$/, '')

function usage(message = '') {
  if (message) process.stderr.write(`sab team: ${message}\n`)
  process.stderr.write(`Usage:
  sab team context [--json]
  sab team peers [--json]
  sab team inbox [--active] [--target ALIAS] [--status STATUS[,STATUS]] [--since ISO] [--cursor CURSOR] [--after TASK_ID] [--limit N] [--page] [--json]
  sab team send --to ALIAS (--stdin | --message TEXT) [--request-id ID]
  sab team send-file (--to ALIAS | --task TASK_ID) [--message TEXT] [--request-id ID] -- FILE_PATH [FILE_PATH ...]
  sab team wait --task TASK_ID [--timeout SECONDS] [--json]
  sab team reply --task TASK_ID (--stdin | --message TEXT) [--request-id ID]
  sab team checkpoint --task TASK_ID --pending GATE[,GATE]|none (--stdin | --message TEXT) [--request-id ID]
  sab team complete --task TASK_ID (--stdin | --message TEXT) [--request-id ID]
  sab team release --task TASK_ID [--request-id ID]
  sab team continue --task TASK_ID (--stdin | --message TEXT) [--request-id ID]
  sab team message --task TASK_ID (--stdin | --message TEXT) [--request-id ID]
  sab team replace --task TASK_ID (--stdin | --message TEXT) [--request-id ID]
  sab team cancel --task TASK_ID [--reason TEXT] [--request-id ID]
  sab team mutation --request-id ID [--task TASK_ID]
  sab team mode <active|draining>

Team identity and destinations are resolved by the bridge. These commands must
run inside an authoritative live Slack Agent Bridge session.\n`)
  process.exit(message ? 2 : 0)
}

function requireSession() {
  if (!process.env.CCS_BRIDGE || !process.env.CCS_TMUX) usage('this command must run inside a live Slack Agent Bridge session')
}

function query() {
  const params = new URLSearchParams({ ppid: String(process.ppid), tmux: process.env.CCS_TMUX })
  return params.toString()
}

async function request(pathname, { method = 'GET', body, timeout = 30_000 } = {}) {
  let response
  try {
    response = await fetch(`${BASE}${pathname}${pathname.includes('?') ? '&' : '?'}${query()}`, {
      method,
      headers: {
        'x-ccs-provider': ['codex', 'pi'].includes(process.env.CCS_PROVIDER) ? process.env.CCS_PROVIDER : 'claude',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    throw Object.assign(new Error(`bridge daemon unreachable (${error?.message || error})`), { exitCode: 1 })
  }
  const raw = await response.text()
  let payload
  try { payload = JSON.parse(raw) }
  catch { payload = { ok: false, error: raw || `HTTP ${response.status}` } }
  if (!response.ok || payload.ok === false) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { code: payload.code, exitCode: 1 })
  }
  return payload
}

function value(args, index, option) {
  const result = args[index + 1]
  if (result === undefined || result.startsWith('--')) usage(`${option} requires a value`)
  return result
}

function readBoundedStdin() {
  const chunks = []
  let length = 0
  while (true) {
    const buffer = Buffer.allocUnsafe(8192)
    const read = fs.readSync(0, buffer, 0, buffer.length, null)
    if (!read) break
    length += read
    if (length > TEAM_MESSAGE_MAX_BYTES) usage(`stdin may contain at most ${TEAM_MESSAGE_MAX_BYTES} bytes`)
    chunks.push(buffer.subarray(0, read))
  }
  return Buffer.concat(chunks, length).toString('utf8')
}

function readText(mode, input) {
  if (mode === 'stdin') return readBoundedStdin()
  return String(input || '')
}

function commonMessageArgs(args, { files = false } = {}) {
  let to = null
  let taskId = null
  let mode = null
  let message = ''
  let requestId = null
  const paths = []
  let pathsOnly = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (pathsOnly) { paths.push(path.resolve(arg)); continue }
    if (arg === '--') { pathsOnly = true; continue }
    if (arg === '--to') { to = value(args, i, arg); i++; continue }
    if (arg === '--task') { taskId = value(args, i, arg); i++; continue }
    if (arg === '--request-id') { requestId = value(args, i, arg); i++; continue }
    if (arg === '--stdin') {
      if (mode) usage('choose only one of --stdin or --message')
      mode = 'stdin'; continue
    }
    if (arg === '--message') {
      if (mode) usage('choose only one of --stdin or --message')
      mode = 'message'; message = value(args, i, arg); i++; continue
    }
    usage(`unknown option: ${arg}`)
  }
  if (files && !paths.length) usage('provide at least one file path after --')
  if (!files && paths.length) usage('file paths are accepted only by send-file')
  return { to, taskId, text: mode ? readText(mode, message).trim() : '', paths, requestId }
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function mutate(pathname, body, { timeout = 30_000 } = {}) {
  const requestId = body.requestId || crypto.randomUUID()
  try {
    return await request(pathname, { method: 'POST', body: { ...body, requestId }, timeout })
  } catch (error) {
    // A continuation request names its terminal parent, but the accepted
    // mutation belongs to a newly created child whose ID is unknown after a
    // timeout. Query that request workspace-wide instead of filtering it out.
    const task = pathname !== '/team/continue' && body.taskId ? ` --task ${body.taskId}` : ''
    error.message = `${error.message}; retry safely with --request-id ${requestId}, or verify acceptance with sab team mutation --request-id ${requestId}${task}`
    throw error
  }
}

function taskRequestArgs(args, { text = false, pending = false } = {}) {
  let taskId = null
  let requestId = null
  let mode = null
  let message = ''
  let pendingValue = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--task') { taskId = value(args, i, arg); i++; continue }
    if (arg === '--request-id') { requestId = value(args, i, arg); i++; continue }
    if (pending && arg === '--pending') { pendingValue = value(args, i, arg); i++; continue }
    if (text && arg === '--stdin') {
      if (mode) usage('choose only one of --stdin or --message')
      mode = 'stdin'; continue
    }
    if (text && arg === '--message') {
      if (mode) usage('choose only one of --stdin or --message')
      mode = 'message'; message = value(args, i, arg); i++; continue
    }
    usage(`unknown option: ${arg}`)
  }
  const pendingGates = pendingValue === null ? null
    : pendingValue.toLowerCase() === 'none' ? []
      : pendingValue.split(',').map(item => item.trim()).filter(Boolean)
  return { taskId, requestId, text: mode ? readText(mode, message).trim() : '', pendingGates }
}

requireSession()
const args = process.argv.slice(2)
const command = args.shift()
if (!command || command === '--help' || command === '-h') usage()

try {
  if (command === 'context') {
    if (args.some(arg => arg !== '--json')) usage('context accepts only --json')
    output((await request('/team/context')).context)
  } else if (command === 'peers') {
    if (args.some(arg => arg !== '--json')) usage('peers accepts only --json')
    output((await request('/team/peers')).peers)
  } else if (command === 'inbox') {
    let limit = 100
    let after = null
    let cursor = null
    let active = false
    let target = null
    let status = null
    let since = null
    let page = false
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue
      if (args[i] === '--active') { active = true; continue }
      if (args[i] === '--page') { page = true; continue }
      if (args[i] === '--limit') { limit = Number(value(args, i, args[i])); i++; continue }
      if (args[i] === '--after') { after = value(args, i, args[i]); i++; continue }
      if (args[i] === '--cursor') { cursor = value(args, i, args[i]); i++; continue }
      if (args[i] === '--target') { target = value(args, i, args[i]); i++; continue }
      if (args[i] === '--status') { status = value(args, i, args[i]); i++; continue }
      if (args[i] === '--since') { since = value(args, i, args[i]); i++; continue }
      usage(`unknown inbox option: ${args[i]}`)
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) usage('--limit must be an integer from 1 to 200')
    if (after && (cursor || active || target || status || since)) usage('--after is the legacy new-items cursor and cannot be combined with inbox filters or --cursor')
    const params = new URLSearchParams({ limit: String(limit) })
    if (after) params.set('after', after)
    if (cursor) params.set('cursor', cursor)
    if (active) params.set('active', 'true')
    if (target) params.set('target', target)
    if (status) params.set('status', status)
    if (since) params.set('since', since)
    const result = await request(`/team/inbox?${params}`)
    output(page ? { tasks: result.tasks, nextCursor: result.nextCursor || null } : result.tasks)
  } else if (command === 'send') {
    const parsed = commonMessageArgs(args)
    if (!parsed.to || !parsed.text) usage('send requires --to and either --stdin or --message')
    const result = await mutate('/team/send', {
      to: parsed.to, text: parsed.text, paths: [], requestId: parsed.requestId,
    })
    output(result.task)
  } else if (command === 'send-file') {
    const parsed = commonMessageArgs(args, { files: true })
    if (Boolean(parsed.to) === Boolean(parsed.taskId)) usage('send-file requires exactly one of --to or --task')
    const requestId = parsed.requestId || crypto.randomUUID()
    const body = { text: parsed.text, paths: parsed.paths, requestId }
    try {
      const result = parsed.to
        ? await mutate('/team/send', { ...body, to: parsed.to }, { timeout: 10 * 60_000 })
        : await mutate('/team/reply', { ...body, taskId: parsed.taskId }, { timeout: 10 * 60_000 })
      output(result.task || result.reply)
    } catch (error) {
      throw error
    }
  } else if (command === 'reply') {
    const parsed = commonMessageArgs(args)
    if (!parsed.taskId || !parsed.text) usage('reply requires --task and either --stdin or --message')
    const result = await mutate('/team/reply', {
      taskId: parsed.taskId, text: parsed.text, paths: [], requestId: parsed.requestId,
    })
    output(result.reply)
  } else if (command === 'checkpoint') {
    const parsed = taskRequestArgs(args, { text: true, pending: true })
    if (!parsed.taskId || !parsed.text || parsed.pendingGates === null) {
      usage('checkpoint requires --task, --pending GATE[,GATE]|none, and either --stdin or --message')
    }
    const result = await mutate('/team/checkpoint', {
      taskId: parsed.taskId, text: parsed.text, pendingGates: parsed.pendingGates,
      requestId: parsed.requestId,
    })
    output(result.reply)
  } else if (command === 'complete') {
    const parsed = taskRequestArgs(args, { text: true })
    if (!parsed.taskId || !parsed.text) usage('complete requires --task and either --stdin or --message')
    const result = await mutate('/team/complete', {
      taskId: parsed.taskId, text: parsed.text, requestId: parsed.requestId,
    })
    output(result.task)
  } else if (command === 'release') {
    const parsed = taskRequestArgs(args)
    if (!parsed.taskId) usage('release requires --task')
    const result = await mutate('/team/release', {
      taskId: parsed.taskId, requestId: parsed.requestId,
    })
    output(result.task)
  } else if (command === 'continue') {
    const parsed = taskRequestArgs(args, { text: true })
    if (!parsed.taskId || !parsed.text) usage('continue requires --task and either --stdin or --message')
    const result = await mutate('/team/continue', {
      taskId: parsed.taskId, text: parsed.text, requestId: parsed.requestId,
    })
    output(result.task)
  } else if (command === 'message' || command === 'replace') {
    const parsed = commonMessageArgs(args)
    if (!parsed.taskId || !parsed.text) usage(`${command} requires --task and either --stdin or --message`)
    const result = await mutate(`/team/${command}`, {
      taskId: parsed.taskId, text: parsed.text, requestId: parsed.requestId,
    })
    output(result.message || result.task)
  } else if (command === 'cancel') {
    let taskId = null
    let reason = 'Cancelled by the coordinator.'
    let requestId = null
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--task') { taskId = value(args, i, args[i]); i++; continue }
      if (args[i] === '--reason') { reason = value(args, i, args[i]); i++; continue }
      if (args[i] === '--request-id') { requestId = value(args, i, args[i]); i++; continue }
      usage(`unknown cancel option: ${args[i]}`)
    }
    if (!taskId) usage('cancel requires --task')
    const result = await mutate('/team/cancel', { taskId, reason, requestId })
    output(result.task)
  } else if (command === 'mutation') {
    const parsed = taskRequestArgs(args)
    if (!parsed.requestId) usage('mutation requires --request-id')
    const params = new URLSearchParams()
    if (parsed.taskId) params.set('taskId', parsed.taskId)
    const suffix = params.size ? `?${params}` : ''
    output((await request(`/team/mutations/${encodeURIComponent(parsed.requestId)}${suffix}`)).mutation)
  } else if (command === 'mode') {
    if (args.length !== 1 || !['active', 'draining'].includes(args[0])) usage('mode requires active or draining')
    output(await request('/team/mode', { method: 'POST', body: { mode: args[0] } }))
  } else if (command === 'wait') {
    let taskId = null
    let timeoutSeconds = 3600
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue
      if (args[i] === '--task') { taskId = value(args, i, args[i]); i++; continue }
      if (args[i] === '--timeout') { timeoutSeconds = Number(value(args, i, args[i])); i++; continue }
      usage(`unknown wait option: ${args[i]}`)
    }
    if (!taskId) usage('wait requires --task')
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 43200) usage('--timeout must be from 1 to 43200 seconds')
    const deadline = Date.now() + timeoutSeconds * 1000
    let task
    do {
      task = (await request(`/team/tasks/${encodeURIComponent(taskId)}`)).task
      // `awaiting_release` is actionable, not merely intermediate: only this
      // coordinator turn can inspect the report and issue the explicit release.
      // Blocking here would consume that authority until the wait timed out.
      if (['awaiting_release', 'completed', 'completed_with_warning', 'failed', 'cancelled'].includes(task.status)) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    } while (Date.now() < deadline)
    if (!task || !['awaiting_release', 'completed', 'completed_with_warning', 'failed', 'cancelled'].includes(task.status)) {
      throw Object.assign(new Error(`timed out waiting for ${taskId}; the task remains active`), { exitCode: 1 })
    }
    output(task)
    if (!['awaiting_release', 'completed', 'completed_with_warning'].includes(task.status)) process.exitCode = 1
  } else usage(`unknown command: ${command}`)
} catch (error) {
  process.stderr.write(`sab team: ${error?.message || error}\n`)
  process.exitCode = error?.exitCode || 1
}
