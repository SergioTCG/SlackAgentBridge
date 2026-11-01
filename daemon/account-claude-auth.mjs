// Credential values remain private to this module and the no-inference reader.
// Native Claude owns refresh-token exchange and credential-store writes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { readPrivateAccountFile } from './account-registry-store.mjs'
import { claudeKeychainService, claudeProfileHome, withAccountProfileLease, recordProfileLeaseFailure, profileNeedsLogin } from './account-profiles.mjs'
const execute = promisify(execFile)
const secret = s => typeof s === 'string' && s.length > 0 && s.length <= 65536 && !/[\r\n\0]/.test(s)
const fail = () => { throw new Error('credential_unavailable') }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// Longer than Claude's own 30-second token request plus its refresh-lock retries.
const RENEWAL_WAIT_MS = 60000
const RENEWAL_POLL_MS = 500
const RENEWAL_EXIT_MS = 15000
export const RENEWAL_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--no-session-persistence']

// `requireToken: false` also returns a record Claude emptied after the provider
// refused its refresh, so a renewal can tell that apart from a slow one.
export async function readClaudeOAuth({ directory = null, env = process.env, platform = process.platform, execCredential = execute,
  requireToken = true } = {}) {
  const home = directory || path.join(env.HOME || os.homedir(), '.claude')
  let value
  if (platform === 'darwin') {
    try {
      const { stdout } = await execCredential('/usr/bin/security', ['find-generic-password', '-s', claudeKeychainService(directory), '-w'], {
        env: Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'SHELL'].filter(k => env[k]).map(k => [k, env[k]])),
        encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20,
      })
      value = JSON.parse(stdout)
    } catch { /* Claude's documented private-file fallback, same profile only. */ }
  }
  if (!value) value = readPrivateAccountFile(path.join(home, '.credentials.json'), { json: true })
  const oauth = value?.claudeAiOauth
  if (!requireToken && oauth && typeof oauth === 'object') return oauth
  if (!secret(oauth?.accessToken)) fail()
  return oauth
}

// Claude renews a profile itself: an expired login is refreshed when Claude
// starts, through the path every running session uses. That path rotates the
// refresh token and saves the new pair under Claude's own lock. SAB only starts
// Claude with no prompt, so nothing reaches the model, watches the stored
// login, and then closes Claude's input. (`claude auth login` with a refresh
// token asks for a long-lived token instead, and the login it saves cannot be
// renewed again: that path renewed a profile exactly once.)
export async function refreshInactiveClaudeProfile({ configDir, profile, isInactive, env = process.env,
  execCredential = execute, now = Date.now, readOAuth = readClaudeOAuth, spawnClaude = spawn, wait = sleep } = {}) {
  const directory = claudeProfileHome(configDir, profile)
  const read = () => readOAuth({ directory, env, execCredential })
  const existing = await read()
  if (!Number.isFinite(existing.expiresAt)) fail()
  if (existing.expiresAt > now() + 60000) return existing
  // No primary/default credential refresh and no live profile refresh. Native
  // running processes own their own rotating tokens; SAB never races them.
  if (!await isInactive(profile)) fail()
  // Only a login that Claude emptied after the provider refused it keeps the
  // lease. Anything else releases it, and the next reading tries again: Claude
  // saves a rotated token before it gives up its own lock, and a token spent
  // without being saved is refused, and so reported, next time.
  return withAccountProfileLease(directory, async lease => {
    if (!await isInactive(profile)) fail()
    const before = await read()
    if (before.expiresAt > now() + 60000) return before
    const result = await renewClaudeLogin({ directory, before, env, execCredential, now, readOAuth, spawnClaude, wait })
    if (result.outcome === 'renewed') return result.login
    if (result.outcome === 'refused') {
      recordProfileLeaseFailure(lease, 'rejected')
      throw profileNeedsLogin('rejected')
    }
    throw new Error('account_renewal_unconfirmed')
  }, { purpose: 'renewal', retainOnFailure: error => error?.message === 'account_needs_login' })
}

