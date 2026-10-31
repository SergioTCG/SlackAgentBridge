import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileAccountRegistry } from '../daemon/account-registry.mjs'
import { stageAccountRegistry, readAccountRegistry } from '../daemon/account-registry-store.mjs'
import { publicAccountRegistry } from '../daemon/account-registry.mjs'
import { prepareCodexProfile, codexProfileHome, prepareClaudeProfile, claudeProfileHome, claudeKeychainService, withAccountProfileLease,
  seedClaudeFirstRunState, claudeNativeConfigFile, recordProfileLeaseFailure, profileLeaseState, withProfileSignIn } from '../daemon/account-profiles.mjs'

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
      claudeInChromeDefaultEnabled: true,
      oauthAccount: { emailAddress: 'native@example.test' }, userID: 'native-user', projects: { '/work': { hasTrustDialogAccepted: true } },
    }), { mode: 0o644 })
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome })
    const file = path.join(directory, '.claude.json')
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'extra@example.test' }, userID: 'profile-user', theme: 'dark' }), { mode: 0o600 })
    assert.equal(seedClaudeFirstRunState(directory, nativeConfig), true)
    const seeded = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(seeded, { oauthAccount: { emailAddress: 'extra@example.test' }, userID: 'profile-user', theme: 'dark',
      hasCompletedOnboarding: true, lastOnboardingVersion: '2.0.55', hasCompletedClaudeInChromeOnboarding: true,
      claudeInChromeDefaultEnabled: true })
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

const DEAD_PID = 2147483646

