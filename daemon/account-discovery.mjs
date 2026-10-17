// Offline, read-only account inventory. This module is deliberately not wired
// into daemon lifecycle, authentication, or account selection.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { channelNodeId, LOCAL_NODE_ID } from './nodes.mjs'

const MAX_ALIASES = 256
const MAX_BINDINGS = 4096
const aliasPattern = /^[A-Za-z0-9_-]{1,64}$/
const nativeAccountId = provider => `candidate:${provider}:native-default`
const nativeGroupId = provider => `candidate:group:${provider}:native-default`
const namedGroupId = alias => `candidate:group:claude:named:${alias}`
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeIdentity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
const emailCandidate = value => typeof value === 'string' && value.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value) ? value : null
const identity = (email = null, source = null) => ({
  email: emailCandidate(email), source,
  verification: emailCandidate(email) ? 'cached-unverified' : 'unresolved',
})

function cachedCodexIdentity(auth) {
  if (!record(auth) || (auth.auth_mode != null && auth.auth_mode !== 'chatgpt') ||
      (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim())) return identity()
  // An ID-token claim is a hint for operator review, NOT authenticated identity,
  // current subscription, token validity, or a key for quota deduplication.
  const token = auth.tokens?.id_token
  if (typeof token !== 'string' || token.length > 65536) return identity()
  const parts = token.split('.')
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return identity()
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return identity(claims?.email || claims?.['https://api.openai.com/profile']?.email, 'cached-id-token')
  } catch { return identity() }
}

function namedCandidates(text, issues) {
  const aliases = new Map()
  let rowCount = 0
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    if (++rowCount > MAX_ALIASES * 4) {
      issues.push({ code: 'too-many-registry-entries', source: 'legacy-accounts', severity: 'blocking' })
      break
    }
    const equals = line.indexOf('=')
    const alias = equals < 0 ? '' : line.slice(0, equals)
    if (!aliasPattern.test(alias)) {
      issues.push({ code: 'invalid-registry-entry', source: 'legacy-accounts', severity: 'blocking' })
      continue
    }
    if (!aliases.has(alias) && aliases.size === MAX_ALIASES) {
      issues.push({ code: 'too-many-aliases', source: 'legacy-accounts', severity: 'blocking' })
      break
    }
    const values = aliases.get(alias) || new Set()
    values.add(line.slice(equals + 1))
    aliases.set(alias, values)
  }
  const byCredential = new Map()
  const groups = []
  for (const alias of [...aliases.keys()].sort()) {
    const values = aliases.get(alias)
    const [credential] = values
    const blocked = values.size !== 1 || !credential.trim()
    groups.push({
      id: namedGroupId(alias), name: alias, provider: 'claude', kind: 'legacy-named',
      memberCandidateId: null, automaticSwitching: false,
    })
    if (blocked) {
      issues.push({ code: values.size !== 1 ? 'conflicting-alias' : 'empty-credential', source: 'legacy-accounts', alias, severity: 'blocking' })
      continue
    }
    const bucket = byCredential.get(credential) || []
    bucket.push(alias)
    byCredential.set(credential, bucket)
  }
  const accounts = []
  // No credential bytes, prefixes, or credential-derived hashes leave this
  // function. Candidate IDs depend on public aliases and are not durable IDs.
  for (const bucket of byCredential.values()) {
    const id = `candidate:claude:named:${bucket[0]}`
    accounts.push({ id, provider: 'claude', kind: 'legacy-named', aliases: bucket,
      identity: identity(), credentialEvidence: 'stored-token', eligibility: 'requires-verification' })
    for (const group of groups) if (bucket.includes(group.name)) group.memberCandidateId = id
    if (bucket.length > 1) issues.push({ code: 'duplicate-credential-aliases', source: 'legacy-accounts', aliases: bucket, severity: 'info' })
  }
  return { accounts, groups }
}

