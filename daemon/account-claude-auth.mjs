// Credential values remain private to this module and the no-inference reader.
// Native Claude owns refresh-token exchange and credential-store writes.
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readPrivateAccountFile } from './account-registry-store.mjs'
import { claudeKeychainService, claudeProfileHome, withAccountProfileLease } from './account-profiles.mjs'
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
  return withAccountProfileLease(directory, async () => {
    if (!await isInactive(profile)) fail()
    const oauth = await read()
    if (oauth.expiresAt > now() + 60000) return oauth
    if (!secret(oauth.refreshToken) || !Array.isArray(oauth.scopes) || !oauth.scopes.length ||
        oauth.scopes.some(s => typeof s !== 'string' || !/^[A-Za-z0-9_:.-]{1,128}$/.test(s))) fail()
    const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'].filter(k => env[k]).map(k => [k, env[k]]))
    Object.assign(childEnv, { CLAUDE_CONFIG_DIR: directory, CLAUDE_CODE_OAUTH_REFRESH_TOKEN: oauth.refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: oauth.scopes.join(' '), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    try {
      // Documented non-browser provisioning path; no prompt, inference, bridge
      // identity, shell evaluation, token argv, or diagnostic forwarding.
      await execCredential('claude', ['auth', 'login'], { cwd: directory, env: childEnv, timeout: 20000, maxBuffer: 65536, encoding: 'utf8' })
    } catch { fail() }
    const refreshed = await read()
    if (!Number.isFinite(refreshed.expiresAt) || refreshed.expiresAt <= now()) fail()
    return refreshed
  }, { retainOnFailure: true })
}
