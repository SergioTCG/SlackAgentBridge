import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildAccountMigrationPreview, readAccountMigrationPreview } from '../daemon/account-discovery.mjs'

const sab = new URL('../bin/sab', import.meta.url).pathname
const secret = 'sk-ant-oat01-DO-NOT-PRINT-THIS-CREDENTIAL'
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`

test('preview keeps singleton alias groups but deduplicates identical credentials', () => {
  const report = buildAccountMigrationPreview({
    legacyAccounts: `desnahemisfera=${secret}\nbackup=${secret}\nother=different-private-token\n`,
  })
  const named = report.accounts.filter(account => account.kind === 'legacy-named')
  assert.equal(named.length, 2)
  assert.deepEqual(named.find(account => account.aliases.includes('backup')).aliases, ['backup', 'desnahemisfera'])
  const groups = report.groups.filter(group => group.kind === 'legacy-named')
  assert.equal(groups.length, 3)
  assert.equal(groups.find(group => group.name === 'backup').memberCandidateId,
    groups.find(group => group.name === 'desnahemisfera').memberCandidateId)
  assert.ok(groups.every(group => group.automaticSwitching === false))
  assert.equal(report.canApply, false)
  assert.equal(report.readOnly, true)
  assert.ok(report.issues.some(issue => issue.code === 'duplicate-credential-aliases'))
  assert.ok(named.every(account => account.identity.email === null))
  const output = JSON.stringify(report)
  assert.ok(!output.includes(secret))
  assert.ok(!output.includes('different-private-token'))
})

test('conflicting, empty, unsafe, and duplicate registry entries fail closed without echoing contents', () => {
  const report = buildAccountMigrationPreview({
    legacyAccounts: `conflict=${secret}\nconflict=another-secret\nempty=\nunsafe email=${secret}\nno-equals-secret\nvalid=${secret}\nvalid=${secret}\n`,
  })
  assert.equal(report.groups.find(group => group.name === 'conflict').memberCandidateId, null)
  assert.equal(report.groups.find(group => group.name === 'empty').memberCandidateId, null)
  assert.equal(report.groups.filter(group => group.name === 'valid').length, 1)
  assert.ok(report.issues.some(issue => issue.code === 'conflicting-alias'))
  assert.ok(report.issues.some(issue => issue.code === 'empty-credential'))
  assert.ok(report.issues.some(issue => issue.code === 'invalid-registry-entry'))
  assert.doesNotMatch(JSON.stringify(report), /DO-NOT-PRINT|another-secret|unsafe email|no-equals-secret/)
})

test('cached email claims are candidates, never authenticated identities or a reason to merge accounts', () => {
  const report = buildAccountMigrationPreview({
    legacyAccounts: `named=${secret}\n`,
    claudeMetadata: { oauthAccount: { emailAddress: 'same@example.com', accountUuid: 'subject-claude' }, secret },
    codexAuth: { tokens: { id_token: jwt({ email: 'same@example.com', sub: 'subject-codex' }), access_token: secret, refresh_token: secret } },
  })
  const claude = report.accounts.find(account => account.id === 'candidate:claude:native-default')
  const codex = report.accounts.find(account => account.id === 'candidate:codex:native-default')
  assert.equal(claude.identity.email, 'same@example.com')
  assert.equal(codex.identity.email, 'same@example.com')
  assert.equal(claude.identity.verification, 'cached-unverified')
  assert.equal(codex.identity.verification, 'cached-unverified')
  assert.notEqual(claude.id, codex.id)
  assert.equal(report.accounts.find(account => account.kind === 'legacy-named').identity.email, null)
  assert.doesNotMatch(JSON.stringify(report), /DO-NOT-PRINT|subject-claude|subject-codex|signature|access_token|refresh_token/)
})

test('API credentials, environment overrides, and invalid JWTs do not borrow a cached login email', () => {
  for (const codexAuth of [
    { OPENAI_API_KEY: secret, tokens: { id_token: jwt({ email: 'stale@example.com' }) } },
    { auth_mode: 'apikey', tokens: { id_token: jwt({ email: 'stale@example.com' }) } },
    { tokens: { id_token: 'malformed-token' } },
  ]) {
    const report = buildAccountMigrationPreview({ codexAuth })
    assert.equal(report.accounts.find(account => account.provider === 'codex').identity.email, null)
  }
  const report = buildAccountMigrationPreview({
    claudeMetadata: { oauthAccount: { emailAddress: 'stale@example.com' } },
    codexAuth: { tokens: { id_token: jwt({ email: 'stale@example.com' }) } },
    environmentOverrides: { claude: true, codex: true },
  })
  assert.ok(report.accounts.every(account => account.identity.email === null))
  assert.ok(report.issues.some(issue => issue.code === 'native-auth-environment-override'))
})

test('preview maps only authoritative local bindings, preserves implicit Claude, and does not mutate state', () => {
  const state = {
    channels: { COWNER: 'old', CCODEX: 'codex', CREMOTE: 'remote', CUNKNOWN: 'unknown', CSTALE: 'replacement' },
    sessions: {
      old: { id: 'old', channel: 'COWNER', account: 'work', pid: 123, teamActiveTaskId: 'task-private', pending: secret },
      codex: { id: 'codex', channel: 'CCODEX', provider: 'codex' },
      remote: { id: 'remote', channel: 'CREMOTE', provider: 'claude', nodeId: 'remote-node', account: 'work' },
      unknown: { id: 'unknown', channel: 'CUNKNOWN', account: 'missing' },
      stale: { id: 'stale', channel: 'CSTALE', account: 'work' },
      standby: { id: 'standby', account: 'work' },
    },
  }
  const before = structuredClone(state)
  const report = buildAccountMigrationPreview({ legacyAccounts: `work=${secret}`, state })
  assert.deepEqual(state, before)
  assert.equal(report.bindings.length, 4)
  assert.equal(report.bindings.find(binding => binding.sessionId === 'old').provider, 'claude')
  assert.ok(report.bindings.find(binding => binding.sessionId === 'old').proposedGroupId)
  assert.equal(report.bindings.find(binding => binding.sessionId === 'remote').proposedGroupId, null)
  assert.equal(report.bindings.find(binding => binding.sessionId === 'unknown').proposedGroupId, null)
  assert.doesNotMatch(JSON.stringify(report), /task-private|DO-NOT-PRINT|pending|pid/)
})

test('explicit channel-node mismatches cannot be proposed as local migration bindings', () => {
  const report = buildAccountMigrationPreview({
    state: {
      channels: { CBOUND: 's1' }, channelNodes: { CBOUND: 'remote-node' },
      sessions: { s1: { id: 's1', channel: 'CBOUND', provider: 'codex' } },
    },
  })
  assert.equal(report.bindings[0].proposedGroupId, null)
  assert.ok(report.issues.some(issue => issue.code === 'nonlocal-or-mismatched-node'))
})

test('preview uses the canonical compatibility rules for empty legacy node claims', () => {
  const report = buildAccountMigrationPreview({ state: {
    channels: { CBOUND: 's1' }, channelNodes: { CBOUND: '' },
    sessions: { s1: { id: 's1', channel: 'CBOUND', nodeId: '', provider: 'codex' } },
  } })
  assert.ok(report.bindings[0].proposedGroupId)
})

test('registry diagnostics and candidate output remain bounded on malformed or excessive input', () => {
  const report = buildAccountMigrationPreview({ legacyAccounts: 'malformed\n'.repeat(5000) })
  assert.ok(report.issues.some(issue => issue.code === 'too-many-registry-entries'))
  assert.ok(report.issues.length < 1100)
})

test('preview is deterministic across registry row order, does not equate different tokens, and filters providers', () => {
  const a = buildAccountMigrationPreview({ legacyAccounts: `a=${secret}\nb=different\nc=${secret}\n` })
  const b = buildAccountMigrationPreview({ legacyAccounts: `c=${secret}\nb=different\na=${secret}\n` })
  assert.deepEqual(a, b)
  assert.equal(a.accounts.filter(account => account.kind === 'legacy-named').length, 2)
  const codex = buildAccountMigrationPreview({ provider: 'codex', legacyAccounts: `a=${secret}` })
  assert.ok(codex.accounts.every(account => account.provider === 'codex'))
  assert.ok(codex.groups.every(group => group.provider === 'codex'))
})

test('read-only preview never creates or chmods configuration and redacts malformed file errors', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-preview-'))
  try {
    const configDir = path.join(temp, 'config')
    const options = { home: temp, configDir, env: {} }
    readAccountMigrationPreview(options)
    assert.equal(fs.existsSync(configDir), false)
    fs.mkdirSync(configDir)
    fs.writeFileSync(path.join(configDir, 'accounts'), `work=${secret}\n`, { mode: 0o640 })
    fs.writeFileSync(path.join(configDir, 'state.json'), `{"secret":"${secret}"`, { mode: 0o600 })
    const before = fs.statSync(path.join(configDir, 'accounts'))
    const report = readAccountMigrationPreview(options)
    assert.equal(fs.statSync(path.join(configDir, 'accounts')).mode, before.mode)
    assert.equal(fs.readFileSync(path.join(configDir, 'accounts'), 'utf8'), `work=${secret}\n`)
    assert.ok(report.issues.some(issue => issue.code === 'source-permissions'))
    assert.ok(report.issues.some(issue => issue.code === 'source-invalid-json'))
    assert.doesNotMatch(JSON.stringify(report), /DO-NOT-PRINT/)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('read-only discovery rejects nonregular and oversized sources without reading a transcript', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-source-'))
  try {
    const configDir = path.join(temp, 'config')
    fs.mkdirSync(path.join(configDir, 'accounts'), { recursive: true })
    fs.writeFileSync(path.join(configDir, 'state.json'), 'x'.repeat((32 << 20) + 1))
    const report = readAccountMigrationPreview({ home: temp, configDir, env: {} })
    assert.ok(report.issues.some(issue => issue.code === 'source-not-regular'))
    assert.ok(report.issues.some(issue => issue.code === 'source-too-large'))
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('public account preview is JSON-safe, read-only, and backward-compatible with legacy account set', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-cli-'))
  try {
    const configDir = path.join(temp, 'config')
    const env = { PATH: process.env.PATH, HOME: temp, CCS_CONFIG_DIR: configDir, CODEX_HOME: path.join(temp, 'codex') }
    const run = (...args) => spawnSync(sab, ['account', ...args], { env, encoding: 'utf8', timeout: 10000 })
    const empty = run('preview', '--json')
    assert.equal(empty.status, 0, empty.stderr)
    assert.equal(JSON.parse(empty.stdout).readOnly, true)
    assert.equal(fs.existsSync(configDir), false)
    const capabilities = run('capabilities', '--json')
    assert.equal(capabilities.status, 0, capabilities.stderr)
    assert.ok(JSON.parse(capabilities.stdout).providers.every(provider => provider.installedProbe.status === 'not-run'))
    assert.equal(fs.existsSync(configDir), false)
    const set = spawnSync(sab, ['account', 'set', 'work'], { env, encoding: 'utf8', input: `${secret}\n` })
    assert.equal(set.status, 0, set.stderr)
    const before = fs.readFileSync(path.join(configDir, 'accounts'), 'utf8')
    const preview = run('preview', '--json')
    assert.equal(preview.status, 0, preview.stderr)
    assert.ok(JSON.parse(preview.stdout).groups.some(group => group.name === 'work'))
    assert.doesNotMatch(preview.stdout + preview.stderr, /DO-NOT-PRINT/)
    assert.equal(fs.readFileSync(path.join(configDir, 'accounts'), 'utf8'), before)
    const rejected = run('preview', '--json', '--apply')
    assert.notEqual(rejected.status, 0)
    assert.equal(JSON.parse(rejected.stdout).ok, false)
    assert.equal(fs.readFileSync(path.join(configDir, 'accounts'), 'utf8'), before)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
