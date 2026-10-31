import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { readPrivateAccountFile } from './account-registry-store.mjs'

const fail = code => { throw new Error(code) }
function privateDirectory(directory, create = false) {
  if (create) fs.mkdirSync(directory, { mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('insecure_codex_profile')
}
function profilePath(configDir, profile, create = false, provider = 'codex') {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(profile || '')) fail(`invalid_${provider}_profile`)
  let directory = configDir
  for (const part of ['account-auth', provider, profile]) {
    directory = path.join(directory, part)
    if (create && !fs.existsSync(directory)) privateDirectory(directory, true)
    else privateDirectory(directory)
  }
  return directory
}

const LEASE = '.sab-auth-operation'
const NEEDS_LOGIN_REASONS = ['timeout', 'rejected', 'failed', 'not-renewed', 'abandoned', 'wrong-account']
const STALE_LEASE_MS = 600000 // longer than any renewal can run
const SIGN_IN_MS = 900000 // longer than a browser sign-in's code stays valid
// Lease records hold only a pid, a purpose, timestamps and a reason code.
function writeLeaseRecord(lease, name, value) {
  const file = path.join(lease, name), temp = `${file}.${crypto.randomBytes(6).toString('hex')}`
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  fs.renameSync(temp, file)
}
function readLeaseRecord(lease, name) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lease, name), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
export const profileNeedsLogin = reason => Object.assign(new Error('account_needs_login'),
  { renewalFailure: NEEDS_LOGIN_REASONS.includes(reason) ? reason : 'failed' })

// A recorded failure, an owner that is gone, or a lease older than these
// records all mean the same: the attempt may have spent the rotating refresh
// token, so only the owner's next sign-in may continue. A lease whose owner is
// alive is an operation in progress.
export function profileLeaseState(directory, { now = Date.now(), isAlive = processAlive } = {}) {
  const lease = path.join(directory, LEASE)
  let stat
  try { stat = fs.lstatSync(lease) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!stat.isDirectory()) return { lease, running: true }
  const owner = readLeaseRecord(lease, 'owner.json'), failure = readLeaseRecord(lease, 'failure.json')
  // A sign-in in progress keeps the failure record, so it is told apart here.
  // The age limit keeps an aborted one's reused PID from blocking for good.
  const signingIn = owner?.purpose === 'login' && isAlive(owner.pid) && now - (Number(owner.at) || 0) < SIGN_IN_MS
  if (failure) return { lease, signingIn, needsLogin: NEEDS_LOGIN_REASONS.includes(failure.reason) ? failure.reason : 'failed' }
  if (owner ? !isAlive(owner.pid) : now - stat.mtimeMs > STALE_LEASE_MS) return { lease, needsLogin: 'abandoned' }
  return { lease, running: true, signingIn, overdue: owner?.purpose === 'renewal' && now - (Number(owner.at) || stat.mtimeMs) > STALE_LEASE_MS }
}

function assertNotLeased(directory) {
  const lease = profileLeaseState(directory)
  if (!lease) return
  if (lease.needsLogin) throw profileNeedsLogin(lease.needsLogin)
  fail('account_auth_operation_in_progress')
}

// Each holder has its own token, so an operation that ends after the owner's
// sign-in took its lease over neither removes that lease nor writes into it.
const claimLease = (lease, purpose) => {
  const handle = { path: lease, token: crypto.randomUUID() }
  writeLeaseRecord(lease, 'owner.json', { pid: process.pid, purpose, token: handle.token, at: Date.now() })
  return handle
}
const holdsLease = handle => {
  const owner = readLeaseRecord(handle.path, 'owner.json')
  return owner ? owner.token === handle.token : fs.existsSync(handle.path)
}
const releaseLease = handle => { if (holdsLease(handle)) fs.rmSync(handle.path, { recursive: true, force: true }) }

// A crashed operation intentionally leaves its lease: rotating refresh tokens
// must not be replayed under an assumption that a timeout meant rejection.
// `retainOnFailure` may also be a test of the error, for operations that keep
// it only once something may have been spent.
export async function withAccountProfileLease(directory, operation, { retainOnFailure = false, purpose = 'operation' } = {}) {
  privateDirectory(directory)
  const lease = path.join(directory, LEASE)
  try { fs.mkdirSync(lease, { mode: 0o700 }) } catch { fail('account_auth_operation_in_progress') }
  let succeeded = false, failure = null, handle = { path: lease, token: null }
  try {
    handle = claimLease(lease, purpose)
    const result = await operation(handle); succeeded = true; return result
  } catch (error) { failure = error; throw error }
  finally {
    const retain = typeof retainOnFailure === 'function' ? retainOnFailure(failure) : retainOnFailure
    if (succeeded || !retain) releaseLease(handle)
  }
}

export function recordProfileLeaseFailure(handle, reason) {
  if (!holdsLease(handle)) return
  try { writeLeaseRecord(handle.path, 'failure.json', { reason: NEEDS_LOGIN_REASONS.includes(reason) ? reason : 'failed', at: Date.now() }) } catch {}
}

