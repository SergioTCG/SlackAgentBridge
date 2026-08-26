import { execFile as _execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { providerCommand } from './providers.mjs'

export const execFile = promisify(_execFile)
export const BRIDGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Config + state live outside the repo so updates never touch secrets/state.
// Legacy in-repo locations are still read as a fallback (and state is migrated).
export const CONFIG_DIR = process.env.CCS_CONFIG_DIR || path.join(os.homedir(), '.config', 'ccs')
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')
const LEGACY_STATE = path.join(BRIDGE, 'state.json')

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
export const sleep = ms => new Promise(r => setTimeout(r, ms))

export function loadEnv() {
  // Load config env first (takes precedence), then the repo .env fills any gaps.
  // Merging avoids a partial ~/.config/ccs/env masking tokens still in .env.
  const candidates = [path.join(CONFIG_DIR, 'env'), path.join(BRIDGE, '.env')]
  let found = false
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue
    found = true
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  }
  if (!found) throw new Error(`no env file found (looked in: ${candidates.join(', ')})`)
}

// ---- state ------------------------------------------------------------------
export function loadState() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  if (!fs.existsSync(STATE_FILE) && fs.existsSync(LEGACY_STATE)) {
    try { fs.copyFileSync(LEGACY_STATE, STATE_FILE) } catch {} // one-time migration
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { control: null, sessions: {}, channels: {} }
  }
}
let saveTimer = null
function writeState(state) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, STATE_FILE)
  try { fs.chmodSync(STATE_FILE, 0o600) } catch {}
}
export function saveState(state) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; writeState(state) }, 300)
}

// Provider switches are a journaled cross-process transaction. Persist phase
// boundaries synchronously so a daemon crash can never leave state claiming the
// source is active after its terminal has already been stopped (or vice versa).
export function saveStateNow(state) {
  clearTimeout(saveTimer)
  saveTimer = null
  writeState(state)
}

// ---- processes --------------------------------------------------------------
async function psField(field, pid) {
  try {
    const { stdout } = await execFile('ps', ['-o', `${field}=`, '-p', String(pid)])
    return stdout.trim()
  } catch {
    return ''
  }
}

// Walk up from a hook process until we find the owning agent. The Claude export
// remains as a compatibility wrapper for the existing channel server paths.
export async function resolveAgentPid(start, provider = 'claude') {
  let pid = Number(start)
  const match = provider === 'codex' ? /codex/i : provider === 'pi' ? /(?:^|\/)pi(?:$|\s)/i : /claude/i
  for (let hop = 0; hop < 6 && pid > 1; hop++) {
    const comm = await psField('comm', pid)
    if (match.test(comm)) return pid
    const pp = Number(await psField('ppid', pid))
    if (!pp || pp === pid) break
    pid = pp
  }
  return Number(start) || null
}
export const resolveClaudePid = start => resolveAgentPid(start, 'claude')

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- git / naming -----------------------------------------------------------
// General git identity for ANY project (no per-repo logic):
//  - repo:     canonical name from the remote, else the main worktree's dir
//  - branch:   current branch (workflows are branch-bound)
//  - worktree: this checkout's dir name, when it differs from repo (linked worktree)
export async function gitInfo(cwd) {
  let repo = path.basename(cwd)
  let branch = ''
  let worktree = ''
  const git = async (...a) => (await execFile('git', ['-C', cwd, ...a])).stdout.trim()
  try {
    const toplevel = await git('rev-parse', '--show-toplevel')
    // repo name: prefer the remote's name, else the main repo dir (common-dir's parent)
    const commonDir = path.resolve(cwd, await git('rev-parse', '--git-common-dir'))
    repo = path.basename(path.dirname(commonDir))
    try {
      const url = await git('remote', 'get-url', 'origin')
      const m = url.replace(/\.git$/, '').match(/([^/:]+)$/)
      if (m) repo = m[1]
    } catch {}
    // a linked worktree's git-dir differs from the shared common-dir
    const gitDir = path.resolve(await git('rev-parse', '--absolute-git-dir'))
    if (gitDir !== commonDir) worktree = path.basename(toplevel)
    branch = await git('branch', '--show-current')
  } catch {}
  return { repo, branch, worktree }
}

export async function gitStatusText(cwd) {
  try { return (await execFile('git', ['-C', cwd, 'status', '--short'])).stdout.trim() } catch { return '' }
}

export async function gitBranch(cwd) {
  // --show-current handles an unborn branch (fresh repo, no commits); rev-parse HEAD doesn't.
  try { return (await execFile('git', ['-C', cwd, 'branch', '--show-current'])).stdout.trim() } catch { return '' }
}

