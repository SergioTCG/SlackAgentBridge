import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { readClaudeOAuth, refreshInactiveClaudeProfile, verifyClaudeProfileSignIn, claudeLoginSignedOut } from '../daemon/account-claude-auth.mjs'
import { prepareClaudeProfile } from '../daemon/account-profiles.mjs'

// A fake `claude`: records how it was started, and lets each test decide what
// the stored login looks like once it runs or once its input is closed.
function fakeClaude({ onStart = () => {}, onEnd = () => {}, startError = null, exitOnEnd = true, ignoreTerm = false } = {}) {
  const runs = []
  const spawnClaude = (command, args, options) => {
    const child = new EventEmitter()
    const run = { command, args, options, ended: false, signals: [] }
    runs.push(run)
    const exit = () => setImmediate(() => child.emit('exit', 0, null))
    child.stdin = { end: () => { run.ended = true; onEnd(run); if (exitOnEnd) exit() }, on: () => {} }
    child.kill = signal => { run.signals.push(signal); if (signal === 'SIGKILL' || !ignoreTerm) exit(); return true }
    setImmediate(() => {
      if (startError) return child.emit('error', startError)
      child.emit('spawn'); onStart(run, child)
    })
    return child
  }
  return { spawnClaude, runs }
}

// Waiting advances a test clock, so a renewal's full minute passes at once.
function testClock(start = 2000) {
  let t = start
  return { now: () => t, wait: ms => new Promise(resolve => setImmediate(() => { t += ms; resolve() })) }
}

const expired = { accessToken: 'OLD-PRIVATE', refreshToken: 'ROTATING-PRIVATE', scopes: ['user:profile', 'user:inference'], expiresAt: 1000 }
const renewed = { ...expired, accessToken: 'NEW-PRIVATE', refreshToken: 'NEXT-PRIVATE', expiresAt: 29000000 }
const emptied = { ...expired, accessToken: '', refreshToken: '', expiresAt: 0 }
// Like the real reader: an emptied login is returned only when asked for.
const storedLogin = get => async ({ requireToken = true } = {}) => {
  const login = get()
  if (requireToken && !login.accessToken) throw new Error('credential_unavailable')
  return login
}

function profileFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
  const directory = prepareClaudeProfile(root, 'second', { nativeHome })
  return { root, directory, lease: path.join(directory, '.sab-auth-operation') }
}

