import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readAccountIdentity, readAccountQuota, verifyClaudeLaunchIdentity, probeCodexAccount, quotaProbeEnvironment } from '../daemon/account-telemetry.mjs'

const token = 'PRIVATE-TEST-TOKEN-DO-NOT-OUTPUT'
const now = 1800000000000
const claude = { id: 'acct_fixture', provider: 'claude', email: 'owner@example.test', workspaceId: null,
  credentials: [{ kind: 'native-default' }] }
const codex = { ...claude, provider: 'codex' }
const usage = { five_hour: { utilization: 12, resets_at: new Date(now + 3600000).toISOString() },
  seven_day: { utilization: 33, resets_at: new Date(now + 86400000).toISOString() } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

test('Claude monitoring verifies actual email/principal and fetches only profile plus quota, never inference', async () => {
  const requests = []
  const result = await readAccountQuota(claude, { now: () => now,
    resolveCredential: async () => ({ accessToken: token }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return url.endsWith('/profile') ? json({ email: claude.email, account: { uuid: 'principal-one' }, organization: { uuid: 'org-one' }, token }) : json(usage)
    },
  })
  assert.equal(result.status, 'observed')
  assert.equal(result.windows.length, 2)
  assert.equal(result.identity.principalId, 'org-one')
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/api/oauth/profile', '/api/oauth/usage'])
  assert.ok(requests.every(r => r.options.method === 'GET' && r.options.redirect === 'error'))
  assert.ok(requests.every(r => r.options.headers.Authorization === `Bearer ${token}`))
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-TEST|token/)
})

test('handover identity proof reads the actual selected credential, not the expected registry email', async () => {
  const options = { configDir: '/fixture', execCredential: async () => ({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: now + 999999 } }) }),
    resolveCredential: async () => ({ accessToken: token }),
    env: { HOME: '/fixture', USER: 'fixture' }, now: () => now,
    fetchImpl: async () => json({ account: { email: 'wrong@example.test' }, organization: { uuid: 'org' } }) }
  assert.equal(await readAccountIdentity(claude, options), 'identity-mismatch')
  assert.equal(await readAccountIdentity(claude, { ...options, fetchImpl: async () => json({ account: { email: claude.email }, organization: { uuid: 'org' } }) }), 'verified')
})

test('Claude native auth resolution rejects a settings-selected login/API helper in place of the inspected OAuth account', async () => {
  const options = { cwd: '/fixture', configDir: '/fixture', env: { HOME: '/fixture', USER: 'fixture', CCS_BRIDGE: '1', ANTHROPIC_API_KEY: 'NO' },
    execCredential: async (command, args, opts) => {
      assert.deepEqual(args, ['auth', 'status', '--json'])
      assert.equal(opts.env.CCS_BRIDGE, undefined); assert.equal(opts.env.ANTHROPIC_API_KEY, undefined)
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: claude.email }) }
    } }
  assert.equal(await verifyClaudeLaunchIdentity(claude, options), true)
  assert.equal(await verifyClaudeLaunchIdentity(claude, { ...options, execCredential: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key', email: claude.email }) }) }), false)
  assert.equal(await verifyClaudeLaunchIdentity(claude, { ...options, execCredential: async () => ({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'wrong@example.test' }) }) }), false)
})

test('expired, missing-scope, throttled, and mismatched credentials remain distinct, safe failures', async () => {
  for (const [status, code] of [[401, 'needs-login'], [403, 'scope-unavailable'], [429, 'throttled'], [503, 'provider-unavailable']]) {
    const result = await readAccountQuota(claude, { now: () => now, resolveCredential: async () => ({ accessToken: token }),
      fetchImpl: async () => json({ error: token }, status) })
    assert.equal(result.status, code)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-TEST/)
  }
  const mismatch = await readAccountQuota(claude, { now: () => now, resolveCredential: async () => ({ accessToken: token }),
    fetchImpl: async () => json({ email: 'not-the-owner@example.test', organization: { uuid: 'org-other' } }) })
  assert.equal(mismatch.status, 'identity-mismatch')
  const broken = await readAccountQuota(claude, { now: () => now, resolveCredential: async () => { throw new Error(token) } })
  assert.equal(broken.status, 'credential-unavailable')
  assert.doesNotMatch(JSON.stringify(broken), /PRIVATE-TEST/)
})

test('quota response and transport failures stay bounded and never echo response fragments', async () => {
  const result = await readAccountQuota(claude, { now: () => now, resolveCredential: async () => ({ accessToken: token }),
    fetchImpl: async () => new Response(token.repeat(10000)) })
  assert.equal(result.status, 'invalid-response')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-TEST/)
})

