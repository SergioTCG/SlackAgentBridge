import test from 'node:test'
import assert from 'node:assert/strict'
import { compileAccountRegistry, publicAccountRegistry } from '../daemon/account-registry.mjs'
import { editAccountRegistry } from '../daemon/account-management.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { stageAccountRegistry, manageAccountRegistry, readAccountRegistry } from '../daemon/account-registry-store.mjs'

const fixture = () => compileAccountRegistry({ schemaVersion: 1, requestId: 'enroll', accounts: [
  { key: 'one', provider: 'claude', email: 'one@example.test', identityConfirmed: true, credentials: [{ kind: 'native-default' }] },
  { key: 'two', provider: 'claude', email: 'two@example.test', identityConfirmed: true, credentials: [{ kind: 'claude-profile', profile: 'two' }] },
], groups: [{ key: 'mine', name: 'Mine', members: ['one', 'two'], preferred: { claude: 'one' } }], routing: { defaultGroup: 'mine', channels: {} } })
const edit = (r, operation, usage = {}) => editAccountRegistry(r, { requestId: 'edit-1', expectedRevision: r.revision, operation }, { usage })

test('group management supports creation, rename, membership, preferences, routing, and removal without changing account identity', () => {
  const r = fixture(), before = structuredClone(r)
  const spec = edit(r, { type: 'group-create', key: 'new', name: 'New group', members: ['two'] })
  const next = compileAccountRegistry(spec, { prior: r })
  assert.equal(publicAccountRegistry(next).groups.length, 2)
  assert.deepEqual(r, before)
  assert.equal(edit(next, { type: 'group-rename', group: 'new', name: 'Renamed' }).groups.find(g => g.key === 'new').name, 'Renamed')
  assert.equal(edit(next, { type: 'group-add', group: 'new', account: 'one' }).groups.find(g => g.key === 'new').members.length, 2)
  assert.equal(edit(next, { type: 'group-prefer', group: 'mine', account: 'two' }).groups.find(g => g.key === 'mine').preferred.claude, 'two')
  assert.equal(edit(next, { type: 'channel-group', channel: 'CFIXTURE', group: 'new' }).routing.channels.CFIXTURE, 'new')
  assert.equal(edit(next, { type: 'group-remove', group: 'new' }).groups.length, 1)
  assert.throws(() => edit(r, { type: 'group-remove', group: 'mine' }), /group_is_routed/)
})

