import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readClaudeOAuth, refreshInactiveClaudeProfile, verifyClaudeProfileSignIn } from '../daemon/account-claude-auth.mjs'
import { prepareClaudeProfile } from '../daemon/account-profiles.mjs'

test('inactive Claude OAuth profile refresh uses native auth only, with isolated stores and no token argv', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-refresh-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareClaudeProfile(root, 'second', { nativeHome })
    let refreshed = false, calls = 0
    const readOAuth = async () => ({ accessToken: refreshed ? 'NEW-PRIVATE' : 'OLD-PRIVATE', refreshToken: 'REFRESH-PRIVATE',
      scopes: ['user:profile', 'user:inference'], expiresAt: refreshed ? 100000 : 1000 })
    const options = { configDir: root, profile: 'second', now: () => 2000, readOAuth, isInactive: async () => true,
      env: { HOME: root, USER: 'fixture', PATH: '/usr/bin:/bin', CCS_BRIDGE: '1', SLACK_BOT_TOKEN: 'NO', ANTHROPIC_API_KEY: 'NO' },
      execCredential: async (command, args, opts) => {
        calls++; assert.equal(command, 'claude'); assert.deepEqual(args, ['auth', 'login'])
        assert.equal(opts.env.CLAUDE_CONFIG_DIR, directory)
        assert.equal(opts.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, 'REFRESH-PRIVATE')
        assert.equal(opts.env.CCS_BRIDGE, undefined); assert.equal(opts.env.SLACK_BOT_TOKEN, undefined)
        assert.equal(opts.env.ANTHROPIC_API_KEY, undefined); refreshed = true
      } }
    assert.equal((await refreshInactiveClaudeProfile(options)).accessToken, 'NEW-PRIVATE')
    assert.equal(calls, 1)
    refreshed = false
    await assert.rejects(refreshInactiveClaudeProfile({ ...options, isInactive: async () => false }), /credential_unavailable/)
    assert.equal(calls, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Claude private file fallback is scoped to its exact config directory, with no global credential fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-read-'))
  try {
    const file = path.join(root, '.credentials.json')
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'PRIVATE' } }), { mode: 0o600 })
    assert.equal((await readClaudeOAuth({ directory: root, platform: 'linux' })).accessToken, 'PRIVATE')
    fs.chmodSync(file, 0o644)
    await assert.rejects(readClaudeOAuth({ directory: root, platform: 'linux' }))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('uncertain native refresh is never retried with a potentially rotated token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-uncertain-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    prepareClaudeProfile(root, 'second', { nativeHome })
    let calls = 0
    const options = { configDir: root, profile: 'second', now: () => 2000, isInactive: async () => true,
      readOAuth: async () => ({ accessToken: 'PRIVATE', refreshToken: 'ROTATING-PRIVATE', scopes: ['user:profile'], expiresAt: 1000 }),
      execCredential: async () => { calls++; throw new Error('ROTATING-PRIVATE') } }
    const needsLogin = error => error.message === 'account_needs_login' && error.renewalFailure === 'failed'
    await assert.rejects(refreshInactiveClaudeProfile(options), needsLogin)
    await assert.rejects(refreshInactiveClaudeProfile(options), needsLogin)
    assert.equal(calls, 1)
    const lease = path.join(root, 'account-auth/claude/second/.sab-auth-operation')
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8'))).sort(), ['at', 'reason'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(lease, 'owner.json'), 'utf8')).purpose, 'renewal')
    for (const name of fs.readdirSync(lease)) assert.doesNotMatch(fs.readFileSync(path.join(lease, name), 'utf8'), /PRIVATE/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a renewal gets a closed input and half a minute; its failure keeps only a reason code, and a saved token still counts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-renewal-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const lease = path.join(prepareClaudeProfile(root, 'second', { nativeHome }), '.sab-auth-operation')
    let ended = 0
    const expired = { accessToken: 'PRIVATE', refreshToken: 'ROTATING-PRIVATE', scopes: ['user:profile'], expiresAt: 1000 }
    const options = { configDir: root, profile: 'second', now: () => 2000, isInactive: async () => true, readOAuth: async () => expired }
    const attempt = failure => ({ ...options, execCredential: (command, args, opts) => {
      assert.equal(opts.timeout, 30000)
      const run = failure ? Promise.reject(failure) : Promise.resolve({ stdout: '', stderr: '' })
      run.child = { stdin: { end: () => { ended++ } } }
      return run
    } })
    const reasons = [
      [Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), 'timeout'],
      [Object.assign(new Error('exit 1'), { code: 1, stderr: 'Login failed: Request failed with status code 400 ROTATING-PRIVATE' }), 'rejected'],
      [Object.assign(new Error('exit 1'), { code: 1, stderr: 'unexpected' }), 'failed'],
      [null, 'not-renewed'],
    ]
    for (const [failure, reason] of reasons) {
      await assert.rejects(refreshInactiveClaudeProfile(attempt(failure)), error => error.message === 'account_needs_login' && error.renewalFailure === reason)
      assert.equal(JSON.parse(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8')).reason, reason)
      assert.doesNotMatch(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8'), /PRIVATE|status code/)
      fs.rmSync(lease, { recursive: true })
    }
    assert.equal(ended, reasons.length, 'every renewal closes its input')
    // Stopped after Claude saved the new token: renewed, and the lease is released.
    let reads = 0
    const renewed = await refreshInactiveClaudeProfile({ ...attempt(Object.assign(new Error('killed'), { killed: true })),
      readOAuth: async () => ++reads < 3 ? expired : { ...expired, accessToken: 'NEW-PRIVATE', expiresAt: 900000 } })
    assert.equal(renewed.accessToken, 'NEW-PRIVATE')
    assert.equal(fs.existsSync(lease), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a renewal that fails before the token exchange spends nothing and releases its lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-before-exchange-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const lease = path.join(prepareClaudeProfile(root, 'second', { nativeHome }), '.sab-auth-operation')
    const expired = { accessToken: 'PRIVATE', refreshToken: 'ROTATING-PRIVATE', scopes: ['user:profile'], expiresAt: 1000 }
    let calls = 0
    const base = { configDir: root, profile: 'second', now: () => 2000, execCredential: async () => { calls++ } }
    let checks = 0
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, readOAuth: async () => expired, isInactive: async () => ++checks === 1 }), /credential_unavailable/)
    let reads = 0
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, isInactive: async () => true,
      readOAuth: async () => { if (++reads > 1) throw new Error('keychain timeout'); return expired } }), /keychain timeout/)
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, isInactive: async () => true, readOAuth: async () => ({ ...expired, scopes: [] }) }),
      /credential_unavailable/)
    assert.equal(calls, 0)
    // A `claude` that never started spent nothing either.
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, isInactive: async () => true, readOAuth: async () => expired,
      execCredential: async () => { calls++; throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) } }), /credential_unavailable/)
    assert.equal(calls, 1)
    assert.equal(fs.existsSync(lease), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an owner sign-in counts only with a fresh credential for the account the profile belongs to', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-verify-'))
  try {
    const config = email => fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }), { mode: 0o600 })
    const fresh = async () => ({ accessToken: 'PRIVATE', expiresAt: 900000 })
    const options = { directory: root, now: () => 2000, readOAuth: fresh }
    config('Owner@Example.test')
    assert.equal(await verifyClaudeProfileSignIn({ ...options, expectedEmail: 'owner@example.test' }), 'ok')
    assert.equal(await verifyClaudeProfileSignIn(options), 'ok', 'a new enrollment has no account to match yet')
    config('other@example.test')
    assert.equal(await verifyClaudeProfileSignIn({ ...options, expectedEmail: 'owner@example.test' }), 'wrong-account')
    fs.chmodSync(path.join(root, '.claude.json'), 0o644)
    assert.equal(await verifyClaudeProfileSignIn({ ...options, expectedEmail: 'other@example.test' }), 'ok', 'Claude keeps an older, wider mode')
    fs.writeFileSync(path.join(root, '.claude.json'), '{}')
    assert.equal(await verifyClaudeProfileSignIn({ ...options, expectedEmail: 'owner@example.test' }), 'not-signed-in')
    assert.equal(await verifyClaudeProfileSignIn({ ...options, readOAuth: async () => ({ accessToken: 'PRIVATE', expiresAt: 1000 }) }), 'not-signed-in')
    assert.equal(await verifyClaudeProfileSignIn({ ...options, readOAuth: async () => { throw new Error('none') } }), 'not-signed-in')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
