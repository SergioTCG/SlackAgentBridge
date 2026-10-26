import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareCodexProfile, prepareClaudeProfile } from '../daemon/account-profiles.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
test('account restart rechecks the idle/authority gate after a delayed Slack notice, before mutation or teardown', async () => {
  const start = daemon.indexOf('async function restartSessionWithMutation(')
  const end = daemon.indexOf('\nasync function switchAccount(', start)
  const source = daemon.slice(start, end)
  let mutated = false, stopped = false, released = false
  const deps = { reserveSessionMaintenance: () => ({ sessionId: 's', channel: 'CWORK' }), post: async () => {}, log: () => {},
    maintenanceSessionIsAuthoritative: () => true, saveStateNow: () => {}, state: {},
    stopReservedSession: async () => { stopped = true }, resurrect: async () => {}, tmuxAlive: async () => true,
    scheduleUpdateGuardCleanup: () => {}, releaseSessionMaintenance: () => { released = true },
    claudeConversationGone: () => false }
  const restart = new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps; return (${source});`)(deps)
  await assert.rejects(restart({ id: 's' }, { mutate: () => { mutated = true }, beforeMutation: async () => { await Promise.resolve(); throw new Error('became busy during notice') } }), /became busy/)
  assert.equal(mutated, false)
  assert.equal(stopped, false)
  assert.equal(released, true)
})

test('a restart refuses a Claude session with no conversation before reserving, posting or stopping it', async () => {
  const start = daemon.indexOf('async function restartSessionWithMutation(')
  const end = daemon.indexOf('\nasync function switchAccount(', start)
  const source = daemon.slice(start, end)
  const touched = []
  const deps = { reserveSessionMaintenance: () => { touched.push('reserve'); return { sessionId: 's', channel: 'CWORK' } },
    post: async () => { touched.push('post') }, log: () => {},
    maintenanceSessionIsAuthoritative: () => true, saveStateNow: () => { touched.push('save') }, state: {},
    stopReservedSession: async () => { touched.push('stop') }, resurrect: async () => { touched.push('resurrect') }, tmuxAlive: async () => true,
    scheduleUpdateGuardCleanup: () => {}, releaseSessionMaintenance: () => { touched.push('release') },
    claudeConversationGone: session => session.id === 's' }
  const restart = new Function('deps', `const { ${Object.keys(deps).join(', ')} } = deps; return (${source});`)(deps)
  await assert.rejects(restart({ id: 's' }, { notice: 'restarting', mutate: () => { touched.push('mutate') } }), /no conversation to resume yet/)
  assert.deepEqual(touched, [])
})

test('pool daemon integration is opt-in and uses the existing exact restart/input-fence path', () => {
  assert.match(daemon, /mode: process\.env\.CCS_ACCOUNT_POOLS \|\| 'off'/)
  assert.match(daemon, /readQuota: account => readAccountQuota/)
  assert.match(daemon, /accountPools\.enabled/)
  assert.match(daemon, /beforeMutation: async \(\) =>/)
  assert.match(daemon, /targetStartupState\(expected\.provider, pane\)/)
  assert.match(daemon, /validProviderRootClaim\(expected\.pid, expected\.tmux, expected\.provider\)/)
  assert.match(daemon, /handleAccountPoolHttp\(req, res, url, accountPools, state\)/)
  assert.match(daemon, /await accountPools\.recover\(\)/)
  assert.match(daemon, /if \(accountPools\.enabled && session &&[^\n]+\(!rest\.length \|\| accountPools\.enforcing\)\)/)
  assert.doesNotMatch(daemon, /accountPool: accountPools\.enabled/)
})

test('a requested named Claude account overrides inherited auth and fails closed when missing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-launch-'))
  try {
    const bin = path.join(temp, 'bin'); fs.mkdirSync(bin)
    const configDir = path.join(temp, 'config'); fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, 'accounts'), 'requested=EXPECTED-FIXTURE-ACCOUNT\n', { mode: 0o600 })
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$CLAUDE_CODE_OAUTH_TOKEN" = "EXPECTED-FIXTURE-ACCOUNT" ]; then echo right-account; else echo wrong-account; fi\n', { mode: 0o700 })
    const run = alias => spawnSync('/bin/bash', [new URL('../scripts/run-session.sh', import.meta.url).pathname, 'claude'], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: temp, CCS_CONFIG_DIR: configDir, CCS_NO_TMUX: '1', CCS_ACCOUNT: alias,
        CLAUDE_CODE_OAUTH_TOKEN: 'INHERITED-WRONG-ACCOUNT' }, encoding: 'utf8', timeout: 10000 })
    const named = run('requested')
    assert.equal(named.status, 0, named.stderr)
    assert.match(named.stdout, /right-account/)
    const missing = run('missing')
    assert.notEqual(missing.status, 0)
    assert.doesNotMatch(missing.stdout + missing.stderr, /INHERITED|EXPECTED-FIXTURE|right-account|wrong-account/)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('a Codex profile is used by direct fallback and a missing profile cannot launch machine auth', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-codex-profile-launch-'))
  try {
    const bin = path.join(temp, 'bin'), native = path.join(temp, 'native'), configDir = path.join(temp, 'config')
    for (const directory of [bin, native, configDir]) fs.mkdirSync(directory, { mode: 0o700 })
    fs.mkdirSync(path.join(native, 'sessions'))
    const home = prepareCodexProfile(configDir, 'second', { nativeHome: native })
    fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"access_token":"PRIVATE-FIXTURE"}}', { mode: 0o600 })
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nif [ "$CODEX_HOME" = "$EXPECTED_HOME" ] && [ -z "$OPENAI_API_KEY" ]; then echo profile-ready; else echo wrong-profile; fi\n', { mode: 0o700 })
    const run = profile => spawnSync('/bin/bash', [new URL('../scripts/run-session.sh', import.meta.url).pathname, 'codex', '--yolo'], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: temp, CCS_CONFIG_DIR: configDir, CCS_NO_TMUX: '1', CCS_CODEX_APP_SERVER: '0',
        CCS_CODEX_PROFILE: profile, EXPECTED_HOME: home, OPENAI_API_KEY: 'WRONG-AUTH' }, encoding: 'utf8', timeout: 10000 })
    const actual = run('second')
    assert.equal(actual.status, 0, actual.stderr)
    assert.match(actual.stdout, /profile-ready/)
    const missing = run('missing')
    assert.notEqual(missing.status, 0)
    assert.doesNotMatch(missing.stdout + missing.stderr, /PRIVATE-FIXTURE|WRONG-AUTH|profile-ready|wrong-profile/)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('a full Claude profile clears inherited auth and reports its exact profile to lifecycle hooks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-profile-runner-'))
  try {
    const bin = path.join(root, 'bin'), native = path.join(root, 'native'), configDir = path.join(root, 'config')
    for (const directory of [bin, native, configDir]) fs.mkdirSync(directory, { mode: 0o700 })
    const home = prepareClaudeProfile(configDir, 'full', { nativeHome: native })
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$CLAUDE_CONFIG_DIR" = "$EXPECTED_HOME" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ] && [ "$CCS_CLAUDE_PROFILE" = full ]; then echo exact-profile; else exit 7; fi\n', { mode: 0o700 })
    const result = spawnSync('/bin/bash', [new URL('../scripts/run-session.sh', import.meta.url).pathname, 'claude'], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, CCS_CONFIG_DIR: configDir, CCS_NO_TMUX: '1', CCS_POOL_ACCOUNT: '1',
        CCS_CLAUDE_PROFILE: 'full', EXPECTED_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'WRONG-PRIVATE', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/wrong' }, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /exact-profile/)
    assert.match(fs.readFileSync(new URL('../hooks/hook.sh', import.meta.url), 'utf8'), /x-ccs-account-profile/)
    assert.doesNotMatch(result.stdout + result.stderr, /WRONG-PRIVATE/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('pooled native-default Codex uses the exact inspected file store, not an unrelated keyring account', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-native-store-'))
  try {
    const bin = path.join(root, 'bin'); fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ncase "$*" in *cli_auth_credentials_store*=*file*) echo exact-file-store ;; *) exit 7 ;; esac\n', { mode: 0o700 })
    const result = spawnSync('/bin/bash', [new URL('../scripts/run-session.sh', import.meta.url).pathname, 'codex'], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, CCS_CONFIG_DIR: root, CCS_NO_TMUX: '1', CCS_POOL_ACCOUNT: '1', CCS_CODEX_APP_SERVER: '0' }, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /exact-file-store/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