test('management retries derive original immutable bytes, not a second mutation of newer policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-edit-'))
  try {
    stageAccountRegistry(root, fixture().spec, { expectedRevision: 0 })
    const request = { requestId: 'first-edit', expectedRevision: 1, operation: { type: 'group-rename', group: 'mine', name: 'Renamed' } }
    assert.equal(manageAccountRegistry(root, request).appliedRevision, 2)
    manageAccountRegistry(root, { requestId: 'second-edit', expectedRevision: 2, operation: { type: 'group-rename', group: 'mine', name: 'Latest' } })
    const result = manageAccountRegistry(root, request)
    assert.equal(result.status, 'already-staged')
    assert.equal(result.registry.revision, 3)
    assert.equal(result.registry.groups[0].name, 'Latest')
    assert.throws(() => manageAccountRegistry(root, { ...request, operation: { ...request.operation, name: 'Wrong retry' } }), /request_id_conflict/)
    assert.equal(readAccountRegistry(root).revision, 3)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('public account list shows email/group identities without token fragments; legacy removal cannot strand a binding', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-housekeeping-'))
  try {
    const command = args => spawnSync(new URL('../bin/sab', import.meta.url).pathname, ['account', ...args], {
      env: { PATH: process.env.PATH, HOME: root, CCS_CONFIG_DIR: root }, encoding: 'utf8', timeout: 10000 })
    fs.writeFileSync(path.join(root, 'accounts'), 'old=PRIVATE-NEVER-SHOW-FRAGMENTS\n', { mode: 0o600 })
    const initial = command(['list', '--json'])
    assert.equal(initial.status, 0, initial.stderr)
    assert.deepEqual(JSON.parse(initial.stdout).accounts, [{ alias: 'old', identity: 'not-enrolled' }])
    assert.doesNotMatch(initial.stdout, /PRIVATE|FRAGMENTS/)
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ sessions: { s: { id: 's', account: 'old' } } }), { mode: 0o600 })
    assert.notEqual(command(['remove', 'old']).status, 0)
    assert.equal(fs.readFileSync(path.join(root, 'accounts'), 'utf8'), 'old=PRIVATE-NEVER-SHOW-FRAGMENTS\n')
    const spec = fixture().spec
    spec.accounts[1].credentials.push({ kind: 'legacy-claude', alias: 'old' })
    stageAccountRegistry(root, spec, { expectedRevision: 0, legacyAccounts: 'old=PRIVATE-NEVER-SHOW-FRAGMENTS\n' })
    const listed = command(['list'])
    assert.equal(listed.status, 0)
    assert.match(listed.stdout, /one@example.test \[Mine\]/)
    assert.doesNotMatch(listed.stdout, /PRIVATE|FRAGMENTS/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('a full Claude profile can be attached without deleting legacy aliases or interrupting their live sessions', () => {
  const r = fixture()
  r.spec.accounts[1].credentials = [{ kind: 'legacy-claude', alias: 'old' }]
  const enrolled = compileAccountRegistry({ ...r.spec, requestId: 'with-legacy' }, { legacyAccounts: 'old=PRIVATE\n' })
  const spec = edit(enrolled, { type: 'account-credential', account: 'two', provider: 'claude', profile: 'full' }, { [enrolled.history.accounts.two.id]: ['CFIXTURE'] })
  assert.deepEqual(spec.accounts.find(a => a.key === 'two').credentials, [{ kind: 'legacy-claude', alias: 'old' }, { kind: 'claude-profile', profile: 'full' }])
})

test('in-use account removal is an explicit drain, with no force kill or credential deletion', () => {
  const r = fixture(), id = r.history.accounts.two.id
  assert.throws(() => edit(r, { type: 'account-retire', account: 'two' }, { [id]: ['CFIXTURE'] }), /account_in_use/)
  const spec = edit(r, { type: 'account-drain', account: 'two' }, { [id]: ['CFIXTURE'] })
  assert.equal(spec.accounts.find(a => a.key === 'two').lifecycle, 'draining')
  assert.deepEqual(spec.accounts.find(a => a.key === 'two').credentials, [{ kind: 'claude-profile', profile: 'two' }])
  const next = compileAccountRegistry(spec, { prior: r })
  assert.equal(edit(next, { type: 'account-retire', account: 'two' }).accounts.find(a => a.key === 'two').lifecycle, 'retired')
  assert.throws(() => edit(r, { type: 'group-delete-member', group: 'mine', account: 'two' }, { [id]: ['CFIXTURE'] }), /account_in_use/)
  assert.deepEqual(edit(r, { type: 'group-drain-member', group: 'mine', account: 'two' }).groups[0].drainingMembers, ['two'])
})

test('edits reject stale revisions, unknown fields, wrong preferences, and route changes with incompatible live bindings', () => {
  const r = fixture()
  assert.throws(() => editAccountRegistry(r, { requestId: 'x', expectedRevision: 0, operation: { type: 'group-rename', group: 'mine', name: 'X' } }), /revision_conflict/)
  assert.throws(() => edit(r, { type: 'account-drain', account: 'one', token: 'NEVER' }), /invalid_account_edit/)
  assert.throws(() => edit(r, { type: 'group-prefer', group: 'missing', account: 'one' }), /unknown_group/)
  assert.throws(() => edit(r, { type: 'account-retire', account: 'one' }), /account_is_preferred/)
})
