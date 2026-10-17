import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { accountCapabilities, codexSchemaEvidence, probeAccountCapabilities } from '../daemon/account-capabilities.mjs'

const schemas = () => ({
  clientRequest: { oneOf: ['account/read', 'account/rateLimits/read'].map(method => ({ properties: { method: { enum: [method] } } })) },
  accountResponse: { properties: { account: {} }, definitions: { Account: { oneOf: [{ properties: { type: { enum: ['chatgpt'] }, email: { type: ['string', 'null'] } } }] } } },
  limitsResponse: { properties: { rateLimits: {}, rateLimitsByLimitId: {}, accountId: {}, ordinaryUsageAllowed: {} }, definitions: { RateLimitWindow: { properties: { usedPercent: {}, resetsAt: {}, windowDurationMins: {} } } } },
})

test('documented capabilities never imply live account, inactive Claude polling, or cross-account resume proof', () => {
  const report = accountCapabilities()
  assert.equal(report.readOnly, true)
  assert.equal(report.automaticSwitching, false)
  assert.ok(report.providers.every(provider => provider.installedProbe.status === 'not-run'))
  assert.ok(report.providers.every(provider => provider.crossAccountResume === 'requires-controlled-proof'))
  assert.equal(report.providers.find(provider => provider.provider === 'claude').inactiveQuotaRefresh, 'unproven')
  assert.equal(report.providers.find(provider => provider.provider === 'codex').quotaInterface, 'account/rateLimits/read')
})

test('Codex proof checks structured methods and fields, not words in a description', () => {
  const proof = codexSchemaEvidence(schemas())
  assert.equal(proof.accountIdentity, true)
  assert.equal(proof.quotaPolling, true)
  assert.equal(proof.explicitAccountBinding, true)
  assert.equal(proof.backendUsagePermission, true)
  const mentions = codexSchemaEvidence({
    clientRequest: { description: 'account/read account/rateLimits/read' },
    accountResponse: { description: 'email' }, limitsResponse: { description: 'usedPercent resetsAt accountId' },
  })
  assert.equal(mentions.accountIdentity, false)
  assert.equal(mentions.quotaPolling, false)
})

test('isolated capability probes use only help/schema commands and never inherit credentials or bridge authority', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-capability-test-'))
  const calls = []
  try {
    const run = (binary, args, options) => {
      calls.push({ binary, args, env: options.env, cwd: options.cwd })
      assert.equal(options.env.SLACK_BOT_TOKEN, undefined)
      assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
      assert.equal(options.env.OPENAI_API_KEY, undefined)
      assert.equal(options.env.CCS_BRIDGE, undefined)
      assert.equal(options.env.TMUX, undefined)
      assert.equal(options.env.CODEX_THREAD_ID, undefined)
      assert.notEqual(options.env.CODEX_HOME, '/real-codex-home')
      assert.notEqual(options.env.CLAUDE_CONFIG_DIR, '/real-claude-home')
      assert.ok(options.cwd.startsWith(temp))
      if (args.includes('generate-json-schema')) {
        const dir = args[args.indexOf('--out') + 1]
        fs.mkdirSync(path.join(dir, 'v2'), { recursive: true })
        const schema = schemas()
        for (const [name, value] of [['ClientRequest.json', schema.clientRequest], ['v2/GetAccountResponse.json', schema.accountResponse], ['v2/GetAccountRateLimitsResponse.json', schema.limitsResponse]]) {
          fs.writeFileSync(path.join(dir, name), JSON.stringify(value))
        }
        return { status: 0, stdout: '', stderr: '' }
      }
      if (args.includes('--version')) return { status: 0, stdout: 'codex-cli 0.200.0\n', stderr: '' }
      assert.deepEqual(args, ['auth', 'status', '--help'])
      return { status: 0, stdout: 'Usage: claude auth status [options]\n--json Output as JSON', stderr: '' }
    }
    const report = probeAccountCapabilities({
      tempRoot: temp, run, resolveBinary: name => `/fake/${name}`,
      env: { PATH: process.env.PATH, CCS_BRIDGE: '1', TMUX: 'private', CODEX_THREAD_ID: 'private',
        SLACK_BOT_TOKEN: 'DO-NOT-PRINT', CLAUDE_CODE_OAUTH_TOKEN: 'DO-NOT-PRINT',
        OPENAI_API_KEY: 'DO-NOT-PRINT', ANTHROPIC_API_KEY: 'DO-NOT-PRINT',
        CODEX_HOME: '/real-codex-home', CLAUDE_CONFIG_DIR: '/real-claude-home' },
    })
    assert.equal(report.providers.find(provider => provider.provider === 'codex').installedProbe.schema.quotaPolling, true)
    assert.equal(report.providers.find(provider => provider.provider === 'claude').installedProbe.jsonAuthStatusCommand, true)
    assert.ok(report.providers.every(provider => provider.crossAccountResume === 'requires-controlled-proof'))
    assert.equal(calls.length, 4)
    assert.deepEqual(fs.readdirSync(temp), [])
    assert.doesNotMatch(JSON.stringify(report), /DO-NOT-PRINT|real-codex-home|real-claude-home/)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('missing binaries, partial schemas, and failed probes are bounded and do not echo provider diagnostics', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-capability-failure-'))
  try {
    const missing = probeAccountCapabilities({ resolveBinary: () => null, tempRoot: temp })
    assert.ok(missing.providers.every(provider => provider.installedProbe.status === 'unavailable'))
    const failed = probeAccountCapabilities({
      tempRoot: temp, resolveBinary: name => `/fake/${name}`,
      run: () => ({ status: 1, stdout: 'secret-DO-NOT-PRINT', stderr: 'secret-DO-NOT-PRINT' }),
    })
    assert.ok(failed.providers.every(provider => provider.installedProbe.status === 'failed'))
    assert.doesNotMatch(JSON.stringify(failed), /DO-NOT-PRINT/)
    assert.deepEqual(fs.readdirSync(temp), [])
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