test('a lease reads as an operation in progress only while its owner lives; otherwise the profile needs a new sign-in', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-profile-lease-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome }), lease = path.join(directory, '.sab-auth-operation')
    assert.equal(profileLeaseState(directory), null)
    await withAccountProfileLease(directory, async held => {
      assert.equal(held.path, lease)
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(lease, 'owner.json'), 'utf8'))).sort(), ['at', 'pid', 'purpose', 'token'])
      assert.equal(profileLeaseState(directory).running, true)
      assert.throws(() => claudeProfileHome(root, 'extra'), /account_auth_operation_in_progress/)
    }, { purpose: 'login' })
    assert.equal(fs.existsSync(lease), false, 'a finished operation removes its lease and records')

    // Kept only when the operation's own test of the error says so.
    await assert.rejects(withAccountProfileLease(directory, async () => { throw new Error('before') }, { retainOnFailure: error => error.message === 'after' }))
    assert.equal(fs.existsSync(lease), false)
    await assert.rejects(withAccountProfileLease(directory, async held => { recordProfileLeaseFailure(held, 'timeout'); throw new Error('after') },
      { retainOnFailure: error => error.message === 'after', purpose: 'renewal' }))
    assert.throws(() => claudeProfileHome(root, 'extra'), error => error.message === 'account_needs_login' && error.renewalFailure === 'timeout')
    fs.rmSync(lease, { recursive: true })

    // An owner that is gone, or a lease from before these records, may have spent the token too.
    fs.mkdirSync(lease, { mode: 0o700 })
    fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: DEAD_PID, purpose: 'renewal', at: Date.now() }), { mode: 0o600 })
    assert.throws(() => claudeProfileHome(root, 'extra'), error => error.message === 'account_needs_login' && error.renewalFailure === 'abandoned')
    fs.rmSync(path.join(lease, 'owner.json'))
    assert.equal(profileLeaseState(directory).running, true)
    const old = new Date(Date.now() - 601000); fs.utimesSync(lease, old, old)
    assert.throws(() => claudeProfileHome(root, 'extra'), error => error.renewalFailure === 'abandoned')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an owner sign-in keeps the lease until it is verified, so a failed one never re-exposes a spent token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-profile-signin-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome }), lease = path.join(directory, '.sab-auth-operation')
    const failed = reason => {
      fs.mkdirSync(lease, { mode: 0o700 })
      fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: process.pid, purpose: 'renewal', token: 'renewal', at: Date.now() }), { mode: 0o600 })
      if (reason) fs.writeFileSync(path.join(lease, 'failure.json'), JSON.stringify({ reason, at: Date.now() }), { mode: 0o600 })
    }
    const reason = () => JSON.parse(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8')).reason

    failed('rejected')
    await assert.rejects(withProfileSignIn(directory, async () => { throw new Error('cancelled') }, { verify: async () => 'ok' }), /cancelled/)
    assert.equal(reason(), 'rejected')
    await assert.rejects(withProfileSignIn(directory, async () => {}, { verify: async () => 'not-signed-in' }), /account_sign_in_unverified/)
    assert.equal(reason(), 'rejected')
    await assert.rejects(withProfileSignIn(directory, async () => {}, { verify: async () => 'wrong-account' }), error => error.renewalFailure === 'wrong-account')
    assert.equal(reason(), 'wrong-account')
    let during = null
    assert.deepEqual(await withProfileSignIn(directory, async () => { during = profileLeaseState(directory) }, { verify: async () => 'ok' }),
      { continued: 'wrong-account' })
    assert.equal(during.needsLogin, 'wrong-account', 'readers keep seeing needs-login while the sign-in runs')
    assert.equal(fs.existsSync(lease), false)

    // A renewal still running is never continued; an overdue one only explicitly.
    failed(null)
    await assert.rejects(withProfileSignIn(directory, async () => { throw new Error('must not run') }, { verify: async () => 'ok' }),
      /account_auth_operation_in_progress/)
    assert.deepEqual(await withProfileSignIn(directory, async () => {}, { verify: async () => 'ok', now: Date.now() + 601000 }), { continued: 'abandoned' })

    // Without a lease: a failure leaves nothing, and a wrong account stays fenced.
    await assert.rejects(withProfileSignIn(directory, async () => { throw new Error('cancelled') }, { verify: async () => 'ok' }))
    assert.equal(fs.existsSync(lease), false)
    await assert.rejects(withProfileSignIn(directory, async () => {}, { verify: async () => 'wrong-account' }))
    assert.equal(reason(), 'wrong-account')
    assert.throws(() => claudeProfileHome(root, 'extra'), /account_needs_login/)
    fs.rmSync(lease, { recursive: true })

    // A wrong account is fenced even after a parallel sign-in removed the lease.
    failed('rejected')
    await assert.rejects(withProfileSignIn(directory, async () => { fs.rmSync(lease, { recursive: true }) }, { verify: async () => 'wrong-account' }))
    assert.equal(reason(), 'wrong-account')
    fs.rmSync(lease, { recursive: true })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a sign-in in progress is never continued by a second one, and a wrong-account fence outlives every earlier holder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-profile-overlap-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome }), lease = path.join(directory, '.sab-auth-operation')
    fs.mkdirSync(lease, { mode: 0o700 })
    fs.writeFileSync(path.join(lease, 'failure.json'), JSON.stringify({ reason: 'timeout', at: Date.now() }), { mode: 0o600 })
    let second = null
    await withProfileSignIn(directory, async () => {
      second = await withProfileSignIn(directory, async () => { throw new Error('must not run') }, { verify: async () => 'ok' })
        .then(() => 'ran', error => error.message)
    }, { verify: async () => 'ok' })
    assert.equal(second, 'account_auth_operation_in_progress')
    assert.equal(fs.existsSync(lease), false, 'the first sign-in still lifts its lease')

    // An aborted sign-in whose PID now belongs to a living process stops blocking after fifteen minutes.
    fs.mkdirSync(lease, { mode: 0o700 })
    fs.writeFileSync(path.join(lease, 'failure.json'), JSON.stringify({ reason: 'timeout', at: Date.now() }), { mode: 0o600 })
    fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: process.pid, purpose: 'login', token: 'gone', at: Date.now() }), { mode: 0o600 })
    await assert.rejects(withProfileSignIn(directory, async () => {}, { verify: async () => 'ok' }), /account_auth_operation_in_progress/)
    assert.deepEqual(await withProfileSignIn(directory, async () => {}, { verify: async () => 'ok', now: Date.now() + 901000 }), { continued: 'timeout' })

    // An overdue renewal ends after a sign-in fenced a wrong account in a lease a parallel sign-in removed.
    let finish, started
    const ready = new Promise(resolve => { started = resolve })
    const original = withAccountProfileLease(directory, async () => { started(); await new Promise(resolve => { finish = resolve }) }, { purpose: 'renewal' })
    await ready
    await assert.rejects(withProfileSignIn(directory, async () => { fs.rmSync(lease, { recursive: true }) },
      { verify: async () => 'wrong-account', now: Date.now() + 601000 }), error => error.renewalFailure === 'wrong-account')
    finish(); await original
    assert.equal(profileLeaseState(directory).needsLogin, 'wrong-account', 'the late renewal leaves the fence in place')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('an operation that ends after the owner continued its lease neither removes it nor writes into it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-profile-ownership-'))
  try {
    const nativeHome = path.join(root, 'native'); fs.mkdirSync(nativeHome)
    const directory = prepareClaudeProfile(root, 'extra', { nativeHome }), lease = path.join(directory, '.sab-auth-operation')
    for (const ending of ['success', 'failure']) {
      let finish, started
      const ready = new Promise(resolve => { started = resolve })
      const original = withAccountProfileLease(directory, async held => {
        started()
        await new Promise(resolve => { finish = resolve })
        if (ending === 'failure') { recordProfileLeaseFailure(held, 'timeout'); throw new Error('spent') }
      }, { purpose: 'renewal', retainOnFailure: true }).catch(() => {})
      await ready
      let during = null
      await withProfileSignIn(directory, async () => {
        finish(); await original
        during = { exists: fs.existsSync(lease), state: profileLeaseState(directory) }
      }, { verify: async () => 'ok', now: Date.now() + 601000 })
      assert.equal(during.exists, true, `the ${ending} of the original leaves the continued lease`)
      assert.equal(during.state.needsLogin, 'abandoned', 'and writes no record of its own into it')
      assert.equal(fs.existsSync(lease), false, 'the verified sign-in removes it')
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('signing in again continues a failed renewal only once verified, and only around dormant sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-profile-relogin-'))
  try {
    const home = path.join(root, 'home'), configDir = path.join(root, 'bridge'), bin = path.join(root, 'bin')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); fs.mkdirSync(configDir, { mode: 0o700 }); fs.mkdirSync(bin)
    // A fake native sign-in: fails while $HOME/cancel exists, else saves a credential for $HOME/email.
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh', '[ "$1 $2" = "auth login" ] || exit 2', '[ -f "$HOME/cancel" ] && exit 1', 'umask 077',
      'printf \'{"claudeAiOauth":{"accessToken":"FAKE","expiresAt":4102444800000}}\' > "$CLAUDE_CONFIG_DIR/.credentials.json"',
      'printf \'{"oauthAccount":{"emailAddress":"%s"}}\' "$(cat "$HOME/email")" > "$CLAUDE_CONFIG_DIR/.claude.json"', '',
    ].join('\n'), { mode: 0o755 })
    fs.writeFileSync(path.join(home, 'email'), 'owner@example.test')
    const directory = prepareClaudeProfile(configDir, 'extra', { nativeHome: path.join(home, '.claude') })
    const lease = path.join(directory, '.sab-auth-operation')
    const failed = () => {
      fs.mkdirSync(lease, { mode: 0o700 })
      fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: DEAD_PID, purpose: 'renewal', at: Date.now() }), { mode: 0o600 })
      fs.writeFileSync(path.join(lease, 'failure.json'), JSON.stringify({ reason: 'rejected', at: Date.now() }), { mode: 0o600 })
    }
    const script = fileURLToPath(new URL('../scripts/sab-account-profile.mjs', import.meta.url))
    const run = (args, extra = {}) => spawnSync(process.execPath, [script, ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, CCS_CONFIG_DIR: configDir, CCS_TMUX_BIN: '/usr/bin/false', ...extra }, encoding: 'utf8' })
    failed()
    const launch = run(['resolve', 'extra', 'claude'])
    assert.equal(launch.status, 1)
    assert.match(launch.stderr, /profile extra needs a new sign-in; nothing was launched\. Run `sab account login-claude extra`/)

    fs.writeFileSync(path.join(home, 'cancel'), '')
    const cancelled = run(['login', 'extra', 'claude'])
    fs.rmSync(path.join(home, 'cancel'))
    assert.equal(cancelled.status, 1)
    assert.match(cancelled.stderr, /did not complete/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8')).reason, 'rejected', 'the possibly spent token stays fenced')

    // Sessions on the profile: dormant ones wait for this sign-in, a running one refuses it.
    const session = { id: 'dormant', provider: 'claude', account: 'extra', accountKind: 'claude-profile', pid: DEAD_PID, tmux: 'sab-gone' }
    fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({ sessions: { dormant: session } }), { mode: 0o600 })
    assert.match(run(['login', 'extra', 'claude']).stderr, /running or standby sessions still use this profile/,
      'a profile no registered account names has no account to prove')
    stageAccountRegistry(configDir, compileAccountRegistry({ schemaVersion: 1, requestId: 'enroll', accounts: [
      { key: 'extra-claude', provider: 'claude', email: 'owner@example.test', identityConfirmed: true, credentials: [{ kind: 'claude-profile', profile: 'extra' }] },
    ], groups: [{ key: 'mine', name: 'Mine', members: ['extra-claude'], preferred: { claude: 'extra-claude' } }],
    routing: { defaultGroup: 'mine', channels: {} } }).spec, { expectedRevision: 0 })
    assert.match(run(['login', 'extra', 'claude'], { CCS_TMUX_BIN: path.join(root, 'missing-tmux') }).stderr,
      /running or standby sessions still use this profile/, 'a tmux that cannot answer counts as running')
    fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({ sessions: { live: { ...session, id: 'live', pid: process.pid } } }), { mode: 0o600 })
    assert.match(run(['login', 'extra', 'claude']).stderr, /running or standby sessions still use this profile/)
    fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({ sessions: { dormant: session } }), { mode: 0o600 })
    fs.writeFileSync(path.join(home, 'email'), 'someone-else@example.test')
    const wrong = run(['login', 'extra', 'claude'])
    assert.equal(wrong.status, 1)
    assert.match(wrong.stderr, /not the account this profile belongs to/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(lease, 'failure.json'), 'utf8')).reason, 'wrong-account')
    fs.writeFileSync(path.join(home, 'email'), 'owner@example.test')
    const login = run(['login', 'extra', 'claude'])
    assert.equal(login.status, 0, login.stderr)
    assert.match(login.stderr, /earlier failed renewal \(wrong-account\) no longer blocks it/)
    assert.equal(fs.existsSync(lease), false)
    assert.equal(run(['resolve', 'extra', 'claude']).status, 0)

    // Without a needs-login lease, a dormant session still refuses a new sign-in,
    // unless SAB last read the account as needs-login (the provider's 401).
    assert.match(run(['login', 'extra', 'claude']).stderr, /running or standby sessions still use this profile/)
    const accountId = publicAccountRegistry(readAccountRegistry(configDir)).accounts[0].id
    fs.writeFileSync(path.join(configDir, 'state.json'), JSON.stringify({ sessions: { dormant: session },
      accountPools: { observations: { [accountId]: { observation: { status: 'needs-login' } } } } }), { mode: 0o600 })
    const revoked = run(['login', 'extra', 'claude'])
    assert.equal(revoked.status, 0, revoked.stderr)
    fs.rmSync(path.join(configDir, 'state.json'))

    // An unreadable registry does not block a plain enrollment.
    fs.chmodSync(path.join(configDir, 'account-pools'), 0o755)
    const fresh = run(['login', 'fresh', 'claude'])
    assert.equal(fresh.status, 0, fresh.stderr)
    fs.chmodSync(path.join(configDir, 'account-pools'), 0o700)

    // A sign-in that may still be running is reported and left alone.
    fs.mkdirSync(lease, { mode: 0o700 })
    fs.writeFileSync(path.join(lease, 'owner.json'), JSON.stringify({ pid: process.pid, purpose: 'login', at: Date.now() }), { mode: 0o600 })
    const busy = run(['login', 'extra', 'claude'])
    assert.equal(busy.status, 1)
    assert.match(busy.stderr, /still running/)
    assert.equal(fs.existsSync(path.join(lease, 'owner.json')), true)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
