#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  codexProfileHome, prepareCodexProfile, claudeProfileHome, prepareClaudeProfile, withProfileSignIn, profileLeaseState,
  seedClaudeFirstRunState, claudeNativeConfigFile,
} from '../daemon/account-profiles.mjs'
import { verifyClaudeProfileSignIn, claudeLoginState } from '../daemon/account-claude-auth.mjs'

// A session counts as running while its process or its exact tmux session
// lives, and also when tmux cannot say.
const sessionRunning = session => {
  if (Number.isSafeInteger(session.pid) && session.pid > 1) {
    try { process.kill(session.pid, 0); return true } catch (error) { if (error.code === 'EPERM') return true }
  }
  if (typeof session.tmux !== 'string' || !session.tmux) return false
  const probe = spawnSync(process.env.CCS_TMUX_BIN || 'tmux', ['has-session', '-t', `=${session.tmux}`], { stdio: 'ignore', timeout: 5000 })
  return Boolean(probe.error) || probe.status !== 1
}

const configDir = process.env.CCS_CONFIG_DIR || path.join(os.homedir(), '.config/ccs')
const [operation, profile, provider = 'codex', extra] = process.argv.slice(2)
try {
  if (extra || !['login', 'resolve'].includes(operation) || !['claude', 'codex'].includes(provider)) throw new Error('invalid_profile_command')
  if (operation === 'resolve') {
    const directory = provider === 'claude' ? claudeProfileHome(configDir, profile) : codexProfileHome(configDir, profile)
    // Profiles enrolled before first-run seeding heal on their next launch.
    // Best effort: a failure leaves the launch exactly as it was before.
    if (provider === 'claude') { try { seedClaudeFirstRunState(directory, claudeNativeConfigFile()) } catch {} }
    process.stdout.write(directory)
  } else {
    const directory = provider === 'claude'
      ? prepareClaudeProfile(configDir, profile, { nativeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') })
      : prepareCodexProfile(configDir, profile, { nativeHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') })
    const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]))
    env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = directory
    process.stderr.write(`Signing in to a separate ${provider} credential profile. Existing native credentials are not copied or changed.\n`)
    // Refuse login on any profile referenced by durable sessions (including a
    // dormant/standby leg). Re-authenticate through a newly named profile,
    // then replace the account reference once the old profile is unused.
    // Exception: a Claude profile that needs a new sign-in launches nothing,
    // so its dormant sessions are waiting for exactly that. Nothing using it
    // may be running, and the sign-in must prove the registered account.
    const { readPrivateAccountFile, readAccountRegistry } = await import('../daemon/account-registry-store.mjs')
    const state = readPrivateAccountFile(path.join(configDir, 'state.json'), { missing: {}, json: true, maxBytes: 32 << 20 })
    let registered = null
    if (provider === 'claude') {
      try {
        const { publicAccountRegistry } = await import('../daemon/account-registry.mjs')
        const registry = readAccountRegistry(configDir)
        registered = (registry ? publicAccountRegistry(registry).accounts : []).find(a => a.provider === 'claude' &&
          a.credentials.some(ref => ref.kind === 'claude-profile' && ref.profile === profile)) || null
      } catch { /* unreadable registry: no exception below, plain enrollment still works */ }
    }
    const expectedEmail = registered?.email || null
    // Needs a sign-in: a kept lease, the provider's 401 as SAB last read it, or
    // a login Claude emptied after the provider refused to renew it. Running
    // sessions always refuse it: they would pick up any account signed in here.
    const needsLogin = Boolean(profileLeaseState(directory)?.needsLogin) ||
      state.accountPools?.observations?.[registered?.id]?.observation?.status === 'needs-login' ||
      provider === 'claude' && await claudeLoginState({ directory }) === 'signed-out'
    const users = Object.values(state.sessions || {}).filter(s => (s.provider || 'claude') === provider && s.account === profile &&
      (provider === 'codex' || s.accountKind === 'claude-profile'))
    if (users.length && (provider !== 'claude' || !expectedEmail || !needsLogin || users.some(sessionRunning))) throw new Error('profile_in_use')
    const verify = provider === 'claude'
      ? () => verifyClaudeProfileSignIn({ directory, expectedEmail })
      : async () => readPrivateAccountFile(path.join(directory, 'auth.json'), { json: true })?.tokens?.access_token ? 'ok' : 'not-signed-in'
    const { continued } = await withProfileSignIn(directory, async () => {
      await new Promise((resolve, reject) => {
        const argv = provider === 'claude' ? ['auth', 'login'] : ['-c', 'cli_auth_credentials_store="file"', 'login']
        const child = spawn(provider, argv, { env, cwd: directory, stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (code, signal) => code === 0 && !signal ? resolve() : reject(new Error('account_sign_in_failed')))
      })
      if (provider !== 'claude') return
      try { seedClaudeFirstRunState(directory, claudeNativeConfigFile()) }
      catch { process.stderr.write('sab: signed in, but could not mark Claude first-run screens complete for this profile; its first detached launch may wait for them.\n') }
    }, { verify })
    if (continued) process.stderr.write(`sab: signed in; the profile's earlier failed renewal (${continued}) no longer blocks it.\n`)
  }
} catch (error) {
  const name = /^[A-Za-z0-9_-]{1,64}$/.test(profile || '') ? profile : 'PROFILE'
  const command = `sab account login-${provider === 'claude' ? 'claude' : 'codex'} ${name}`
  const known = {
    account_needs_login: error?.renewalFailure === 'wrong-account'
      ? `sab: that sign-in is not the account this profile belongs to; nothing uses it. Run \`${command}\` again with the right account.\n`
      : `sab: profile ${name} needs a new sign-in; nothing was launched. Run \`${command}\`.\n`,
    account_sign_in_failed: 'sab: the sign-in did not complete; the profile is unchanged.\n',
    account_sign_in_unverified: 'sab: the sign-in left no usable credential; the profile is unchanged.\n',
    account_auth_operation_in_progress: 'sab: another sign-in or renewal of this profile is still running; try again when it ends.\n',
    profile_in_use: 'sab: running or standby sessions still use this profile; sign in under a new profile name instead.\n',
  }
  process.stderr.write(known[error?.message] || 'sab: account profile is missing, in use, insecure, or conflicts with native resources; no fallback was attempted.\n')
  process.exitCode = 1
}