export function buildAccountMigrationPreview({
  provider = 'all', legacyAccounts = '', claudeMetadata = null, codexAuth = null,
  state = {}, environmentOverrides = {}, sourceIssues = [],
} = {}) {
  if (!['all', 'claude', 'codex'].includes(provider)) throw new Error('invalid account provider')
  const providers = provider === 'all' ? ['claude', 'codex'] : [provider]
  const issues = sourceIssues.map(issue => ({ ...issue }))
  const { accounts, groups } = providers.includes('claude') ? namedCandidates(legacyAccounts, issues) : { accounts: [], groups: [] }
  for (const current of providers) {
    const overridden = Boolean(environmentOverrides[current])
    const cached = current === 'claude'
      ? identity(claudeMetadata?.oauthAccount?.emailAddress, 'cached-login-metadata')
      : cachedCodexIdentity(codexAuth)
    accounts.push({
      id: nativeAccountId(current), provider: current, kind: 'native-default', aliases: [],
      identity: overridden ? identity() : cached,
      credentialEvidence: 'native-storage-not-verified', eligibility: 'requires-verification',
    })
    groups.push({ id: nativeGroupId(current), name: `${current}-default`, provider: current,
      kind: 'native-default', memberCandidateId: nativeAccountId(current), automaticSwitching: false })
    if (overridden) issues.push({ code: 'native-auth-environment-override', source: current, severity: 'blocking' })
  }
  const bindings = []
  const sessions = record(state?.sessions) ? state.sessions : {}
  const channels = record(state?.channels) ? state.channels : {}
  for (const channelId of Object.keys(channels).sort()) {
    const sessionId = channels[channelId]
    const session = sessions[sessionId]
    if (!safeIdentity(sessionId) || !/^[CG][A-Z0-9]{1,32}$/.test(channelId) ||
        !record(session) || session.channel !== channelId || (session.id && session.id !== sessionId)) continue
    const current = session.provider || 'claude'
    if (!providers.includes(current)) continue
    if (bindings.length === MAX_BINDINGS) {
      issues.push({ code: 'too-many-bindings', source: 'session-state', severity: 'blocking' })
      break
    }
    const local = channelNodeId(state, channelId) === LOCAL_NODE_ID
    const alias = current === 'claude' && session.account ? session.account : null
    const group = alias === null ? groups.find(group => group.id === nativeGroupId(current))
      : groups.find(group => group.kind === 'legacy-named' && group.name === alias)
    const proposedGroupId = local && group?.memberCandidateId ? group.id : null
    bindings.push({ sessionId, channelId, provider: current, proposedGroupId,
      migrationAction: proposedGroupId ? 'preserve-binding' : 'requires-review' })
    if (!local) issues.push({ code: 'nonlocal-or-mismatched-node', source: 'session-state', sessionId, severity: 'blocking' })
    else if (!proposedGroupId) issues.push({ code: 'unresolved-session-account', source: 'session-state', sessionId, severity: 'blocking' })
  }
  issues.push({ code: 'identity-verification-required', source: 'migration', severity: 'blocking' })
  return {
    schemaVersion: 1, readOnly: true, canApply: false, automaticSwitching: false,
    accounts, groups, bindings, issues,
    summary: {
      namedAliases: groups.filter(group => group.kind === 'legacy-named').length,
      distinctStoredCredentials: accounts.filter(account => account.kind === 'legacy-named').length,
      authoritativeBindings: bindings.length,
      bindingsRequiringReview: bindings.filter(binding => !binding.proposedGroupId).length,
    },
  }
}

function readSource(file, source, maxBytes, issues, { json = false, privateFile = false } = {}) {
  let fd
  try {
    // Nonblocking open plus fstat avoids hanging on a FIFO/device masquerading
    // as configuration. Bound bytes read even if another process grows a file.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      issues.push({ code: 'source-not-regular', source, severity: 'blocking' })
      return null
    }
    if (stat.size > maxBytes) {
      issues.push({ code: 'source-too-large', source, severity: 'blocking' })
      return null
    }
    if (privateFile && (stat.mode & 0o077)) issues.push({ code: 'source-permissions', source, severity: 'blocking' })
    const chunks = []
    let total = 0
    while (total <= maxBytes) {
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - total))
      const count = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!count) break
      chunks.push(buffer.subarray(0, count))
      total += count
    }
    if (total > maxBytes) {
      issues.push({ code: 'source-too-large', source, severity: 'blocking' })
      return null
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!json) return text
    try {
      const value = JSON.parse(text)
      if (!record(value)) throw new Error('not an object')
      return value
    } catch {
      issues.push({ code: 'source-invalid-json', source, severity: 'blocking' })
      return null
    }
  } catch (error) {
    if (error.code !== 'ENOENT') issues.push({ code: 'source-unreadable', source, severity: 'blocking' })
    return null
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

export function readAccountMigrationPreview({ home = os.homedir(), env = process.env,
  configDir = env.CCS_CONFIG_DIR || path.join(home, '.config/ccs'),
  codexHome = env.CODEX_HOME || path.join(home, '.codex'), provider = 'all',
} = {}) {
  if (!['all', 'claude', 'codex'].includes(provider)) throw new Error('invalid account provider')
  const issues = []
  const has = name => typeof env[name] === 'string' && Boolean(env[name].trim())
  const claude = provider !== 'codex'
  const codex = provider !== 'claude'
  const metadata = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')
  return buildAccountMigrationPreview({
    provider,
    legacyAccounts: claude ? readSource(path.join(configDir, 'accounts'), 'legacy-accounts', 1 << 20, issues, { privateFile: true }) || '' : '',
    claudeMetadata: claude ? readSource(metadata, 'claude-metadata', 4 << 20, issues, { json: true }) : null,
    codexAuth: codex ? readSource(path.join(codexHome, 'auth.json'), 'codex-auth-cache', 1 << 20, issues, { json: true, privateFile: true }) : null,
    state: readSource(path.join(configDir, 'state.json'), 'session-state', 32 << 20, issues, { json: true, privateFile: true }) || {},
    environmentOverrides: {
      claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(has),
      codex: ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'].some(has),
    },
    sourceIssues: issues,
  })
}