export function channelName(repo, branch, worktree) {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  // repo + branch is the recognizable core; worktree name only fills in for a
  // detached HEAD (no branch). The full cwd lives in the channel topic either way.
  const base = [repo, branch || worktree, stamp].filter(Boolean).join('-')
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').slice(0, 75)
}

// ---- tmux / optional Ghostty viewport --------------------------------------
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`

export async function tmuxAlive(tname) {
  try { await execFile('tmux', ['has-session', '-t', tname]); return true } catch { return false }
}

export async function tmuxAttached(tname) {
  return (await tmuxClientPids(tname)).length > 0
}

export const parseTmuxClientPids = output => String(output || '')
  .split('\n').map(value => value.trim()).filter(Boolean)
  .map(Number).filter(pid => Number.isInteger(pid) && pid > 1)

export async function tmuxClientPids(tname) {
  try {
    return parseTmuxClientPids((await execFile('tmux', ['list-clients', '-t', tname, '-F', '#{client_pid}'])).stdout)
  } catch { return [] }
}

export async function tmuxDetachClients(tname) {
  const clients = await tmuxClientPids(tname)
  if (!clients.length) return 0
  await execFile('tmux', ['detach-client', '-s', tname])
  return clients.length
}

export async function tmuxKill(tname) {
  try { await execFile('tmux', ['kill-session', '-t', tname]) } catch {}
}

export async function tmuxCapture(tname) {
  try { return (await execFile('tmux', ['capture-pane', '-t', tname, '-p'])).stdout } catch { return '' }
}

// Remove pre-v2 client-detached hooks from adopted sessions. In v2 a terminal
// is only a viewport: detaching it must never terminate tmux or the provider.
export async function clearKillOnClose(tname) {
  try { await execFile('tmux', ['set-hook', '-u', '-t', tname, 'client-detached']) } catch {}
}

// Let tmux own the outer terminal title and pin it to a literal string (mirrors
// the Slack channel topic: folder · branch · model · effort). '#' is escaped so
// tmux never interprets format directives in branch/path names.
export async function tmuxTitle(tname, text) {
  try {
    await execFile('tmux', ['set-option', '-t', tname, 'set-titles', 'on'])
    await execFile('tmux', ['set-option', '-t', tname, 'set-titles-string', String(text).replace(/#/g, '##')])
  } catch {}
}

// Codex's launcher binds F12 to interrupt_turn, avoiding Ctrl-C's idle/exit
// ambiguity. Claude retains its established Escape behavior.
export async function tmuxInterrupt(tname, provider = 'claude') {
  await execFile('tmux', ['send-keys', '-t', tname, provider === 'codex' ? 'F12' : 'Escape'])
}

// Inject a full message into the session's input box as a bracketed paste,
// then submit. Unlike channel events (rendered as a ~50-char summary line),
// this shows the complete message in the terminal exactly as if typed.
export async function tmuxPaste(tname, text) {
  await execFile('tmux', ['set-buffer', '-b', 'sab-inject', text])
  await execFile('tmux', ['paste-buffer', '-p', '-d', '-b', 'sab-inject', '-t', tname])
  await sleep(300)
  await execFile('tmux', ['send-keys', '-t', tname, 'Enter'])
}

export async function tmuxSendCommand(tname, slashCommand) {
  await execFile('tmux', ['send-keys', '-t', tname, '-l', slashCommand])
  await sleep(150)
  await execFile('tmux', ['send-keys', '-t', tname, 'Enter'])
}

// Environment for anything handed to `open`: strip bridge and Claude identity
// vars so windows/shells opened inside spawned instances can't inherit another
// session's identity (the root of the cross-session routing corruption).
function sanitizedEnv() {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^(CCS_|CLAUDE|ANTHROPIC_)/.test(k)) delete env[k]
  for (const k of ['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_SESSION_ID']) delete env[k]
  return env
}

async function processDetails(pid) {
  try {
    const { stdout } = await execFile('ps', ['-o', 'ppid=,command=', '-p', String(pid)])
    const match = stdout.match(/^\s*(\d+)\s+([\s\S]*)$/)
    return match ? { ppid: Number(match[1]), command: match[2] } : null
  } catch { return null }
}

async function ghosttyAncestor(pid) {
  let current = Number(pid)
  for (let hop = 0; hop < 8 && current > 1; hop++) {
    const details = await processDetails(current)
    if (!details) return null
    if (/Ghostty\.app\/Contents\/MacOS\/ghostty/.test(details.command)) return current
    if (!details.ppid || details.ppid === current) return null
    current = details.ppid
  }
  return null
}

export async function focusTmuxTerminal(tname) {
  const clients = await tmuxClientPids(tname)
  if (!clients.length) return false
  const pid = await ghosttyAncestor(clients[0])
  if (!pid) return false
  try {
    await execFile('osascript', ['-e',
      `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`],
    { timeout: 8000 })
    return true
  } catch { return false }
}

const safeTmuxName = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)

export async function openTmuxTerminal(tname) {
  if (!safeTmuxName(tname) || !(await tmuxAlive(tname))) throw new Error('tmux session is unavailable')
  if (await tmuxAttached(tname)) {
    const focused = await focusTmuxTerminal(tname)
    return { action: focused ? 'focused' : 'already-open', focused }
  }
  const hidden = process.env.CCS_GHOSTTY_HIDDEN === '1' ? ['--macos-hidden=always'] : []
  const attach = `exec tmux attach-session -t ${shq(tname)}`
  await execFile('open', ['-na', 'Ghostty.app', '--args', ...hidden,
    '--quit-after-last-window-closed=true', '-e', 'zsh', '-lc', attach], { env: sanitizedEnv() })
  for (let i = 0; i < 24; i++) {
    await sleep(500)
    if (await tmuxAttached(tname)) return { action: 'opened', focused: true }
  }
  throw new Error('Ghostty did not attach to the session')
}

export async function closeTmuxTerminal(tname) {
  if (!safeTmuxName(tname) || !(await tmuxAlive(tname))) throw new Error('tmux session is unavailable')
  const detached = await tmuxDetachClients(tname)
  return { action: detached ? 'closed' : 'already-closed', detached }
}

// Account names are interpolated into a shell command, so they are strictly
// validated here as well as at the CLI — never trust a stored value blindly.
export const safeAccount = a => (typeof a === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(a) ? a : null)

export async function spawnSession({ cwd, args, tmuxName, autoConsent, account, provider = 'claude' }) {
  const acct = provider === 'claude' ? safeAccount(account) : null
  if (!safeTmuxName(tmuxName)) throw new Error('invalid tmux session name')
  fs.mkdirSync(cwd, { recursive: true })
  const env = ['CCS_BRIDGE=1', `CCS_PROVIDER=${provider}`, `CCS_TMUX=${tmuxName}`]
  if (acct) env.push(`CCS_ACCOUNT=${acct}`)
  await execFile('tmux', ['new-session', '-d', '-s', tmuxName, '-c', cwd, '--',
    'env', ...env, path.join(BRIDGE, 'bin', 'sab'), '__run', provider, ...args])
  log('spawned headless tmux', { provider: providerCommand(provider), cwd, args, tmuxName })
  if (autoConsent) {
    const child = spawn(path.join(BRIDGE, 'scripts', 'claude-consent.sh'), [tmuxName], {
      detached: true, stdio: 'ignore',
    })
    child.unref()
  }
}

// Enumerate the model families this `claude` build supports, each mapped to its
// latest version. The native install is a single executable with the model ids
// embedded, so we read them straight from the binary — the list stays correct
// across `claude update` with nothing hardcoded.
export async function availableModels(bin) {
  const families = ['opus', 'sonnet', 'haiku', 'fable']
  let out = ''
  try {
    // `(\[1m\])?` also captures the long-context variants (e.g. claude-opus-5[1m]),
    // which are separate model ids the plain family alias never selects.
    out = (await execFile('grep', ['-aoE', `claude-(${families.join('|')})-[0-9][a-z0-9-]*(\\[1m\\])?`, bin],
      { maxBuffer: 8 << 20, timeout: 8000 })).stdout
  } catch { return [] } // grep exits non-zero on no match / unreadable binary → caller falls back
  const ids = [...new Set(out.split('\n').filter(Boolean))]
  const models = []
  for (const fam of families) {
    const pre = `claude-${fam}-`
    const clean = ids
      .filter(id => new RegExp(`^${pre}\\d+(?:-\\d+)*$`).test(id))      // plain versions only
      .filter(id => !id.slice(pre.length).split('-').some(s => s.length >= 6)) // drop dated snapshots
    if (!clean.length) continue
    const nums = id => id.slice(pre.length).split('-').map(Number)
    clean.sort((a, b) => { const A = nums(a), B = nums(b); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d } return 0 })
    const id = clean[clean.length - 1]
    const Fam = fam[0].toUpperCase() + fam.slice(1)
    const ver = id.slice(pre.length).replace(/-/g, '.')
    models.push({ alias: fam, id, name: `${Fam} ${ver}` })
    // Long-context sibling, when this build has one: a distinct id, so it needs
    // its own alias — the family alias always resolves to the standard variant.
    if (ids.includes(`${id}[1m]`)) models.push({ alias: `${fam}-1m`, id: `${id}[1m]`, name: `${Fam} ${ver} (1M context)` })
  }
  return models
}
