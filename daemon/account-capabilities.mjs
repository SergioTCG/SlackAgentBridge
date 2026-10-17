// Documentation + isolated public CLI schema evidence only. No live account,
// RPC, inference, native conversation, bridge hook, or lifecycle is exercised.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function accountCapabilities({ provider = 'all' } = {}) {
  if (!['all', 'claude', 'codex'].includes(provider)) throw new Error('invalid account provider')
  const providers = [
    { provider: 'claude', identityInterface: 'claude auth status (credential-dependent)',
      quotaInterface: 'statusLine.rate_limits', inactiveQuotaRefresh: 'unproven',
      crossAccountResume: 'requires-controlled-proof', installedProbe: { status: 'not-run' },
      sources: ['https://code.claude.com/docs/en/authentication', 'https://code.claude.com/docs/en/statusline'] },
    { provider: 'codex', identityInterface: 'account/read',
      quotaInterface: 'account/rateLimits/read', inactiveQuotaRefresh: 'documented-not-live-proven',
      crossAccountResume: 'requires-controlled-proof', installedProbe: { status: 'not-run' },
      sources: ['https://learn.chatgpt.com/docs/auth', 'https://learn.chatgpt.com/docs/app-server'] },
  ]
  return { schemaVersion: 1, readOnly: true, automaticSwitching: false,
    providers: providers.filter(entry => provider === 'all' || entry.provider === provider) }
}

export function codexSchemaEvidence({ clientRequest, accountResponse, limitsResponse } = {}) {
  const method = name => (clientRequest?.oneOf || []).some(entry => entry?.properties?.method?.enum?.includes(name))
  const chatgpt = accountResponse?.definitions?.Account?.oneOf?.find(entry => entry?.properties?.type?.enum?.includes('chatgpt'))
  const emailType = chatgpt?.properties?.email?.type
  const window = limitsResponse?.definitions?.RateLimitWindow?.properties
  const limits = limitsResponse?.properties
  return {
    accountIdentity: method('account/read') && Boolean(accountResponse?.properties?.account) &&
      (emailType === 'string' || Array.isArray(emailType) && emailType.includes('string')),
    quotaPolling: method('account/rateLimits/read') && Boolean(limits?.rateLimits && window?.usedPercent && window?.resetsAt),
    multipleQuotaBuckets: Boolean(limits?.rateLimitsByLimitId),
    explicitAccountBinding: Boolean(limits?.accountId),
    backendUsagePermission: Boolean(limits?.ordinaryUsageAllowed),
  }
}

function findBinary(name, env) {
  // Ignore relative PATH entries so a project-local lookalike is not executed
  // after we change to the disposable probe directory.
  for (const dir of String(env.PATH || '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue
    const file = path.join(dir, name)
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file } catch {}
  }
  return null
}

function schemaFile(dir, name) {
  const file = path.join(dir, name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.size > (4 << 20)) throw new Error('invalid generated schema')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function probeAccountCapabilities({ provider = 'all', env = process.env,
  tempRoot = os.tmpdir(), run = spawnSync, resolveBinary = name => findBinary(name, env),
} = {}) {
  const report = accountCapabilities({ provider })
  for (const entry of report.providers) {
    const binary = resolveBinary(entry.provider)
    if (!binary) { entry.installedProbe = { status: 'unavailable' }; continue }
    const temp = fs.mkdtempSync(path.join(tempRoot, 'sab-account-capability-'))
    try {
      const probeEnv = {
        PATH: env.PATH || '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin',
        CODEX_HOME: path.join(temp, 'codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
        TMPDIR: temp, NO_COLOR: '1', DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }
      const options = { cwd: temp, env: probeEnv, encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 20 }
      const version = run(binary, ['--version'], options)
      const versionNumber = version.status === 0 ? String(version.stdout).match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0] : null
      if (!versionNumber) { entry.installedProbe = { status: 'failed' }; continue }
      if (entry.provider === 'claude') {
        const help = run(binary, ['auth', 'status', '--help'], options)
        const supported = help.status === 0 && /Usage: claude auth status/.test(help.stdout) && /--json\b/.test(help.stdout)
        entry.installedProbe = { status: supported ? 'public-help-confirmed' : 'failed', version: versionNumber,
          jsonAuthStatusCommand: supported }
      } else {
        const out = path.join(temp, 'schema')
        const generated = run(binary, ['app-server', 'generate-json-schema', '--out', out], options)
        if (generated.status !== 0) { entry.installedProbe = { status: 'failed', version: versionNumber }; continue }
        const schema = codexSchemaEvidence({
          clientRequest: schemaFile(out, 'ClientRequest.json'),
          accountResponse: schemaFile(out, 'v2/GetAccountResponse.json'),
          limitsResponse: schemaFile(out, 'v2/GetAccountRateLimitsResponse.json'),
        })
        entry.installedProbe = { status: schema.accountIdentity && schema.quotaPolling ? 'public-schema-confirmed' : 'partial',
          version: versionNumber, schema }
      }
    } catch {
      // Native stderr, filesystem paths, parse fragments, and arbitrary provider
      // errors never enter the public report.
      entry.installedProbe = { status: 'failed' }
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  }
  return report
}
