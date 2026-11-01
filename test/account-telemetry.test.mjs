import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readAccountIdentity, readAccountQuota, verifyClaudeLaunchIdentity, probeCodexAccount, quotaProbeEnvironment } from '../daemon/account-telemetry.mjs'
import { prepareClaudeProfile, prepareCodexProfile, withAccountProfileLease, recordProfileLeaseFailure } from '../daemon/account-profiles.mjs'

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

test('a profile whose renewal failed reads needs-login with its reason; one still renewing stays credential-unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-telemetry-needs-login-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareClaudeProfile(root, 'second', { nativeHome })
    const account = { ...claude, credentials: [{ kind: 'claude-profile', profile: 'second' }] }
    const options = { configDir: root, now: () => now, isProfileInactive: async () => true,
      fetchImpl: async () => { throw new Error('must not call the provider') } }
    await withAccountProfileLease(directory, async () => {
      assert.deepEqual(await readAccountQuota(account, options), { provider: 'claude', observedAt: now, status: 'credential-unavailable', windows: [] })
    })
    await assert.rejects(withAccountProfileLease(directory, async lease => { recordProfileLeaseFailure(lease, 'rejected'); throw new Error('spent') },
      { retainOnFailure: true }))
    assert.deepEqual(await readAccountQuota(account, options),
      { provider: 'claude', observedAt: now, status: 'needs-login', windows: [], reason: 'rejected' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a renewal Claude did not confirm reads credential-unavailable with its reason, not needs-login', async () => {
  const result = await readAccountQuota(claude, { now: () => now,
    resolveCredential: async () => { throw new Error('account_renewal_unconfirmed') },
    fetchImpl: async () => { throw new Error('must not call the provider') } })
  assert.deepEqual(result, { provider: 'claude', observedAt: now, status: 'credential-unavailable', windows: [], reason: 'not-renewed' })
})

test('a managed Codex probe that ran and failed keeps its lease as needs-login; one stopped before it releases the lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-telemetry-codex-lease-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareCodexProfile(root, 'cx', { nativeHome }), lease = path.join(directory, '.sab-auth-operation')
    fs.writeFileSync(path.join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: 'acct' } }), { mode: 0o600 })
    const account = { ...codex, credentials: [{ kind: 'codex-profile', profile: 'cx' }] }
    let probes = 0, checks = 0, refreshRequested = false
    const codexProbe = async () => { probes++; throw Object.assign(new Error('provider-unavailable'), { refreshRequested }) }
    const stopped = await readAccountQuota(account, { configDir: root, now: () => now, codexProbe, isProfileInactive: async () => ++checks === 1 })
    assert.notEqual(stopped.status, 'needs-login')
    assert.equal(probes, 0)
    assert.equal(fs.existsSync(lease), false)
    const unstarted = await readAccountQuota(account, { configDir: root, now: () => now, codexProbe, isProfileInactive: async () => true })
    assert.equal(unstarted.status, 'provider-unavailable', 'a probe that never asked for a refresh spent nothing')
    assert.equal(fs.existsSync(lease), false)
    refreshRequested = true; probes = 0
    const failed = await readAccountQuota(account, { configDir: root, now: () => now, codexProbe, isProfileInactive: async () => true })
    assert.deepEqual(failed, { provider: 'codex', observedAt: now, status: 'needs-login', windows: [], reason: 'failed' })
    assert.equal(probes, 1)
    assert.deepEqual(await readAccountQuota(account, { configDir: root, now: () => now, codexProbe, isProfileInactive: async () => true }), failed)
    assert.equal(probes, 1, 'nothing probes the possibly rotated token again')
    for (const name of fs.readdirSync(lease)) assert.doesNotMatch(fs.readFileSync(path.join(lease, name), 'utf8'), /PRIVATE/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('the Codex probe says whether a refresh may have been spent when it failed', async () => {
  const fixture = ({ failing = null, starts = true } = {}) => () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); return true }
    child.stdin = new Writable({ write(chunk, encoding, callback) {
      const msg = JSON.parse(chunk.toString())
      if (msg.id) queueMicrotask(() => child.stdout.write(JSON.stringify(msg.method === failing
        ? { id: msg.id, error: { code: -1, message: 'no' } } : { id: msg.id, result: {} }) + '\n'))
      callback()
    } })
    queueMicrotask(() => starts ? child.emit('spawn') : child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })))
    return child
  }
  const managed = { managedHome: '/fixture/managed' }
  const tagged = expected => error => error.message === 'provider-unavailable' && error.refreshRequested === expected
  await assert.rejects(probeCodexAccount(null, { ...managed, spawnChild: fixture({ starts: false }) }), tagged(false), 'a child that never started')
  await assert.rejects(probeCodexAccount(null, { ...managed, spawnChild: fixture({ failing: 'initialize' }) }), tagged(true),
    'a running Codex may refresh on any authenticated call')
  await assert.rejects(probeCodexAccount(null, { ...managed, spawnChild: fixture({ failing: 'account/read' }) }), tagged(true))
  await assert.rejects(probeCodexAccount(null, { ...managed, spawnChild: fixture({ failing: 'account/rateLimits/read' }) }), tagged(false),
    'the refresh had already finished')
  await assert.rejects(probeCodexAccount({ accessToken: token, principalId: 'acct' }, { spawnChild: fixture({ failing: 'account/read' }) }),
    tagged(false), 'an unmanaged probe never refreshes')
})