// One renewal by Claude itself. The caller holds the profile's lease, and
// `before` is the expired login it read under it. The outcome is `renewed`
// (with the new login), `refused` (Claude emptied the login after the provider
// refused it), or `unconfirmed`.
export async function renewClaudeLogin({ directory, before, env = process.env, execCredential = execute, now = Date.now,
  readOAuth = readClaudeOAuth, spawnClaude = spawn, wait = sleep }) {
  if (!secret(before?.refreshToken)) fail()
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'].filter(k => env[k]).map(k => [k, env[k]]))
  Object.assign(childEnv, { CLAUDE_CONFIG_DIR: directory, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const outcome = async () => {
    let record
    try { record = await readOAuth({ directory, env, execCredential, requireToken: false }) } catch { return 'unchanged' }
    if (!secret(record?.accessToken) || !secret(record?.refreshToken)) return 'refused'
    return Number.isFinite(record.expiresAt) && record.expiresAt > now() + 60000 ? 'renewed' : 'unchanged'
  }
  // Print mode with an open, empty stream-json input: Claude starts, renews,
  // and waits for a message that never comes. (Plain `-p` gives up on an empty
  // input after three seconds.) No MCP servers, no saved session, and none of
  // the bridge's identity, so its hooks stay silent.
  const run = await startClaude(spawnClaude, { cwd: directory, env: childEnv })
  let result = 'unchanged'
  try {
    const deadline = now() + RENEWAL_WAIT_MS
    do {
      await wait(RENEWAL_POLL_MS)
      result = await outcome()
    } while (result === 'unchanged' && !run.exited && now() < deadline)
  } finally { await stopClaude(run, wait) }
  // Claude may have saved its renewal while it was stopping.
  if (result === 'unchanged') result = await outcome()
  if (result === 'renewed') return { outcome: 'renewed', login: await readOAuth({ directory, env, execCredential }) }
  return { outcome: result === 'refused' ? 'refused' : 'unconfirmed' }
}

async function startClaude(spawnClaude, { cwd, env }) {
  const child = spawnClaude('claude', RENEWAL_ARGS, { cwd, env, stdio: ['pipe', 'ignore', 'ignore'] })
  const run = { child, exited: false }
  run.exit = new Promise(resolve => child.once('exit', () => { run.exited = true; resolve() }))
  // A `claude` that never started spent nothing.
  try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }) } catch { fail() }
  child.on('error', () => {})
  child.stdin?.on?.('error', () => {}) // an early exit must not turn into an EPIPE
  return run
}

// Closing its input ends Claude, which first waits for a renewal in flight.
async function stopClaude(run, wait) {
  const ended = ms => run.exited || Promise.race([run.exit.then(() => true), wait(ms).then(() => run.exited)])
  run.child.stdin?.end?.()
  if (await ended(RENEWAL_EXIT_MS)) return
  run.child.kill('SIGTERM')
  if (await ended(5000)) return
  run.child.kill('SIGKILL')
  await ended(5000)
}

// After the owner's sign-in: a fresh credential for the expected account.
export async function verifyClaudeProfileSignIn({ directory, expectedEmail = null, env = process.env,
  execCredential = execute, now = Date.now, readOAuth = readClaudeOAuth } = {}) {
  try {
    const oauth = await readOAuth({ directory, env, execCredential })
    if (!Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= now()) return 'not-signed-in'
  } catch { return 'not-signed-in' }
  if (!expectedEmail) return 'ok'
  // Claude's own config holds no token and may keep an older, wider mode.
  let email
  try {
    const file = path.join(directory, '.claude.json')
    if (fs.statSync(file).size > 32 << 20) return 'not-signed-in'
    email = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.emailAddress
  } catch { return 'not-signed-in' }
  if (typeof email !== 'string' || !email) return 'not-signed-in'
  return email.toLowerCase() === expectedEmail.toLowerCase() ? 'ok' : 'wrong-account'
}
