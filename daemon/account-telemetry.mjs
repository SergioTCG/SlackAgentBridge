// No-inference, account-scoped subscription telemetry. Never refresh a live
// provider's credentials or use a different credential after any failure.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readPrivateAccountFile } from './account-registry-store.mjs'
import { normalizeQuotaObservation } from './account-quota.mjs'
import { readLegacyClaudeToken } from './account-credentials.mjs'
import { codexProfileHome, claudeProfileHome, accountCredentialReference, withAccountProfileLease, recordProfileLeaseFailure, profileNeedsLogin } from './account-profiles.mjs'
import { readClaudeOAuth, refreshInactiveClaudeProfile } from './account-claude-auth.mjs'

const execute = promisify(execFile)
const safeCode = code => { throw new Error(code) }
const secretString = value => typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\r\n\0]/.test(value)

export function quotaProbeEnvironment(root, env = process.env) {
  return {
    PATH: env.PATH || '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: root,
    USER: env.USER || '', LOGNAME: env.LOGNAME || env.USER || '', SHELL: env.SHELL || '/bin/sh',
    TMPDIR: root, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    NO_COLOR: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

async function readCredential(account, { configDir, env, execCredential, now, isProfileInactive }) {
  // References are ordered by the validated registry, never by caller-supplied
  // filesystem paths. This reader cannot enroll, rotate, or refresh tokens.
  const ref = accountCredentialReference(account)
  if (ref?.kind === 'legacy-claude' && account.provider === 'claude') {
    return { accessToken: readLegacyClaudeToken(configDir, ref.alias) }
  }
  if (ref?.kind !== 'native-default' && !['claude-profile', 'codex-profile'].includes(ref?.kind)) safeCode('credential_unavailable')
  if (account.provider === 'codex') {
    if (['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'].some(key => env[key])) safeCode('credential_unavailable')
    const home = ref.kind === 'codex-profile' ? codexProfileHome(configDir, ref.profile) : env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')
    const auth = readPrivateAccountFile(path.join(home, 'auth.json'), { json: true })
    if (!auth || (auth.auth_mode && auth.auth_mode !== 'chatgpt') || auth.OPENAI_API_KEY ||
        !secretString(auth.tokens?.access_token) || !secretString(auth.tokens?.account_id)) safeCode('credential_unavailable')
    return { accessToken: auth.tokens.access_token, principalId: auth.tokens.account_id }
  }
  if (account.provider !== 'claude') safeCode('credential_unavailable')
  if (ref.kind === 'claude-profile') {
    const directory = claudeProfileHome(configDir, ref.profile)
    const oauth = isProfileInactive
      ? await refreshInactiveClaudeProfile({ configDir, profile: ref.profile, isInactive: profile => isProfileInactive('claude', profile), env, execCredential, now })
      : await readClaudeOAuth({ directory, env, execCredential })
    if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= now()) safeCode('credential_unavailable')
    return { accessToken: oauth.accessToken }
  }
  if (env.CLAUDE_CONFIG_DIR || env.CLAUDE_SECURESTORAGE_CONFIG_DIR ||
      ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE',
        'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => env[key])) safeCode('credential_unavailable')
  const oauth = await readClaudeOAuth({ env, execCredential })
  if (!secretString(oauth?.accessToken) || (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= now())) safeCode('credential_unavailable')
  return { accessToken: oauth.accessToken }
}

async function readJson(url, credential, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${credential.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    safeCode(({ 401: 'needs-login', 403: 'scope-unavailable', 429: 'throttled' })[response.status] || 'provider-unavailable')
  }
  const reader = response.body?.getReader()
  if (!reader) safeCode('invalid-response')
  const chunks = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 65536) { await reader.cancel(); safeCode('invalid-response') }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) { if (error.message === 'invalid-response') throw error; safeCode('invalid-response') }
  finally { reader.releaseLock() }
}

