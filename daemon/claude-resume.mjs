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