test('an idle Claude profile is renewed by Claude itself, started without a prompt and with nothing but the profile', async () => {
  const { root, directory, lease } = profileFixture('sab-auth-renew-')
  try {
    let login = expired
    const claude = fakeClaude({ onStart: () => { login = renewed } })
    const options = { configDir: root, profile: 'second', ...testClock(), isInactive: async () => true,
      readOAuth: storedLogin(() => login), spawnClaude: claude.spawnClaude,
      env: { HOME: root, USER: 'fixture', PATH: '/usr/bin:/bin', CCS_BRIDGE: '1', SLACK_BOT_TOKEN: 'NO', ANTHROPIC_API_KEY: 'NO' } }
    assert.equal((await refreshInactiveClaudeProfile(options)).accessToken, 'NEW-PRIVATE')
    assert.equal(claude.runs.length, 1)
    const [run] = claude.runs
    assert.equal(run.command, 'claude')
    assert.deepEqual(run.args, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--no-session-persistence'])
    assert.equal(run.options.cwd, directory)
    assert.deepEqual(run.options.stdio, ['pipe', 'ignore', 'ignore'])
    // No token in its environment, and none of the bridge's identity.
    assert.deepEqual(run.options.env, { HOME: root, USER: 'fixture', PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: directory,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    assert.ok(run.ended, 'its input is closed once the login is renewed')
    assert.deepEqual(run.signals, [])
    assert.equal(fs.existsSync(lease), false)
    // A profile in use is left to the sessions using it.
    login = expired
    await assert.rejects(refreshInactiveClaudeProfile({ ...options, isInactive: async () => false }), /credential_unavailable/)
    assert.equal(claude.runs.length, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a login the provider refused, which Claude then emptied, reads needs-login and keeps its lease', async () => {
  const { root, lease } = profileFixture('sab-auth-refused-')
  try {
    let login = expired
    const claude = fakeClaude({ onStart: () => { login = emptied } })
    const options = { configDir: root, profile: 'second', ...testClock(), isInactive: async () => true,
      readOAuth: storedLogin(() => login), spawnClaude: claude.spawnClaude }
    const needsLogin = error => error.message === 'account_needs_login' && error.renewalFailure === 'rejected'
    await assert.rejects(refreshInactiveClaudeProfile(options), needsLogin)
    // The kept lease answers later readings; Claude is not started again.
    login = expired
    await assert.rejects(refreshInactiveClaudeProfile(options), needsLogin)
    assert.equal(claude.runs.length, 1)
    assert.ok(claude.runs[0].ended)
    assert.equal(JSON.parse(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8')).reason, 'rejected')
    assert.equal(JSON.parse(fs.readFileSync(path.join(lease, 'owner.json'), 'utf8')).purpose, 'renewal')
    for (const name of fs.readdirSync(lease)) assert.doesNotMatch(fs.readFileSync(path.join(lease, name), 'utf8'), /PRIVATE/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a renewal Claude did not confirm releases its lease, so the next reading tries again', async () => {
  const { root, lease } = profileFixture('sab-auth-unconfirmed-')
  try {
    const base = { configDir: root, profile: 'second', isInactive: async () => true, readOAuth: storedLogin(() => expired) }
    // Nothing changed within a minute.
    const slow = fakeClaude(), clock = testClock()
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, ...clock, spawnClaude: slow.spawnClaude }), /account_renewal_unconfirmed/)
    assert.ok(clock.now() >= 62000, 'it waited the full minute')
    assert.ok(slow.runs[0].ended)
    assert.equal(fs.existsSync(lease), false)
    // A Claude that exits by itself ends the wait at once.
    const early = fakeClaude({ onStart: (run, child) => setImmediate(() => child.emit('exit', 1, null)) }), soon = testClock()
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, ...soon, spawnClaude: early.spawnClaude }), /account_renewal_unconfirmed/)
    assert.ok(soon.now() < 5000)
    assert.equal(fs.existsSync(lease), false)
    // One that ignores its closed input and SIGTERM is killed.
    const stuck = fakeClaude({ exitOnEnd: false, ignoreTerm: true })
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, ...testClock(), spawnClaude: stuck.spawnClaude }), /account_renewal_unconfirmed/)
    assert.deepEqual(stuck.runs[0].signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(fs.existsSync(lease), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a login Claude saves while it is being stopped still counts as renewed', async () => {
  const { root, lease } = profileFixture('sab-auth-late-')
  try {
    let login = expired
    const claude = fakeClaude({ onEnd: () => { login = renewed } })
    const result = await refreshInactiveClaudeProfile({ configDir: root, profile: 'second', ...testClock(), isInactive: async () => true,
      readOAuth: storedLogin(() => login), spawnClaude: claude.spawnClaude })
    assert.equal(result.accessToken, 'NEW-PRIVATE')
    assert.equal(fs.existsSync(lease), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a renewal that never reached Claude spends nothing and releases its lease', async () => {
  const { root, lease } = profileFixture('sab-auth-before-start-')
  try {
    const claude = fakeClaude()
    const base = { configDir: root, profile: 'second', ...testClock(), spawnClaude: claude.spawnClaude }
    let checks = 0
    // The profile came into use between the two checks.
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, readOAuth: storedLogin(() => expired), isInactive: async () => ++checks === 1 }),
      /credential_unavailable/)
    // The credential store stopped answering.
    let reads = 0
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, isInactive: async () => true,
      readOAuth: async () => { if (++reads > 1) throw new Error('keychain timeout'); return expired } }), /keychain timeout/)
    // There is no refresh token to renew with.
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, isInactive: async () => true,
      readOAuth: storedLogin(() => ({ ...expired, refreshToken: '' })) }), /credential_unavailable/)
    assert.equal(claude.runs.length, 0)
    // `claude` could not be started.
    const missing = fakeClaude({ startError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) })
    await assert.rejects(refreshInactiveClaudeProfile({ ...base, isInactive: async () => true, readOAuth: storedLogin(() => expired),
      spawnClaude: missing.spawnClaude }), /credential_unavailable/)
    assert.equal(missing.runs.length, 1)
    assert.equal(fs.existsSync(lease), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Claude private file fallback is scoped to its exact config directory, with no global credential fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-read-'))
  try {
    const file = path.join(root, '.credentials.json')
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'PRIVATE' } }), { mode: 0o600 })
    assert.equal((await readClaudeOAuth({ directory: root, platform: 'linux' })).accessToken, 'PRIVATE')
    // A login Claude emptied is returned only to a reader that asks for it.
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }), { mode: 0o600 })
    await assert.rejects(readClaudeOAuth({ directory: root, platform: 'linux' }), /credential_unavailable/)
    assert.equal((await readClaudeOAuth({ directory: root, platform: 'linux', requireToken: false })).refreshToken, '')
    fs.chmodSync(file, 0o644)
    await assert.rejects(readClaudeOAuth({ directory: root, platform: 'linux' }))
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

test('only a login Claude emptied after a refused renewal reads as signed out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-auth-signed-out-'))
  try {
    const file = path.join(root, '.credentials.json')
    const store = oauth => fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }), { mode: 0o600 })
    const signedOut = () => claudeLoginSignedOut({ directory: root, platform: 'linux' })
    assert.equal(await signedOut(), false, 'no stored login at all')
    store({ accessToken: 'PRIVATE', refreshToken: 'PRIVATE-REFRESH', expiresAt: 1 })
    assert.equal(await signedOut(), false, 'an expired login can still be renewed')
    store({ accessToken: 'PRIVATE' })
    assert.equal(await signedOut(), false, 'a login without a refresh token')
    store({ accessToken: '', refreshToken: '', expiresAt: 0 })
    assert.equal(await signedOut(), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
