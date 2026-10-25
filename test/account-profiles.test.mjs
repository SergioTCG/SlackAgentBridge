import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareCodexProfile, codexProfileHome, prepareClaudeProfile, claudeProfileHome, claudeKeychainService, withAccountProfileLease,
  seedClaudeFirstRunState, claudeNativeConfigFile } from '../daemon/account-profiles.mjs'

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

test('a fresh Claude profile inherits only first-run completion markers, so its first detached launch reaches the prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-first-run-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const nativeConfig = path.join(root, '.claude.json')
    fs.writeFileSync(nativeConfig, JSON.stringify({
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.0.55', hasCompletedClaudeInChromeOnboarding: true, theme: 'light',
      oauthAccount: { emailAddress: 'native@example.test' }, userID: 'native-user', projects: { '/work': { hasTrustDialogAccepted: true } },
    }), { mode: 0o644 })
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome })
    const file = path.join(directory, '.claude.json')
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'extra@example.test' }, userID: 'profile-user', theme: 'dark' }), { mode: 0o600 })
    assert.equal(seedClaudeFirstRunState(directory, nativeConfig), true)
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(seeded, { oauthAccount: { emailAddress: 'extra@example.test' }, userID: 'profile-user', theme: 'dark',
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.0.55', hasCompletedClaudeInChromeOnboarding: true })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('.claude.json')), ['.claude.json'])
    const before = fs.readFileSync(file, 'utf8')
    assert.equal(seedClaudeFirstRunState(directory, nativeConfig), false, 'seeding is idempotent')
    assert.equal(fs.readFileSync(file, 'utf8'), before)

    fs.rmSync(file)
    assert.equal(seedClaudeFirstRunState(directory, nativeConfig), true, 'a missing profile config is created privately')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).userID, undefined)

    fs.chmodSync(file, 0o644)
    assert.throws(() => seedClaudeFirstRunState(directory, nativeConfig))
    fs.chmodSync(file, 0o600)

    fs.writeFileSync(nativeConfig, JSON.stringify({ theme: 'light' }))
    fs.rmSync(file)
    assert.equal(seedClaudeFirstRunState(directory, nativeConfig), false, 'nothing is inferred before the native login finished onboarding')
    assert.equal(fs.existsSync(file), false)
    assert.equal(seedClaudeFirstRunState(directory, path.join(root, 'missing.json')), false)

    assert.equal(claudeNativeConfigFile({ CLAUDE_CONFIG_DIR: '/custom' }, '/home'), path.join('/custom', '.claude.json'))
    assert.equal(claudeNativeConfigFile({}, '/home'), path.join('/home', '.claude.json'))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('resolving an existing unseeded Claude profile for launch heals its first-run state and still prints only the profile path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-resolve-'))
  try {
    const home = path.join(root, 'home'), configDir = path.join(root, 'bridge')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(configDir, { mode: 0o700 })
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.0.55' }))
    const directory = prepareClaudeProfile(configDir, 'extra', { nativeHome: path.join(home, '.claude') })
    fs.writeFileSync(path.join(directory, '.claude.json'), JSON.stringify({ userID: 'profile-user' }), { mode: 0o600 })
    const script = fileURLToPath(new URL('../scripts/sab-account-profile.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, 'resolve', 'extra', 'claude'], {
      env: { PATH: process.env.PATH, HOME: home, CCS_CONFIG_DIR: configDir }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, directory)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, '.claude.json'), 'utf8')),
      { userID: 'profile-user', hasCompletedOnboarding: true, lastOnboardingVersion: '2.0.55' })
    fs.chmodSync(path.join(directory, '.claude.json'), 0o644)
    const insecure = spawnSync(process.execPath, [script, 'resolve', 'extra', 'claude'], {
      env: { PATH: process.env.PATH, HOME: home, CCS_CONFIG_DIR: configDir }, encoding: 'utf8' })
    assert.equal(insecure.status, 0, 'a seeding failure never blocks the launch path')
    assert.equal(insecure.stdout, directory)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
