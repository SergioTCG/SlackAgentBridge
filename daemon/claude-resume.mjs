import { parseProcessTable } from './codex-resume.mjs'

function boundedExitCode(value) {
  const code = Number(value)
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : null
}

// A detached tmux can exist just long enough for one liveness poll even when
// Claude immediately rejects --resume. Treat only the exact SessionStart-owned
// PID/tmux claim as readiness; a transient pane is not an active SAB session.
export async function waitForClaudeResumeClaim(session, {
  expectedTmux,
  tmuxAlive,
  pidAlive,
  validTmuxClaim,
  readExitCode = () => null,
  attempts = 40,
  intervalMs = 500,
  sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const tmux = String(expectedTmux || '')
  if (!tmux) throw new Error('Claude resume is missing its tmux identity')
  const tries = Math.max(1, Number(attempts) || 1)
  for (let attempt = 0; attempt < tries; attempt++) {
    if (session?.tmux !== tmux) throw new Error('Claude resume tmux identity changed before lifecycle adoption')
    if (!(await tmuxAlive(tmux))) {
      const code = boundedExitCode(await readExitCode())
      throw new Error(`Claude exited before lifecycle adoption${code === null ? '' : ` (exit ${code})`}`)
    }
    const pid = Number(session?.pid)
    if (pid > 1 && pidAlive(pid) && await validTmuxClaim(pid, tmux)) {
      return { pid, tmux, source: 'hook' }
    }
    if (attempt + 1 < tries) await sleepFn(intervalMs)
  }
  throw new Error('Claude did not emit SessionStart for the replacement tmux')
}

const SAFE_TMUX = /^[A-Za-z0-9_.:-]{1,128}$/
const SAFE_SESSION_ID = /^[A-Za-z0-9-]{8,128}$/

function claudeProcess(row) {
  if (String(row.comm || '').split('/').pop() === 'claude') return true
  const args = String(row.args || '')
  return /(?:^|\s)[^\s"']*\/claude(?=\s|$)/.test(args) || /@anthropic-ai\/claude-code\//.test(args)
}

// A daemon restart between a replacement launch and its SessionStart loses the
// only hook that would bind the replacement PID. Explicit reconciliation may
// then adopt the shallowest Claude process of the exact single-pane tmux, and
// only when its argv resumes this exact native session.
export function selectClaudeResumeProcessPid(rows, panePids, sessionId) {
  const roots = [...new Set((panePids || []).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1))]
  const sid = String(sessionId || '')
  if (roots.length !== 1 || !SAFE_SESSION_ID.test(sid)) return null
  const processes = Array.isArray(rows) ? rows : []
  const children = new Map()
  for (const row of processes) {
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid)) continue
    const list = children.get(row.ppid) || []
    list.push(row.pid)
    children.set(row.ppid, list)
  }
  const depth = new Map([[roots[0], 0]])
  const queue = [roots[0]]
  while (queue.length) {
    const parent = queue.shift()
    for (const child of children.get(parent) || []) {
      if (depth.has(child)) continue
      depth.set(child, depth.get(parent) + 1)
      queue.push(child)
    }
  }
  const root = processes.filter(row => depth.has(row.pid) && claudeProcess(row))
    .sort((a, b) => depth.get(a.pid) - depth.get(b.pid) || a.pid - b.pid)[0]
  if (!root) return null
  return new RegExp(`(?:^|\\s)--resume(?:\\s+|=)${sid}(?=\\s|$)`).test(root.args) ? root.pid : null
}

export async function tmuxClaudeResumeProcessPid(tmux, sessionId, { execFile }) {
  if (!SAFE_TMUX.test(String(tmux || ''))) return null
  try {
    const panes = await execFile('tmux', ['list-panes', '-t', tmux, '-F', '#{pane_pid}'])
    const table = await execFile('ps', ['-axww', '-o', 'pid=,ppid=,comm=,args='], { maxBuffer: 8 << 20 })
    return selectClaudeResumeProcessPid(parseProcessTable(table.stdout), String(panes.stdout || '').split('\n'), sessionId)
  } catch {
    return null
  }
}