// A credential of the wrong account is fenced whoever holds the lease. The
// fence gets its own owner, so no earlier holder's cleanup can remove it.
function fenceProfile(directory, reason) {
  const lease = path.join(directory, LEASE)
  try { fs.mkdirSync(lease, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  writeLeaseRecord(lease, 'failure.json', { reason, at: Date.now() })
  claimLease(lease, 'fence')
}

// The owner's sign-in. It may continue a lease that needs a new sign-in, but
// that lease stays until `verify` confirms the result. So a failed, cancelled
// or wrong-account sign-in never leaves a possibly spent token to an automatic
// renewal. `verify` returns 'ok', 'not-signed-in' or 'wrong-account'. A
// wrong account keeps the profile fenced even when it had no lease.
export async function withProfileSignIn(directory, operation, { verify, now, isAlive } = {}) {
  privateDirectory(directory)
  const lease = profileLeaseState(directory, { now, isAlive })
  const check = async () => {
    const outcome = await verify()
    if (outcome === 'ok') return
    if (outcome === 'wrong-account') { fenceProfile(directory, 'wrong-account'); throw profileNeedsLogin('wrong-account') }
    fail('account_sign_in_unverified')
  }
  if (!lease) {
    await withAccountProfileLease(directory, async () => { await operation(); await check() },
      { purpose: 'login', retainOnFailure: error => error?.message === 'account_needs_login' })
    return { continued: null }
  }
  if (lease.signingIn || !lease.needsLogin && !lease.overdue) fail('account_auth_operation_in_progress')
  const continued = lease.needsLogin || 'abandoned'
  // Readers keep seeing needs-login while this sign-in runs.
  if (!readLeaseRecord(lease.lease, 'failure.json')) writeLeaseRecord(lease.lease, 'failure.json', { reason: continued, at: Date.now() })
  const handle = claimLease(lease.lease, 'login')
  try { await operation(); await check() }
  catch (error) {
    // Still fenced, but no longer a sign-in in progress.
    if (holdsLease(handle)) claimLease(lease.lease, 'fence')
    throw error
  }
  releaseLease(handle)
  return { continued }
}

export const claudeKeychainService = directory => `Claude Code-credentials${directory ? '-' + crypto.createHash('sha256').update(directory.normalize('NFC')).digest('hex').slice(0, 8) : ''}`
export function claudeProfileHome(configDir, profile) {
  const directory = profilePath(configDir, profile, false, 'claude')
  assertNotLeased(directory)
  return directory
}

export function prepareClaudeProfile(configDir, profile, { nativeHome }) {
  const native = fs.realpathSync(nativeHome), directory = profilePath(configDir, profile, true, 'claude')
  if (native === directory) fail('invalid_claude_profile')
  shareResources(native, directory, ['projects', 'skills', 'agents', 'commands', 'plugins', 'rules', 'CLAUDE.md', 'settings.json'])
  return directory
}

// Claude records first-run completion in each profile's own global config,
// which is never shared. Without it a fresh profile opens the theme picker,
// the security notes and, with --chrome, the Chrome intro. A detached launch
// cannot answer them, so the first switch to the profile never reaches
// SessionStart. Copy only these markers, and only once the native login has
// completed onboarding; authentication and account metadata stay separate.
// The owner's answer to Claude's "extension detected" dialog is carried over
// too: unanswered, that dialog also stops a detached launch before SessionStart.
const CLAUDE_FIRST_RUN_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'hasCompletedClaudeInChromeOnboarding', 'theme',
  'claudeInChromeDefaultEnabled']
export const claudeNativeConfigFile = (env = process.env, home = os.homedir()) =>
  env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json')

export function seedClaudeFirstRunState(directory, nativeConfigFile) {
  let native
  try {
    if (fs.statSync(nativeConfigFile).size > 32 << 20) return false
    native = JSON.parse(fs.readFileSync(nativeConfigFile, 'utf8'))
  } catch { return false }
  if (native?.hasCompletedOnboarding !== true) return false
  const file = path.join(directory, '.claude.json')
  const current = readPrivateAccountFile(file, { json: true, missing: {}, maxBytes: 32 << 20 })
  if (!current || typeof current !== 'object' || Array.isArray(current)) fail('invalid_claude_profile_config')
  const missing = CLAUDE_FIRST_RUN_KEYS.filter(key => native[key] !== undefined && current[key] === undefined)
  if (!missing.length) return false
  for (const key of missing) current[key] = native[key]
  const temp = path.join(directory, `.claude.json.sab-${crypto.randomBytes(6).toString('hex')}`)
  try {
    fs.writeFileSync(temp, JSON.stringify(current, null, 2), { mode: 0o600, flag: 'wx' })
    fs.renameSync(temp, file)
  } catch (error) { fs.rmSync(temp, { force: true }); throw error }
  return true
}

export function accountCredentialReference(account) {
  return account.credentials.find(ref => ref.kind === `${account.provider}-profile`) || account.credentials[0]
}

export function codexProfileHome(configDir, profile) {
  const directory = profilePath(configDir, profile)
  assertNotLeased(directory)
  if (!readPrivateAccountFile(path.join(directory, 'auth.json'), { json: true })) fail('codex_profile_not_authenticated')
  return directory
}

export function prepareCodexProfile(configDir, profile, { nativeHome }) {
  const native = fs.realpathSync(nativeHome)
  const directory = profilePath(configDir, profile, true)
  if (native === directory) fail('invalid_codex_profile')
  shareResources(native, directory, ['sessions', 'archived_sessions', 'skills', 'plugins', 'memories', 'rules', 'AGENTS.md', 'config.toml'])
  return directory
}

function shareResources(native, directory, names) {
  // Native providers locate conversations. Authentication is NEVER included.
  for (const name of names) {
    const target = path.join(native, name), destination = path.join(directory, name)
    if (!fs.existsSync(target)) continue
    try {
      const stat = fs.lstatSync(destination)
      if (!stat.isSymbolicLink() || fs.realpathSync(destination) !== fs.realpathSync(target)) fail('codex_profile_resource_conflict')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      fs.symlinkSync(target, destination)
    }
  }
}
