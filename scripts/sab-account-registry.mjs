#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import {
  AccountRegistryError, planAccountRegistryMigration, previewPoolAccountSelection, publicAccountRegistry,
} from '../daemon/account-registry.mjs'
import { readAccountRegistry, readPrivateAccountFile, stageAccountRegistry } from '../daemon/account-registry-store.mjs'
import { buildAccountMigrationPreview } from '../daemon/account-discovery.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const configDir = process.env.CCS_CONFIG_DIR || path.join(os.homedir(), '.config/ccs')
let operation
try {
  operation = args.shift()
  const allowed = {
    list: ['--json'], 'guard-remove': [],
    status: ['--json'], plan: ['--json', '--input', '--accept-source-change'], stage: ['--json', '--input', '--expected-revision', '--accept-source-change'],
    check: ['--json', '--channel', '--provider', '--account'],
  }
  if (!Object.hasOwn(allowed, operation)) throw new AccountRegistryError('invalid_registry_command')
  const options = {}
  while (args.length) {
    const flag = args.shift()
    if (!allowed[operation].includes(flag) || Object.hasOwn(options, flag)) throw new AccountRegistryError('invalid_registry_option')
    options[flag] = ['--json', '--accept-source-change'].includes(flag) ? true : args.shift()
    if (options[flag] === undefined) throw new AccountRegistryError('invalid_registry_option')
  }
  let report
  if (operation === 'guard-remove') {
    const alias = process.env.CCS_ACCOUNT_REMOVE
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias || '')) throw new AccountRegistryError('invalid_account_selector')
    const registry = readAccountRegistry(configDir)
    const state = readPrivateAccountFile(path.join(configDir, 'state.json'), { missing: {}, json: true, maxBytes: 32 << 20 })
    if (registry?.spec.accounts.some(a => a.credentials.some(r => r.kind === 'legacy-claude' && r.alias === alias)) ||
        Object.values(state.sessions || {}).some(s => (s.provider || 'claude') === 'claude' && s.account === alias && s.accountKind !== 'claude-profile')) {
      throw new AccountRegistryError('account_in_use_drain_first')
    }
    report = { removable: true }
  } else if (operation === 'list') {
    const registry = readAccountRegistry(configDir)
    if (registry) {
      const view = publicAccountRegistry(registry)
      report = { mode: 'staged', revision: view.revision, accounts: view.accounts.map(a => ({ id: a.id, provider: a.provider, email: a.email,
        lifecycle: a.lifecycle, groups: view.groups.filter(g => g.members.includes(a.id)).map(g => g.name) })) }
    } else {
      const text = readPrivateAccountFile(path.join(configDir, 'accounts'), { missing: '' })
      const preview = buildAccountMigrationPreview({ provider: 'claude', legacyAccounts: text })
      if (preview.issues.some(i => i.severity === 'blocking' && i.code !== 'identity-verification-required')) throw new AccountRegistryError('invalid_legacy_registry')
      report = { mode: 'legacy', accounts: preview.accounts.filter(a => a.kind === 'legacy-named').flatMap(a => a.aliases.map(alias => ({ alias, identity: 'not-enrolled' }))) }
    }
  } else if (operation === 'status') {
    const value = readAccountRegistry(configDir)
    report = value ? publicAccountRegistry(value) : { schemaVersion: 1, mode: 'unconfigured', revision: 0, automaticSwitching: false }
  } else if (operation === 'check') {
    const value = readAccountRegistry(configDir)
    if (!value) throw new AccountRegistryError('registry_not_staged')
    report = previewPoolAccountSelection(value, { channelId: options['--channel'], provider: options['--provider'], account: options['--account'] ?? null })
  } else {
    const input = options['--input']
    if (!input) throw new AccountRegistryError('enrollment_input_required')
    let spec
    if (input === '-') {
      let text = ''
      process.stdin.setEncoding('utf8')
      for await (const chunk of process.stdin) {
        text += chunk
        if (Buffer.byteLength(text) > (1 << 20)) throw new AccountRegistryError('registry_input_too_large')
      }
      try { spec = JSON.parse(text) } catch { throw new AccountRegistryError('invalid_enrollment') }
    } else {
      spec = readPrivateAccountFile(path.resolve(input), { json: true })
      if (!spec) throw new AccountRegistryError('enrollment_input_required')
    }
    const legacyAccounts = readPrivateAccountFile(path.join(configDir, 'accounts'), { missing: '' })
    if (operation === 'stage') {
      const expected = options['--expected-revision']
      if (!/^(?:0|[1-9][0-9]{0,3})$/.test(expected || '')) throw new AccountRegistryError('expected_revision_required')
      report = stageAccountRegistry(configDir, spec, { legacyAccounts, expectedRevision: Number(expected), acceptSourceChange: options['--accept-source-change'] === true })
    } else {
      const state = readPrivateAccountFile(path.join(configDir, 'state.json'), { missing: {}, json: true, maxBytes: 32 << 20 })
      report = planAccountRegistryMigration(spec, { legacyAccounts, state, prior: readAccountRegistry(configDir), acceptSourceChange: options['--accept-source-change'] === true })
    }
  }
  if (json) process.stdout.write(JSON.stringify(report) + '\n')
  else if (operation === 'list') process.stdout.write(report.accounts.map(a => a.email ? `${a.provider}: ${a.email} [${a.groups.join(', ')}] (${a.lifecycle})` : `${a.alias} (email not enrolled)`).join('\n') + '\n')
  else {
    const registry = report.registry || report
    process.stdout.write([
      `Account registry: ${report.status || registry.mode || 'policy preview'}; automatic switching disabled.`,
      ...(registry.accounts ? [`${registry.accounts.length} account(s), ${registry.groups.length} group(s), revision ${registry.revision}.`] : []),
      ...(report.summary ? [`${report.summary.corrections} account correction(s) proposed; ${report.summary.reviews} binding(s) need review.`] : []),
      ...(report.policyAllowed ? [`Policy permits ${report.account.email} in ${report.group.name}; runtime activation remains disabled.`] : []),
      'No live session, credential, or legacy binding was changed. Use --json for metadata.',
    ].join('\n') + '\n')
  }
} catch (error) {
  const code = error instanceof AccountRegistryError ? error.code : 'account_registry_failed'
  const result = { ok: false, error: code, runtimeChanged: false }
  if (json) process.stdout.write(JSON.stringify(result) + '\n')
  else process.stderr.write(`sab account registry: ${code}. No live session was changed.\n`)
  process.exitCode = 2
}
