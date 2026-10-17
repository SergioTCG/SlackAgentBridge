import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareCodexProfile, codexProfileHome, prepareClaudeProfile, claudeProfileHome, claudeKeychainService, withAccountProfileLease } from '../daemon/account-profiles.mjs'

test('explicit Codex profile enrollment shares native resources but never copies or links authentication', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-profile-'))
  try {
    const configDir = path.join(root, 'bridge'), nativeHome = path.join(root, 'native')
    fs.mkdirSync(configDir, { mode: 0o700 }); fs.mkdirSync(nativeHome)
    fs.mkdirSync(path.join(nativeHome, 'sessions')); fs.mkdirSync(path.join(nativeHome, 'skills'))
    fs.writeFileSync(path.join(nativeHome, 'config.toml'), 'model="fixture-model"\n')
    fs.writeFileSync(path.join(nativeHome, 'auth.json'), '{"private":"NEVER-LINK-OR-COPY"}', { mode: 0o600 })
    const home = prepareCodexProfile(configDir, 'second-profile', { nativeHome })
    assert.equal(fs.realpathSync(path.join(home, 'sessions')), fs.realpathSync(path.join(nativeHome, 'sessions')))
    assert.equal(fs.realpathSync(path.join(home, 'config.toml')), fs.realpathSync(path.join(nativeHome, 'config.toml')))
    assert.equal(fs.existsSync(path.join(home, 'auth.json')), false)
    assert.throws(() => codexProfileHome(configDir, 'second-profile'), /codex_profile_not_authenticated/)
    fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{}}', { mode: 0o600 })
    assert.equal(codexProfileHome(configDir, 'second-profile'), home)
    assert.equal(prepareCodexProfile(configDir, 'second-profile', { nativeHome }), home)
    assert.throws(() => prepareCodexProfile(configDir, '../../escape', { nativeHome }), /invalid_codex_profile/)
    fs.chmodSync(home, 0o755)
    assert.throws(() => codexProfileHome(configDir, 'second-profile'), /insecure_codex_profile/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Claude profiles share conversation resources, not authentication, and authentication leases fence launches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-profile-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    fs.mkdirSync(path.join(nativeHome, 'projects'))
    fs.writeFileSync(path.join(nativeHome, 'settings.json'), '{}')
    fs.writeFileSync(path.join(nativeHome, '.credentials.json'), 'PRIVATE', { mode: 0o600 })
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome })
    assert.equal(fs.realpathSync(path.join(directory, 'projects')), fs.realpathSync(path.join(nativeHome, 'projects')))
    assert.equal(fs.existsSync(path.join(directory, '.credentials.json')), false)
    assert.match(claudeKeychainService(directory), /^Claude Code-credentials-[a-f0-9]{8}$/)
    assert.equal(claudeKeychainService(null), 'Claude Code-credentials')
    assert.equal(claudeProfileHome(root, 'extra'), directory)
    await withAccountProfileLease(directory, async () => {
      assert.throws(() => claudeProfileHome(root, 'extra'), /account_auth_operation_in_progress/)
      await assert.rejects(withAccountProfileLease(directory, async () => {}), /account_auth_operation_in_progress/)
    })
    assert.equal(claudeProfileHome(root, 'extra'), directory)
    await assert.rejects(withAccountProfileLease(directory, async () => { throw new Error('failure') }), /failure/)
    assert.equal(claudeProfileHome(root, 'extra'), directory)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
