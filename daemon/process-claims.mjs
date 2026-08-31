const PROVIDER_COMM = Object.freeze({
  claude: /claude/i,
  codex: /codex/i,
  pi: /(?:^|\/)pi(?:$|\s)/i,
})

// A provider utility launched from inside an interactive provider (for example
// `codex review`) inherits the tmux and hook environment. It is nevertheless a
// child job, not another SAB session. Reject a claim when another process for
// the same provider sits between the claimant and the owning tmux pane.
export function isNestedProviderClaim(processes, pid, panePids, provider) {
  const rows = new Map((processes || []).map(row => [Number(row.pid), row]))
  const panes = new Set((panePids || []).map(Number))
  const pattern = PROVIDER_COMM[provider]
  if (!pattern) return true
  // The detached runner execs Claude/Pi directly, so the authoritative
  // provider may itself own the tmux pane rather than being its descendant.
  if (panes.has(Number(pid))) return false
  let current = Number(rows.get(Number(pid))?.ppid)
  for (let hop = 0; hop < 16 && current > 1; hop++) {
    if (panes.has(current)) return false
    const row = rows.get(current)
    if (!row) return true
    if (pattern.test(String(row.comm || ''))) return true
    const next = Number(row.ppid)
    if (!next || next === current) return true
    current = next
  }
  return true
}
