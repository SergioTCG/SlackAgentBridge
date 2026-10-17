#!/usr/bin/env node
import { readAccountMigrationPreview } from '../daemon/account-discovery.mjs'
import { accountCapabilities, probeAccountCapabilities } from '../daemon/account-capabilities.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
try {
  const command = args.shift()
  if (!['preview', 'capabilities'].includes(command)) throw new Error('invalid_command')
  let provider = 'all'
  let probe = false
  const seen = new Set()
  while (args.length) {
    const flag = args.shift()
    if (seen.has(flag)) throw new Error('duplicate_option')
    seen.add(flag)
    if (flag === '--json') continue
    if (flag === '--provider') {
      provider = args.shift()
      if (!['all', 'claude', 'codex'].includes(provider)) throw new Error('invalid_provider')
    } else if (flag === '--probe' && command === 'capabilities') probe = true
    else throw new Error('unsupported_option')
  }
  const report = command === 'preview' ? readAccountMigrationPreview({ provider })
    : probe ? probeAccountCapabilities({ provider }) : accountCapabilities({ provider })
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`)
  else if (command === 'preview') {
    const lines = ['Account migration preview — read-only; no migration or switching is enabled.',
      `${report.summary.namedAliases} named alias(es), ${report.summary.distinctStoredCredentials} distinct stored credential(s).`,
      `${report.summary.authoritativeBindings} authoritative binding(s); ${report.summary.bindingsRequiringReview} require mapping review.`]
    for (const account of report.accounts) {
      lines.push(`  ${account.provider}: ${account.aliases.join(', ') || 'native default'} → ${account.identity.email || 'email unresolved'} (${account.identity.verification})`)
    }
    lines.push('Review: ' + [...new Set(report.issues.map(issue => issue.code))].join(', '),
      'Cached emails are unverified hints; different tokens may still share an account/quota.',
      'Use --json for the proposed singleton groups and exact binding map.')
    process.stdout.write(lines.join('\n') + '\n')
  } else {
    const lines = ['Account capabilities — no login, RPC, inference, or session restart.']
    for (const entry of report.providers) {
      lines.push(`  ${entry.provider}: ${entry.installedProbe.status}; identity: ${entry.identityInterface}; quota: ${entry.quotaInterface}`,
        `    Inactive usage refresh: ${entry.inactiveQuotaRefresh}; cross-account resume: ${entry.crossAccountResume}.`)
    }
    lines.push('Use --probe for disposable, credential-free installed CLI help/schema checks.')
    process.stdout.write(lines.join('\n') + '\n')
  }
} catch (error) {
  // Whitelist our own error codes. Never echo an argv value or raw exception.
  const code = ['invalid_command', 'duplicate_option', 'invalid_provider', 'unsupported_option'].includes(error.message)
    ? error.message : 'account_inspection_failed'
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, readOnly: true, error: code })}\n`)
  else process.stderr.write(`sab account: ${code}. Use preview [--provider claude|codex|all] [--json] or capabilities [--probe] [--provider claude|codex|all] [--json].\n`)
  process.exitCode = 2
}
