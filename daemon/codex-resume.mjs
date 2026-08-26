const SAFE_TMUX = /^[A-Za-z0-9_.:-]{1,128}$/

export function parseProcessTable(output) {
  const rows = []
  for (const line of String(output || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      comm: match[3],
      args: match[4] || '',
    })
  }
  return rows
}

function codexProcess(row) {
  const executable = String(row.comm || '').split('/').pop()
  if (executable === 'codex') return true
  // npm-installed Codex runs through Node. Match the executable argument, not
  // arbitrary command text such as run-session.sh's provider name or the
  // codex-event-proxy filename.
  return /(?:^|\s)[^\s"']*\/codex(?=\s|$)/.test(String(row.args || ''))
}

function appServerProcess(row) {
  return codexProcess(row) && /(?:^|\s)app-server(?=\s|$)/.test(String(row.args || ''))
}

// npm's `codex app-server` process is a Node launcher which keeps running
// after it starts the native App Server binary. Native lifecycle hooks identify
// the child, so commentary originating from the launcher must use that same
// canonical PID or the exact-process fence will correctly reject it.
export function canonicalCodexAppServerPid(rows, launcherPid) {
  const processes = Array.isArray(rows) ? rows : []
  let currentPid = Number(launcherPid)
  if (!Number.isSafeInteger(currentPid) || currentPid < 2) return null

  for (let hop = 0; hop < 4; hop++) {
    const current = processes.find(row => Number(row.pid) === currentPid)
    if (!current || !appServerProcess(current)) break
    const child = processes
      .filter(row => Number(row.ppid) === currentPid && appServerProcess(row))
      .sort((a, b) => Number(a.pid) - Number(b.pid))[0]
    if (!child) break
    currentPid = Number(child.pid)
  }
  return currentPid
}

export async function codexAppServerProcessPid(launcherPid, { execFile }) {
  const fallback = Number(launcherPid)
  if (!Number.isSafeInteger(fallback) || fallback < 2) return null
  try {
    const table = await execFile('ps', ['-axww', '-o', 'pid=,ppid=,comm=,args='], { maxBuffer: 8 << 20 })
    return canonicalCodexAppServerPid(parseProcessTable(table.stdout), fallback)
  } catch {
    // Retain the supplied identity on lookup failure. The caller's existing
    // PID/tmux/session checks still fail closed if it is only a launcher.
    return fallback
  }
}

export function selectCodexProcessPid(rows, panePids) {
  const processes = Array.isArray(rows) ? rows : []
  const roots = [...new Set((panePids || []).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1))]
  if (!roots.length) return null

  const children = new Map()
  for (const row of processes) {
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.ppid)) continue
    const list = children.get(row.ppid) || []
    list.push(row.pid)
    children.set(row.ppid, list)
  }

  const depth = new Map(roots.map(pid => [pid, 0]))
  const queue = [...roots]
  while (queue.length) {
    const parent = queue.shift()
    for (const child of children.get(parent) || []) {
      if (depth.has(child)) continue
      depth.set(child, depth.get(parent) + 1)
      queue.push(child)
    }
  }

  const candidates = processes.filter(row => depth.has(row.pid) && codexProcess(row))
  candidates.sort((a, b) => {
    const aServer = /(?:^|\s)app-server(?=\s|$)/.test(a.args) ? 0 : 1
    const bServer = /(?:^|\s)app-server(?=\s|$)/.test(b.args) ? 0 : 1
    // The owning provider is always the shallowest Codex process. App Server
    // wins only among peers; a tool launched by a direct TUI must never replace
    // its ancestor merely because its argv also says `codex app-server`.
    return depth.get(a.pid) - depth.get(b.pid) || aServer - bServer || a.pid - b.pid
  })
  const selected = candidates[0]
  return selected ? canonicalCodexAppServerPid(processes, selected.pid) : null
}

export async function tmuxCodexProcessPid(tmux, { execFile }) {
  if (!SAFE_TMUX.test(String(tmux || ''))) return null
  let panePids
  let processes
  try {
    const panes = await execFile('tmux', ['list-panes', '-t', tmux, '-F', '#{pane_pid}'])
    panePids = String(panes.stdout || '').split('\n').map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 1)
    const table = await execFile('ps', ['-axww', '-o', 'pid=,ppid=,comm=,args='], { maxBuffer: 8 << 20 })
    processes = parseProcessTable(table.stdout)
  } catch {
    return null
  }
  return selectCodexProcessPid(processes, panePids)
}

export async function waitForCodexResumeClaim(session, {
  tmuxAlive,
  pidAlive,
  findCodexPid,
  validTmuxClaim,
  sleep,
  attempts = 12,
  intervalMs = 250,
}) {
  const expectedTmux = session.tmux
  if (!expectedTmux) throw new Error('replacement Codex tmux identity is missing')

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (session.tmux !== expectedTmux) throw new Error('replacement Codex tmux identity changed during readiness')
    if (!(await tmuxAlive(expectedTmux))) throw new Error('replacement Codex tmux session ended before lifecycle adoption')
    if (session.pid && pidAlive(session.pid) && await validTmuxClaim(session.pid, expectedTmux)) {
      return { source: 'hook', pid: session.pid, tmux: expectedTmux }
    }
    await sleep(intervalMs)
  }

  const pid = await findCodexPid(expectedTmux)
  if (!(pid && pidAlive(pid))) throw new Error('replacement Codex process was not found in its tmux session')
  if (session.tmux !== expectedTmux || !(await tmuxAlive(expectedTmux))) {
    throw new Error('replacement Codex tmux session changed before lifecycle adoption')
  }
  if (!(await validTmuxClaim(pid, expectedTmux))) {
    throw new Error('replacement Codex process failed its tmux ancestry check')
  }

  // A real SessionStart may have landed while the process tree was inspected.
  if (session.pid && pidAlive(session.pid) && await validTmuxClaim(session.pid, expectedTmux)) {
    return { source: 'hook', pid: session.pid, tmux: expectedTmux }
  }
  return { source: 'process-tree', pid, tmux: expectedTmux }
}

export function applyHooklessCodexClaim(state, session, claim) {
  if (!state || !session || session.provider !== 'codex') {
    throw new Error('refusing non-Codex hookless adoption')
  }
  if (state.sessions?.[session.id] !== session || !session.channel || state.channels?.[session.channel] !== session.id) {
    throw new Error('refusing hookless adoption for a non-authoritative session')
  }
  if (!claim || session.tmux !== claim.tmux || !Number.isSafeInteger(claim.pid) || claim.pid < 2) {
    throw new Error('refusing mismatched hookless Codex process claim')
  }
  if (session.pid) return false
  session.pid = claim.pid
  state.channelTmux ||= {}
  state.channelTmux[session.channel] = claim.tmux
  return true
}

export function hooklessAuthoritativeCodexSessions(state) {
  const sessions = []
  const seen = new Set()
  for (const [channel, sessionId] of Object.entries(state.channels || {})) {
    const session = state.sessions?.[sessionId]
    if (!session || seen.has(session.id)) continue
    if (session.provider !== 'codex' || session.pid || !session.tmux || session.channel !== channel) continue
    seen.add(session.id)
    sessions.push(session)
  }
  return sessions
}
