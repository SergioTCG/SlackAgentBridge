import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  AccountRegistryError, compileAccountRegistry, planAccountRegistryMigration,
  previewPoolAccountSelection, publicAccountRegistry,
} from '../daemon/account-registry.mjs'
import { readAccountRegistry, stageAccountRegistry } from '../daemon/account-registry-store.mjs'

const secret = 'sk-ant-oat01-NEVER-PRINT-THIS-REGISTRY-TOKEN'
const legacy = `client=${secret}\nbackup=${secret}\nsecondary=other-private-credential\n`
const fixture = () => ({
  schemaVersion: 1, requestId: 'owner-enrollment-1',
  accounts: [
    { key: 'primary-claude', provider: 'claude', email: 'primary@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
    { key: 'primary-codex', provider: 'codex', email: 'primary@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
    { key: 'secondary-claude', provider: 'claude', email: 'secondary@example.test', identityConfirmed: true, credentials: [{ kind: 'legacy-claude', alias: 'secondary' }] },
    { key: 'client-claude', provider: 'claude', email: 'client@example.test', identityConfirmed: true,
      credentials: [{ kind: 'legacy-claude', alias: 'client' }, { kind: 'legacy-claude', alias: 'backup' }], allowedChannels: ['CCLIENT1', 'CCLIENT2', 'CCLIENT3'] },
  ],
  groups: [
    { key: 'owner', name: 'Owner', members: ['primary-claude', 'primary-codex', 'secondary-claude'], preferred: { claude: 'primary-claude', codex: 'primary-codex' } },
    { key: 'client', name: 'Client', members: ['client-claude'] },
  ],
  routing: { defaultGroup: 'owner', channels: { CCLIENT1: 'client', CCLIENT2: 'client', CCLIENT3: 'client' } },
})
const registry = () => compileAccountRegistry(fixture(), { legacyAccounts: legacy })
const hasCode = code => error => error instanceof AccountRegistryError && error.code === code && !error.message.includes(secret)

test('registry represents email identities, multi-account groups, alias coalescing, and inactive monitoring separately', () => {
  const value = registry()
  const report = publicAccountRegistry(value)
  assert.equal(report.mode, 'staged')
  assert.equal(report.automaticSwitching, false)
  assert.equal(report.accounts.length, 4)
  assert.equal(report.groups.length, 2)
  assert.equal(new Set(report.accounts.map(account => account.id)).size, 4)
  assert.ok(report.accounts.every(account => account.monitoring === 'not-enrolled' && account.automaticEligible === false))
  const client = report.accounts.find(account => account.key === 'client-claude')
  assert.equal(client.credentials.length, 2)
  assert.equal(report.groups.find(group => group.key === 'owner').members.length, 3)
  assert.doesNotMatch(JSON.stringify(value), /NEVER-PRINT|other-private-credential/)
  assert.ok(!JSON.stringify(report).includes(value.sourceDigest))
})

test('policy resolves exact channel IDs, filters by provider, and cannot escape through credential aliases', () => {
  const value = registry()
  const choose = options => previewPoolAccountSelection(value, options)
  assert.equal(choose({ channelId: 'COWNER', provider: 'claude' }).account.email, 'primary@example.test')
  assert.equal(choose({ channelId: 'COWNER', provider: 'codex' }).account.provider, 'codex')
  for (const alias of ['backup', 'client', 'client@example.test']) {
    assert.throws(() => choose({ channelId: 'CPROJECT99', provider: 'claude', account: alias }), hasCode('account_outside_group'))
    assert.equal(choose({ channelId: 'CCLIENT2', provider: 'claude', account: alias }).account.email, 'client@example.test')
  }
  assert.throws(() => choose({ channelId: 'CCLIENT1', provider: 'claude', account: 'secondary@example.test' }), hasCode('account_outside_group'))
  assert.throws(() => choose({ channelId: 'CCLIENT1', provider: 'codex' }), hasCode('no_provider_account'))
  assert.throws(() => choose({ channelId: '#client', provider: 'claude' }), hasCode('invalid_channel'))
  assert.throws(() => choose({ channelId: 'COWNER', provider: 'claude', account: 'primary-codex' }), hasCode('provider_mismatch'))
  assert.throws(() => choose({ channelId: 'CCLIENT1', provider: 'claude', nodeId: 'remote' }), hasCode('nonlocal_account_node'))
  assert.throws(() => choose({ channelId: 'COWNER', provider: 'claude', mode: 'automatic' }), hasCode('automatic_switching_disabled'))
  assert.equal(choose({ channelId: 'COWNER', provider: 'claude' }).runtimeAllowed, false)
})

test('account channel ceiling still applies if that account is also added to an unrestricted group', () => {
  const spec = fixture()
  spec.groups[0].members.push('client-claude')
  const value = compileAccountRegistry(spec, { legacyAccounts: legacy })
  assert.throws(() => previewPoolAccountSelection(value, { channelId: 'COWNER', provider: 'claude', account: 'backup' }), hasCode('account_channel_forbidden'))
})

test('multiple Codex identities use distinct credential profiles without duplicating native login authority', () => {
  const spec = fixture()
  spec.accounts.push({ key: 'second-codex', provider: 'codex', email: 'second@example.test', identityConfirmed: true,
    credentials: [{ kind: 'codex-profile', profile: 'second-code-profile' }] })
  spec.groups[0].members.push('second-codex')
  const value = compileAccountRegistry(spec, { legacyAccounts: legacy })
  assert.equal(previewPoolAccountSelection(value, { channelId: 'COWNER', provider: 'codex', account: 'second@example.test' }).account.key, 'second-codex')
  spec.accounts[0].credentials = [{ kind: 'codex-profile', profile: 'not-claude' }]
  assert.throws(() => compileAccountRegistry(spec, { legacyAccounts: legacy }), hasCode('credential_provider_mismatch'))
})

test('owner input cannot smuggle credentials, verified monitoring, arbitrary nodes, or automatic activation', () => {
  for (const mutate of [
    spec => { spec.accounts[0].accessToken = secret },
    spec => { spec.accounts[0].monitoring = 'verified' },
    spec => { spec.accounts[0].nodeId = 'remote' },
    spec => { spec.automaticSwitching = true },
    spec => { spec.accounts[0].identityConfirmed = false },
    spec => { spec.routing.channels['#mutable-name'] = 'client' },
  ]) {
    const spec = fixture(); mutate(spec)
    assert.throws(() => compileAccountRegistry(spec, { legacyAccounts: legacy }), hasCode('invalid_enrollment'))
  }
})

test('migration requires complete, unambiguous credential ownership and does not invent accounts', () => {
  const missing = fixture(); missing.accounts[3].credentials.pop()
  assert.throws(() => compileAccountRegistry(missing, { legacyAccounts: legacy }), hasCode('unmapped_legacy_alias'))
  const crossProvider = fixture(); crossProvider.accounts[1].credentials.push({ kind: 'legacy-claude', alias: 'backup' })
  assert.throws(() => compileAccountRegistry(crossProvider, { legacyAccounts: legacy }), hasCode('credential_provider_mismatch'))
  const conflicting = fixture(); conflicting.accounts[2].credentials.push({ kind: 'legacy-claude', alias: 'backup' }); conflicting.accounts[3].credentials.pop()
  assert.throws(() => compileAccountRegistry(conflicting, { legacyAccounts: legacy }), hasCode('duplicate_credential_ownership'))
  const duplicateNative = fixture(); duplicateNative.accounts[2].credentials.push({ kind: 'native-default' })
  assert.throws(() => compileAccountRegistry(duplicateNative, { legacyAccounts: legacy }), hasCode('duplicate_credential_reference'))
  assert.throws(() => compileAccountRegistry(fixture(), { legacyAccounts: legacy + 'client=conflicting-token\n' }), hasCode('invalid_legacy_registry'))
})

test('group references, email ambiguity, and model-provider preferences fail closed', () => {
  const unknown = fixture(); unknown.groups[0].members.push('missing')
  assert.throws(() => compileAccountRegistry(unknown, { legacyAccounts: legacy }), hasCode('unknown_account_key'))
  const preference = fixture(); preference.groups[0].preferred.claude = 'primary-codex'
  assert.throws(() => compileAccountRegistry(preference, { legacyAccounts: legacy }), hasCode('invalid_group_preference'))
  const repeated = fixture(); repeated.groups[0].members.push('primary-claude')
  assert.throws(() => compileAccountRegistry(repeated, { legacyAccounts: legacy }), hasCode('duplicate_group_member'))
  const noDefault = fixture(); noDefault.routing.defaultGroup = 'missing'
  assert.throws(() => compileAccountRegistry(noDefault, { legacyAccounts: legacy }), hasCode('unknown_group_key'))
})

test('the same registered email in different workspaces requires an exact account selector', () => {
  const spec = fixture()
  spec.accounts[2].email = spec.accounts[0].email
  spec.accounts[2].workspaceId = 'separate-workspace'
  const value = compileAccountRegistry(spec, { legacyAccounts: legacy })
  assert.throws(() => previewPoolAccountSelection(value, { channelId: 'COWNER', provider: 'claude', account: 'primary@example.test' }), hasCode('ambiguous_account'))
  assert.equal(previewPoolAccountSelection(value, { channelId: 'COWNER', provider: 'claude', account: 'secondary' }).account.workspaceId, 'separate-workspace')
  spec.accounts[2].workspaceId = null
  assert.throws(() => compileAccountRegistry(spec, { legacyAccounts: legacy }), hasCode('duplicate_account_identity'))
})

test('valid owner keys cannot accidentally resolve Object prototype properties', () => {
  const spec = fixture()
  spec.accounts[0].key = 'constructor'
  spec.groups[0].members[0] = 'constructor'
  spec.groups[0].preferred.claude = 'constructor'
  spec.groups[0].key = 'toString'
  spec.routing.defaultGroup = 'toString'
  const value = compileAccountRegistry(spec, { legacyAccounts: legacy })
  assert.equal(previewPoolAccountSelection(value, { channelId: 'COWNER', provider: 'claude' }).account.key, 'constructor')
})

test('migration audit proposes only exact account corrections and preserves all session/task state', () => {
  const state = { channels: { CCLIENT1: 'management', CPROJECT99: 'person', COWNER: 'owner', CCODEX: 'codex', CPI: 'pi', CREMOTE: 'remote', CSTALE: 'replacement' },
    sessions: {
      management: { id: 'management', channel: 'CCLIENT1', account: 'secondary', teamActiveTaskId: 'private-task', model: 'opus', effort: 'max' },
      person: { id: 'person', channel: 'CPROJECT99', account: 'backup' },
      owner: { id: 'owner', channel: 'COWNER', account: 'secondary' },
      codex: { id: 'codex', channel: 'CCODEX', provider: 'codex' },
      pi: { id: 'pi', channel: 'CPI', provider: 'pi' },
      remote: { id: 'remote', channel: 'CREMOTE', nodeId: 'remote-node' },
      stale: { id: 'stale', channel: 'CSTALE', account: 'backup' },
      standby: { id: 'standby', provider: 'claude', channel: null, account: 'backup' },
    },
    lineages: { CCODEX: { activeProvider: 'codex', legs: { codex: 'codex', claude: 'standby' } } },
  }
  const before = structuredClone(state)
  const report = planAccountRegistryMigration(fixture(), { legacyAccounts: legacy, state })
  assert.deepEqual(state, before)
  assert.equal(report.readOnly, true)
  assert.equal(report.canActivate, false)
  const change = (sid, leg = 'active') => report.bindings.find(binding => binding.sessionId === sid && binding.leg === leg)
  assert.equal(change('management').action, 'account-correction-required')
  assert.equal(change('management').desiredEmail, 'client@example.test')
  assert.equal(change('person').desiredEmail, 'primary@example.test')
  assert.equal(change('owner').action, 'preserve')
  assert.equal(change('codex').action, 'preserve')
  assert.equal(change('pi').action, 'provider-not-managed')
  assert.equal(change('remote').action, 'requires-review')
  assert.equal(change('standby', 'standby').action, 'account-correction-required')
  assert.equal(change('stale'), undefined)
  assert.doesNotMatch(JSON.stringify(report), /private-task|"model"|"effort"|NEVER-PRINT/)
})

test('staging preserves stable opaque IDs, idempotency receipts, and prior revision history', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-stage-'))
  try {
    assert.equal(readAccountRegistry(temp), null)
    assert.equal(fs.existsSync(path.join(temp, 'account-pools')), false)
    const first = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    assert.equal(first.status, 'staged')
    assert.equal(first.registry.revision, 1)
    const retry = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    assert.equal(retry.status, 'already-staged')
    assert.deepEqual(retry.registry, first.registry)
    const updated = fixture(); updated.requestId = 'owner-enrollment-2'; updated.groups[0].name = 'Renamed owner'
    const second = stageAccountRegistry(temp, updated, { legacyAccounts: legacy, expectedRevision: 1 })
    assert.equal(second.registry.revision, 2)
    assert.deepEqual(second.registry.accounts.map(account => account.id), first.registry.accounts.map(account => account.id))
    assert.deepEqual(second.registry.groups.map(group => group.id), first.registry.groups.map(group => group.id))
    const lateRetry = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    assert.equal(lateRetry.status, 'already-staged')
    assert.equal(lateRetry.appliedRevision, 1)
    assert.equal(lateRetry.registry.revision, 2)
    const repeatedPlan = planAccountRegistryMigration(updated, { legacyAccounts: legacy, prior: readAccountRegistry(temp) })
    assert.equal(repeatedPlan.registry.revision, 2)
    assert.deepEqual(repeatedPlan.registry, second.registry)
    assert.deepEqual(fs.readdirSync(path.join(temp, 'account-pools')).sort(), ['revision-000001.json', 'revision-000002.json'])
    for (const file of fs.readdirSync(path.join(temp, 'account-pools'))) {
      assert.equal(fs.statSync(path.join(temp, 'account-pools', file)).mode & 0o777, 0o600)
      assert.doesNotMatch(fs.readFileSync(path.join(temp, 'account-pools', file), 'utf8'), /NEVER-PRINT|other-private-credential/)
    }
    assert.equal(fs.statSync(path.join(temp, 'account-pools')).mode & 0o777, 0o700)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('conflicting requests, stale revisions, credential drift, and identity-key reuse cannot overwrite a registry', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-conflict-'))
  try {
    stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    const conflict = fixture(); conflict.groups[0].name = 'Changed'
    assert.throws(() => stageAccountRegistry(temp, conflict, { legacyAccounts: legacy, expectedRevision: 1 }), hasCode('request_id_conflict'))
    conflict.requestId = 'new-request'
    assert.throws(() => stageAccountRegistry(temp, conflict, { legacyAccounts: legacy, expectedRevision: 0 }), hasCode('revision_conflict'))
    assert.throws(() => stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy.replace('other-private-credential', 'rotated'), expectedRevision: 1 }), hasCode('legacy_credentials_changed'))
    const renamedIdentity = fixture(); renamedIdentity.requestId = 'different-identity'; renamedIdentity.accounts[0].email = 'different@example.test'
    assert.throws(() => stageAccountRegistry(temp, renamedIdentity, { legacyAccounts: legacy, expectedRevision: 1 }), hasCode('identity_key_reuse'))
    assert.equal(readAccountRegistry(temp).revision, 1)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('explicit source-change enrollment requires a new request and preserves old receipts', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-source-enrollment-'))
  try {
    stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    const changedSource = legacy.replace('other-private-credential', 'rotated-private-credential')
    assert.throws(() => stageAccountRegistry(temp, fixture(), { legacyAccounts: changedSource, expectedRevision: 1, acceptSourceChange: true }), hasCode('legacy_credentials_changed'))
    const spec = fixture(); spec.requestId = 'reviewed-source-change'
    const result = stageAccountRegistry(temp, spec, { legacyAccounts: changedSource, expectedRevision: 1, acceptSourceChange: true })
    assert.equal(result.registry.revision, 2)
    assert.equal(readAccountRegistry(temp).receipts.length, 2)
    assert.doesNotMatch(JSON.stringify(result), /rotated-private-credential/)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('crash points expose either the old or committed registry and retry never duplicates the revision', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-crash-'))
  try {
    assert.throws(() => stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0,
      afterPrepared: () => { throw new Error('simulated interruption before publish') } }))
    assert.equal(readAccountRegistry(temp), null)
    assert.throws(() => stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0,
      afterCommitted: () => { throw new Error('simulated interruption after publish') } }))
    assert.equal(readAccountRegistry(temp).revision, 1)
    const retry = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    assert.equal(retry.status, 'already-staged')
    assert.equal(readAccountRegistry(temp).revision, 1)
    assert.deepEqual(fs.readdirSync(path.join(temp, 'account-pools')), ['revision-000001.json'])
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('simultaneous staging claims one immutable revision and preserves the winning IDs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-race-'))
  try {
    let winner
    const racing = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0,
      afterPrepared: () => { winner = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 }) } })
    assert.equal(winner.status, 'staged')
    assert.equal(racing.status, 'already-staged')
    assert.deepEqual(winner.registry, racing.registry)
    assert.equal(fs.readdirSync(path.join(temp, 'account-pools')).length, 1)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('registry reads reject insecure or malformed latest revisions, never fall back to older policy', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-read-'))
  try {
    stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    const dir = path.join(temp, 'account-pools')
    const next = path.join(dir, 'revision-000002.json')
    fs.writeFileSync(next, `{"private":"${secret}"`, { mode: 0o600 })
    assert.throws(() => readAccountRegistry(temp), hasCode('invalid_registry_file'))
    fs.unlinkSync(next)
    fs.chmodSync(path.join(dir, 'revision-000001.json'), 0o644)
    assert.throws(() => readAccountRegistry(temp), hasCode('insecure_registry_file'))
    assert.equal(fs.statSync(path.join(dir, 'revision-000001.json')).mode & 0o777, 0o644)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('registry paths reject symlinked directories, symlinked revisions, and public directories', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-paths-'))
  try {
    const actual = path.join(temp, 'actual'); fs.mkdirSync(actual, { mode: 0o700 })
    const root = path.join(temp, 'account-pools')
    fs.symlinkSync(actual, root)
    assert.throws(() => readAccountRegistry(temp), hasCode('insecure_registry_directory'))
    assert.throws(() => stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 }), hasCode('insecure_registry_directory'))
    fs.unlinkSync(root)
    stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    const revision = path.join(root, 'revision-000001.json')
    const outside = path.join(actual, 'policy.json'); fs.renameSync(revision, outside)
    fs.symlinkSync(outside, revision)
    assert.throws(() => readAccountRegistry(temp), hasCode('insecure_registry_file'))
    fs.unlinkSync(revision); fs.renameSync(outside, revision)
    fs.chmodSync(root, 0o755)
    assert.throws(() => readAccountRegistry(temp), hasCode('insecure_registry_directory'))
    assert.equal(fs.statSync(root).mode & 0o777, 0o755)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('a killed staging process leaves no lock and cannot duplicate a published revision on retry', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-killed-stage-'))
  const module = new URL('../daemon/account-registry-store.mjs', import.meta.url).href
  try {
    const run = point => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'
      import { stageAccountRegistry } from ${JSON.stringify(module)}
      const { spec, legacyAccounts, configDir } = JSON.parse(fs.readFileSync(0, 'utf8'))
      stageAccountRegistry(configDir, spec, { legacyAccounts, expectedRevision: 0,
        ${point}: () => process.kill(process.pid, 'SIGKILL') })
    `], { input: JSON.stringify({ spec: fixture(), legacyAccounts: legacy, configDir: temp }), encoding: 'utf8', timeout: 10000 })
    assert.equal(run('afterPrepared').signal, 'SIGKILL')
    assert.equal(readAccountRegistry(temp), null)
    assert.equal(run('afterCommitted').signal, 'SIGKILL')
    const committed = publicAccountRegistry(readAccountRegistry(temp))
    assert.equal(committed.revision, 1)
    const retry = stageAccountRegistry(temp, fixture(), { legacyAccounts: legacy, expectedRevision: 0 })
    assert.equal(retry.status, 'already-staged')
    assert.deepEqual(retry.registry, committed)
    assert.equal(fs.readdirSync(path.join(temp, 'account-pools')).filter(file => file.startsWith('revision-')).length, 1)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('registry CLI stages metadata only, leaves credentials and sessions unchanged, and never activates switching', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-registry-cli-'))
  const sab = new URL('../bin/sab', import.meta.url).pathname
  try {
    const configDir = path.join(temp, 'config'); fs.mkdirSync(configDir)
    const env = { PATH: process.env.PATH, HOME: temp, CCS_CONFIG_DIR: configDir }
    const run = (args, input) => spawnSync(sab, ['account', 'registry', ...args, '--json'], { env, encoding: 'utf8', input: input ? JSON.stringify(input) : undefined, timeout: 10000 })
    const status = run(['status'])
    assert.equal(status.status, 0, status.stderr)
    assert.equal(JSON.parse(status.stdout).mode, 'unconfigured')
    assert.equal(fs.existsSync(path.join(configDir, 'account-pools')), false)
    fs.writeFileSync(path.join(configDir, 'accounts'), legacy, { mode: 0o600 })
    const state = JSON.stringify({ channels: { CPROJECT99: 's1' }, sessions: { s1: { id: 's1', channel: 'CPROJECT99', account: 'backup', teamActiveTaskId: 'private-task' } } })
    fs.writeFileSync(path.join(configDir, 'state.json'), state, { mode: 0o600 })
    const plan = run(['plan', '--input', '-'], fixture())
    assert.equal(plan.status, 0, plan.stderr)
    assert.equal(JSON.parse(plan.stdout).bindings[0].action, 'account-correction-required')
    assert.equal(fs.existsSync(path.join(configDir, 'account-pools')), false)
    assert.notEqual(run(['stage', '--input', '-'], fixture()).status, 0)
    const staged = run(['stage', '--input', '-', '--expected-revision', '0'], fixture())
    assert.equal(staged.status, 0, staged.stderr)
    assert.equal(JSON.parse(staged.stdout).registry.mode, 'staged')
    const repeatedPlan = run(['plan', '--input', '-'], fixture())
    assert.equal(repeatedPlan.status, 0, repeatedPlan.stdout)
    assert.equal(JSON.parse(repeatedPlan.stdout).registry.revision, 1)
    const allowed = run(['check', '--channel', 'CCLIENT1', '--provider', 'claude', '--account', 'backup'])
    assert.equal(allowed.status, 0, allowed.stderr)
    assert.equal(JSON.parse(allowed.stdout).runtimeAllowed, false)
    const denied = run(['check', '--channel', 'CPROJECT99', '--provider', 'claude', '--account', 'backup'])
    assert.notEqual(denied.status, 0)
    assert.equal(JSON.parse(denied.stdout).error, 'account_outside_group')
    const badInput = run(['plan', '--input', '-'], { ...fixture(), token: secret })
    assert.equal(JSON.parse(badInput.stdout).error, 'invalid_enrollment')
    assert.doesNotMatch([plan, staged, denied, badInput].map(result => result.stdout + result.stderr).join(''), /NEVER-PRINT|private-task|other-private-credential/)
    assert.equal(fs.readFileSync(path.join(configDir, 'accounts'), 'utf8'), legacy)
    assert.equal(fs.readFileSync(path.join(configDir, 'state.json'), 'utf8'), state)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
