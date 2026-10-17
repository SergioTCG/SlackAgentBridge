import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readClaudeOAuth, refreshInactiveClaudeProfile } from '../daemon/account-claude-auth.mjs'
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
    await assert.rejects(refreshInactiveClaudeProfile(options), /credential_unavailable/)
    await assert.rejects(refreshInactiveClaudeProfile(options), /account_auth_operation_in_progress/)
    assert.equal(calls, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