test('native credential inspection reads private stores without refreshing or copying tokens', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-telemetry-'))
  try {
    const codeHome = path.join(root, 'codex'); fs.mkdirSync(codeHome)
    fs.writeFileSync(path.join(codeHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'NO-REFRESH', account_id: 'account-one' } }), { mode: 0o600 })
    const env = { HOME: root, USER: 'fixture', LOGNAME: 'fixture', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin', CODEX_HOME: codeHome, SLACK_BOT_TOKEN: 'SLACK-SECRET', CCS_TMUX: 'sab-live', CODEX_THREAD_ID: 'live-thread' }
    const calls = []
    const result = await readAccountQuota(codex, { env, now: () => now,
      codexProbe: async credential => {
        calls.push(credential)
        return { account: { type: 'chatgpt', email: codex.email }, limits: { accountId: 'account-one', ordinaryUsageAllowed: true,
          rateLimits: { limitId: 'codex', primary: { usedPercent: 15, resetsAt: (now + 3600000) / 1000 } } } }
      },
    })
    assert.equal(result.status, 'observed')
    assert.deepEqual(calls, [{ accessToken: token, principalId: 'account-one' }])
    assert.ok(fs.readFileSync(path.join(codeHome, 'auth.json'), 'utf8').includes('NO-REFRESH'))
    const probeEnv = quotaProbeEnvironment(path.join(root, 'probe'), env)
    assert.equal(probeEnv.USER, 'fixture')
    assert.equal(probeEnv.SLACK_BOT_TOKEN, undefined)
    assert.equal(probeEnv.CCS_TMUX, undefined)
    assert.equal(probeEnv.CODEX_THREAD_ID, undefined)
    assert.notEqual(probeEnv.CODEX_HOME, codeHome)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('named Claude credentials never fall back to machine login, including missing aliases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-named-quota-'))
  try {
    fs.writeFileSync(path.join(root, 'accounts'), `named=${token}\n`, { mode: 0o600 })
    const named = { ...claude, credentials: [{ kind: 'legacy-claude', alias: 'named' }] }
    let keychainCalls = 0
    const options = { configDir: root, now: () => now, execCredential: async () => { keychainCalls++; throw new Error('must-not-run') }, fetchImpl: async () => json({}, 403) }
    assert.equal((await readAccountQuota(named, options)).status, 'scope-unavailable')
    named.credentials[0].alias = 'missing'
    assert.equal((await readAccountQuota(named, options)).status, 'credential-unavailable')
    assert.equal(keychainCalls, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Codex quota sidecar sends only initialize, memory-only login, account/read and rateLimits/read', async () => {
  const requests = [], children = []
  const spawnChild = (command, args, options) => {
    assert.equal(command, 'codex')
    assert.ok(args.includes('cli_auth_credentials_store="ephemeral"'))
    assert.ok(!JSON.stringify(args).includes(token))
    assert.equal(options.env.SLACK_BOT_TOKEN, undefined)
    assert.equal(options.env.CCS_BRIDGE, undefined)
    assert.ok(fs.statSync(options.env.CODEX_HOME).isDirectory())
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); return true }
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString())
      requests.push(message)
      const result = message.method === 'account/read' ? { account: { type: 'chatgpt', email: codex.email } }
        : message.method === 'account/rateLimits/read' ? { accountId: 'principal-one', ordinaryUsageAllowed: true,
          rateLimits: { limitId: 'codex', primary: { usedPercent: 10, resetsAt: (now + 100000) / 1000 } } } : {}
      if (message.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'))
      callback()
    } })
    children.push({ child, options })
    return child
  }
  const result = await probeCodexAccount({ accessToken: token, principalId: 'principal-one' }, { spawnChild,
    env: { PATH: '/usr/bin:/bin', USER: 'fixture', SLACK_BOT_TOKEN: 'PRIVATE-SLACK' } })
  assert.equal(result.account.email, codex.email)
  assert.deepEqual(requests.filter(r => r.id).map(r => r.method), ['initialize', 'account/login/start', 'account/read', 'account/rateLimits/read'])
  assert.equal(requests.find(r => r.method === 'account/read').params.refreshToken, false)
  assert.ok(requests.every(r => !JSON.stringify(r).includes('refresh_token')))
  assert.ok(children[0].child.killed)
  assert.equal(fs.existsSync(children[0].options.cwd), false)
})

test('an inactive managed Codex profile lets only native auth refresh its exact file store, without external-token login', async () => {
  const requests = []
  const spawnChild = (command, args, options) => {
    assert.ok(args.includes('cli_auth_credentials_store="file"'))
    assert.equal(options.env.CODEX_HOME, '/fixture/managed-profile')
    assert.equal(options.env.CCS_BRIDGE, undefined)
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const msg = JSON.parse(chunk.toString()); requests.push(msg)
      const result = msg.method === 'account/read' ? { account: { type: 'chatgpt', email: codex.email } } : {}
      if (msg.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: msg.id, result }) + '\n'))
      callback()
    } })
    return child
  }
  await probeCodexAccount(null, { spawnChild, managedHome: '/fixture/managed-profile' })
  assert.deepEqual(requests.filter(r => r.id).map(r => r.method), ['initialize', 'account/read', 'account/rateLimits/read'])
  assert.equal(requests.find(r => r.method === 'account/read').params.refreshToken, true)
})
