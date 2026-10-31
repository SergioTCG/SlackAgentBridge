// Credential values remain private to this module and the no-inference reader.
// Native Claude owns refresh-token exchange and credential-store writes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readPrivateAccountFile } from './account-registry-store.mjs'
import { claudeKeychainService, claudeProfileHome, withAccountProfileLease, recordProfileLeaseFailure, profileNeedsLogin } from './account-profiles.mjs'
const execute = promisify(execFile)
const secret = s => typeof s === 'string' && s.length > 0 && s.length <= 65536 && !/[\r\n\0]/.test(s)
const fail = () => { throw new Error('credential_unavailable') }

export async function readClaudeOAuth({ directory = null, env = process.env, platform = process.platform, execCredential = execute } = {}) {
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
  if (!secret(oauth?.accessToken)) fail()
  return oauth
}

export async function refreshInactiveClaudeProfile({ configDir, profile, isInactive, env = process.env,
  execCredential = execute, now = Date.now, readOAuth = readClaudeOAuth } = {}) {
  const directory = claudeProfileHome(configDir, profile)
  const read = () => readOAuth({ directory, env, execCredential })
  const existing = await read()
  if (!Number.isFinite(existing.expiresAt)) fail()
  if (existing.expiresAt > now() + 60000) return existing
  // No primary/default credential refresh and no live profile refresh. Native
  // running processes own their own rotating tokens; SAB never races them.
  if (!await isInactive(profile)) fail()
  // Nothing is spent before the exchange, so a failure up to there releases
  // the lease. From the exchange on, a failure keeps it and records why.
  return withAccountProfileLease(directory, async lease => {
    if (!await isInactive(profile)) fail()
    const oauth = await read()
    if (oauth.expiresAt > now() + 60000) return oauth
    if (!secret(oauth.refreshToken) || !Array.isArray(oauth.scopes) || !oauth.scopes.length ||
        oauth.scopes.some(s => typeof s !== 'string' || !/^[A-Za-z0-9_:.-]{1,128}$/.test(s))) fail()
    const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'].filter(k => env[k]).map(k => [k, env[k]]))
    Object.assign(childEnv, { CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: oauth.refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: oauth.scopes.join(' '), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    let reason = null
    try {
      // Documented non-browser provisioning path; no prompt, inference, bridge
      // identity, shell evaluation, token argv, or diagnostic forwarding. Its
      // input is closed, so a prompt fails at once instead of waiting.
      const run = execCredential('claude', ['auth', 'login'], { cwd: directory, env: childEnv, timeout: 30000, maxBuffer: 65536, encoding: 'utf8' })
      run?.child?.stdin?.end()
      await run
    } catch (error) {
      if (error?.code === 'ENOENT') fail() // never started, so nothing was spent
      // Only a reason code is kept; the CLI's own output never leaves here.
      reason = error?.killed || error?.signal ? 'timeout' : /status code 4\d\d/.test(String(error?.stderr || '')) ? 'rejected' : 'failed'
    }
    // A run stopped after Claude saved the new token still renewed it.
    let refreshed = null
    try { refreshed = await read() } catch {}
    if (Number.isFinite(refreshed?.expiresAt) && refreshed.expiresAt > now() + 60000) return refreshed
    recordProfileLeaseFailure(lease, reason || 'not-renewed')
    throw profileNeedsLogin(reason || 'not-renewed')
  }, { purpose: 'renewal', retainOnFailure: error => error?.message === 'account_needs_login' })
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
