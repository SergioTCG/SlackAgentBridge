#!/usr/bin/env node
// JSON-safe owner-machine client. No credentials in argv or caller-selected URL
// beyond a validated loopback daemon. Request IDs make ambiguous retries safe.
const args = process.argv.slice(2), json = args.includes('--json')
const fail = () => { throw new Error('invalid_account_pool_command') }
try {
  const action = args.shift(), options = {}
  const fields = { status: ['--channel'], refresh: ['--account'], switch: ['--channel', '--session', '--account', '--request-id', '--preserve-task'], reconcile: ['--channel', '--session', '--request-id'] }
  if (!Object.hasOwn(fields, action)) fail()
  while (args.length) {
    const flag = args.shift()
    if (Object.hasOwn(options, flag) || (flag !== '--json' && !fields[action].includes(flag))) fail()
    options[flag] = flag === '--json' ? true : args.shift()
    if (typeof options[flag] !== 'string' && flag !== '--json') fail()
  }
  if (fields[action].filter(flag => flag !== '--preserve-task').some(flag => !options[flag])) fail()
  const base = new URL(process.env.SAB_ACCOUNT_URL || 'http://127.0.0.1:8877')
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail()
  const url = new URL(`/account-pools/${action}`, base)
  let body
  if (action === 'status') url.searchParams.set('channel', options['--channel'])
  else if (action === 'refresh') body = { account: options['--account'] }
  else body = { channel: options['--channel'], session: options['--session'], ...(action === 'switch' ? { account: options['--account'],
    ...(options['--preserve-task'] ? { preserveTask: options['--preserve-task'] } : {}) } : {}), requestId: options['--request-id'] }
  const response = await fetch(url, { method: action === 'status' ? 'GET' : 'POST', redirect: 'error',
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) })
  const payload = await response.json()
  if (json) process.stdout.write(JSON.stringify(payload) + '\n')
  else process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  if (!response.ok) process.exitCode = 1
} catch {
  const message = 'Account pool request failed. Check the daemon mode, command arguments, and exact session. After a switch timeout, query status with the same channel/request ID before retrying.'
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: 'account_pool_client_failed', message }) + '\n')
  else process.stderr.write(`sab account pool: ${message}\n`)
  process.exitCode = 2
}
