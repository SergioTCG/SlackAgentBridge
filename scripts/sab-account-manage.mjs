#!/usr/bin/env node
// Owner-machine JSON client; never asks an agent to construct curl payloads.
import fs from 'node:fs'
const args = process.argv.slice(2), json = args.includes('--json')
try {
  const kind = args.shift(), options = {}, positional = []
  while (args.length) {
    const arg = args.shift()
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    if (!['--json', '--input', '--revision', '--request-id', '--member'].includes(arg) || options[arg] && arg !== '--member') throw new Error()
    if (arg === '--member') (options[arg] ||= []).push(args.shift())
    else options[arg] = arg === '--json' ? true : args.shift()
  }
  const base = new URL(process.env.SAB_ACCOUNT_URL || 'http://127.0.0.1:8877')
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error()
  let body, endpoint = 'manage'
  if (kind === 'manage') {
    if (positional.length || !options['--input']) throw new Error()
    const source = options['--input'] === '-' ? process.stdin : fs.createReadStream(options['--input'])
    let text = ''
    for await (const chunk of source) { text += chunk; if (Buffer.byteLength(text) > 8192) throw new Error() }
    body = JSON.parse(text)
  } else if (kind === 'group') {
    const [action, group, value, extra] = positional
    if (extra) throw new Error()
    if (action === 'list' && !group) endpoint = 'inventory'
    else {
      const common = { group, account: value }
      let operation
      if (action === 'create') operation = { type: 'group-create', key: group, name: value, members: options['--member'] || [] }
      else if (action === 'rename') operation = { type: 'group-rename', group, name: value }
      else if (action === 'remove' && !value) operation = { type: 'group-remove', group }
      else if (['add', 'delete-member', 'drain-member', 'prefer'].includes(action)) operation = { type: `group-${action}`, ...common }
      else throw new Error()
      if (!/^[1-9][0-9]{0,3}$/.test(options['--revision'] || '') || !options['--request-id']) throw new Error()
      body = { operation, expectedRevision: Number(options['--revision']), requestId: options['--request-id'] }
    }
  } else throw new Error()
  const response = await fetch(new URL(`/account-pools/${endpoint}`, base), { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  process.stdout.write(JSON.stringify(result, null, json ? 0 : 2) + '\n')
  if (!response.ok) process.exitCode = 1
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: 'account_management_client_failed', message: 'Check arguments, enabled daemon mode, expected revision, and request ID. Query group list before retrying an uncertain edit.' }) + '\n')
  process.exitCode = 2
}