export async function probeCodexAccount(credential, { spawnChild = spawn, env = process.env, timeoutMs = 20000, managedHome = null } = {}) {
  if (!managedHome && (!secretString(credential.accessToken) || !secretString(credential.principalId))) safeCode('credential-unavailable')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-account-quota-'))
  let child, timer, killTimer, nextId = 0, bytes = 0, tail = '', exited = false, spawned = false, readSettled = false
  const pending = new Map()
  const rejectPending = () => { for (const { reject } of pending.values()) reject(new Error('provider-unavailable')); pending.clear() }
  let resolveExit
  const exit = new Promise(resolve => { resolveExit = resolve })
  try {
    const childEnv = quotaProbeEnvironment(root, env)
    fs.mkdirSync(childEnv.CODEX_HOME, { mode: 0o700 })
    if (managedHome) childEnv.CODEX_HOME = managedHome
    child = spawnChild('codex', ['app-server', '--listen', 'stdio://', '-c', `cli_auth_credentials_store="${managedHome ? 'file' : 'ephemeral'}"`], {
      cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const terminate = () => { rejectPending(); child.kill('SIGTERM') }
    child.once('spawn', () => { spawned = true })
    child.once('error', () => { exited = true; rejectPending(); resolveExit() })
    child.once('exit', () => { exited = true; rejectPending(); resolveExit() })
    child.stderr.resume() // Native diagnostics may contain secrets: discard all.
    child.stdin.on('error', terminate)
    const send = value => child.stdin.write(JSON.stringify(value) + '\n')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > (1 << 20)) return terminate()
      tail += chunk
      for (let index; (index = tail.indexOf('\n')) >= 0;) {
        const line = tail.slice(0, index); tail = tail.slice(index + 1)
        let value
        try { value = JSON.parse(line) } catch { terminate(); return }
        if (value.method && value.id != null) {
          // External-token refresh is intentionally unsupported here. The
          // sampler never receives refresh tokens or retries an auth mutation.
          send({ id: value.id, error: { code: -32000, message: 'Quota sampler cannot refresh credentials' } })
          continue
        }
        const request = pending.get(value.id)
        if (!request) continue
        pending.delete(value.id)
        if (value.error) request.reject(new Error('provider-unavailable'))
        else request.resolve(value.result)
      }
    })
    timer = setTimeout(terminate, Math.min(20000, Math.max(50, timeoutMs)))
    const rpc = (method, params) => new Promise((resolve, reject) => {
      if (exited) return reject(new Error('provider-unavailable'))
      const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params })
    })
    await rpc('initialize', { clientInfo: { name: 'slack-agent-bridge-quota', version: '1' }, capabilities: { experimentalApi: true } })
    send({ method: 'initialized', params: {} })
    if (!managedHome) await rpc('account/login/start', { type: 'chatgptAuthTokens', accessToken: credential.accessToken, chatgptAccountId: credential.principalId })
    const account = await rpc('account/read', { refreshToken: Boolean(managedHome) })
    readSettled = true
    const limits = await rpc('account/rateLimits/read', {})
    return { account: account?.account, limits }
  } catch {
    // A managed Codex may refresh its own token on any authenticated call, so
    // only a child that never started, or a refresh that finished, spent nothing.
    throw Object.assign(new Error('provider-unavailable'), { refreshRequested: Boolean(managedHome) && spawned && !readSettled })
  }
  finally {
    clearTimeout(timer)
    if (child && !exited) {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL'); resolveExit() }, 1000)
      await exit
      clearTimeout(killTimer)
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export async function readAccountQuota(account, { configDir = path.join(os.homedir(), '.config/ccs'), env = process.env,
  execCredential = execute, fetchImpl = fetch, codexProbe = probeCodexAccount, resolveCredential = null,
  now = Date.now, isProfileInactive = null,
} = {}) {
  const failed = status => ({ provider: account.provider, observedAt: now(), status, windows: [] })
  let credential
  try { credential = await (resolveCredential ? resolveCredential(account) : readCredential(account, { configDir, env, execCredential, now, isProfileInactive })) }
  catch (error) {
    // A failed automatic renewal is not transient: only a new sign-in fixes it.
    if (error?.message === 'account_needs_login') return { ...failed('needs-login'), reason: error.renewalFailure }
    // Nothing was refused, so the next reading renews again.
    if (error?.message === 'account_renewal_unconfirmed') return { ...failed('credential-unavailable'), reason: 'not-renewed' }
    return failed('credential-unavailable')
  }
  try {
    let identity, quota
    if (account.provider === 'claude') {
      const profile = await readJson('https://api.anthropic.com/api/oauth/profile', credential, fetchImpl)
      identity = { email: profile?.email || profile?.account?.email || profile?.account?.email_address,
        principalId: profile?.organization?.uuid || profile?.account?.uuid }
      if (identity.email?.toLowerCase() !== account.email.toLowerCase() || (account.workspaceId && account.workspaceId !== identity.principalId)) return failed('identity-mismatch')
      quota = await readJson('https://api.anthropic.com/api/oauth/usage', credential, fetchImpl)
    } else if (account.provider === 'codex') {
      const ref = accountCredentialReference(account)
      let result
      if (ref.kind === 'codex-profile' && isProfileInactive && await isProfileInactive('codex', ref.profile)) {
        const directory = codexProfileHome(configDir, ref.profile)
        result = await withAccountProfileLease(directory, async lease => {
          if (!await isProfileInactive('codex', ref.profile)) safeCode('credential-unavailable')
          // The probe lets Codex rotate its own refresh token, so once it asked
          // to, a failure keeps the lease and only the owner's next sign-in continues.
          try { return await codexProbe(null, { env, managedHome: directory }) }
          catch (error) {
            if (!error?.refreshRequested) throw error // stopped before the refresh, so nothing was spent
            recordProfileLeaseFailure(lease, 'failed'); throw profileNeedsLogin('failed')
          }
        }, { purpose: 'renewal', retainOnFailure: error => error?.message === 'account_needs_login' })
      } else result = await codexProbe(credential, { env })
      if (result.account?.type !== 'chatgpt') return failed('identity-mismatch')
      identity = { email: result.account.email, principalId: credential.principalId }
      if (identity.email?.toLowerCase() !== account.email.toLowerCase() || (account.workspaceId && account.workspaceId !== identity.principalId)) return failed('identity-mismatch')
      quota = result.limits
    } else return failed('provider-not-managed')
    return normalizeQuotaObservation({ provider: account.provider, identity, quota, observedAt: now() })
  } catch (error) {
    if (error?.message === 'account_needs_login') return { ...failed('needs-login'), reason: error.renewalFailure }
    const known = ['needs-login', 'scope-unavailable', 'throttled', 'provider-unavailable', 'invalid-response']
    return failed(known.includes(error.message) ? error.message : error.message === 'quota_identity_mismatch' ? 'identity-mismatch' : 'invalid-response')
  }
}

export async function readAccountIdentity(account, { configDir = path.join(os.homedir(), '.config/ccs'), env = process.env,
  execCredential = execute, fetchImpl = fetch, codexProbe = probeCodexAccount, now = Date.now, resolveCredential = null,
} = {}) {
  try {
    const credential = await (resolveCredential ? resolveCredential(account) : readCredential(account, { configDir, env, execCredential, now }))
    let email, principal
    if (account.provider === 'claude') {
      const p = await readJson('https://api.anthropic.com/api/oauth/profile', credential, fetchImpl)
      email = p?.email || p?.account?.email || p?.account?.email_address
      principal = p?.organization?.uuid || p?.account?.uuid
    } else {
      const p = await codexProbe(credential, { env })
      if (p.account?.type !== 'chatgpt') return 'identity-mismatch'
      email = p.account.email; principal = credential.principalId
    }
    return email?.toLowerCase() === account.email.toLowerCase() && (!account.workspaceId || principal === account.workspaceId)
      ? 'verified' : 'identity-mismatch'
  } catch (error) { return error.message === 'scope-unavailable' ? 'scope-unavailable' : 'credential-unavailable' }
}

export async function verifyClaudeLaunchIdentity(account, { cwd, configDir, env = process.env, execCredential = execute } = {}) {
  const ref = accountCredentialReference(account)
  if (ref.kind === 'legacy-claude') return true // explicitly unverified/manual-only elsewhere
  try {
    const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'].filter(k => env[k]).map(k => [k, env[k]]))
    if (ref.kind === 'claude-profile') childEnv.CLAUDE_CONFIG_DIR = claudeProfileHome(configDir, ref.profile)
    // Native resolution catches settings/API helpers which could override the
    // selected OAuth store despite the runner clearing inherited auth env.
    const { stdout } = await execCredential('claude', ['auth', 'status', '--json'], {
      cwd, env: childEnv, timeout: 10000, maxBuffer: 65536, encoding: 'utf8',
    })
    const status = JSON.parse(stdout)
    return status.loggedIn === true && status.authMethod === 'claude.ai' && status.email?.toLowerCase() === account.email.toLowerCase()
  } catch { return false }
}
