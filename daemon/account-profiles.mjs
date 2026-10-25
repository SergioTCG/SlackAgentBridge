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

function assertNotLeased(directory) {
  try { fs.lstatSync(path.join(directory, '.sab-auth-operation')); fail('account_auth_operation_in_progress') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

// A crashed operation intentionally leaves its lease: rotating refresh tokens
// must not be replayed under an assumption that a timeout meant rejection.
export async function withAccountProfileLease(directory, operation, { retainOnFailure = false } = {}) {
  privateDirectory(directory)
  const lease = path.join(directory, '.sab-auth-operation')
  try { fs.mkdirSync(lease, { mode: 0o700 }) } catch { fail('account_auth_operation_in_progress') }
  let succeeded = false
  try { const result = await operation(); succeeded = true; return result }
  finally { if (succeeded || !retainOnFailure) fs.rmdirSync(lease) }
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
const CLAUDE_FIRST_RUN_KEYS = ['hasCompletedOnboarding', 'lastOnboardingVersion', 'hasCompletedClaudeInChromeOnboarding', 'theme']
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
