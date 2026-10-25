#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  codexProfileHome, prepareCodexProfile, claudeProfileHome, prepareClaudeProfile, withAccountProfileLease,
  seedClaudeFirstRunState, claudeNativeConfigFile,
} from '../daemon/account-profiles.mjs'

const configDir = process.env.CCS_CONFIG_DIR || path.join(os.homedir(), '.config/ccs')
try {
  const [operation, profile, provider = 'codex', extra] = process.argv.slice(2)
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
    const { readPrivateAccountFile } = await import('../daemon/account-registry-store.mjs')
    const state = readPrivateAccountFile(path.join(configDir, 'state.json'), { missing: {}, json: true, maxBytes: 32 << 20 })
    if (Object.values(state.sessions || {}).some(s => (s.provider || 'claude') === provider && s.account === profile &&
        (provider === 'codex' || s.accountKind === 'claude-profile'))) throw new Error('profile_in_use')
    await withAccountProfileLease(directory, async () => {
      await new Promise((resolve, reject) => {
        const argv = provider === 'claude' ? ['auth', 'login'] : ['-c', 'cli_auth_credentials_store="file"', 'login']
        const child = spawn(provider, argv, { env, cwd: directory, stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code || 0; resolve() })
      })
      if (provider !== 'claude' || process.exitCode !== 0) return
      try { seedClaudeFirstRunState(directory, claudeNativeConfigFile()) }
      catch { process.stderr.write('sab: signed in, but could not mark Claude first-run screens complete for this profile; its first detached launch may wait for them.\n') }
    })
  }
} catch { process.stderr.write('sab: account profile is missing, in use, insecure, or conflicts with native resources; no fallback was attempted.\n'); process.exitCode = 1 }
