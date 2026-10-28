// Claude can terminate a turn before its spinner is observable and without
// emitting Stop. Keep the pane/transcript failure grammar in this adapter so
// the shared daemon lifecycle does not accumulate provider-specific checks.

export const CLAUDE_FAILURE_DEDUPE_MS = 5 * 60_000

const clean = value => String(value || '').replace(/\s+/g, ' ').trim()

function classifyFailureParagraph(value) {
  const text = clean(value)
  if (/^Login expired\s*[·•]\s*Please run\s+\/login\.?$/i.test(text)) {
    return { kind: 'auth', text }
  }
  if (/^API Error:\s*529\s+Overloaded\b.*$/i.test(text) ||
      /^(?:Claude(?: Code)?|Anthropic(?: API)?)\s+is\s+(?:currently\s+)?overloaded\b.*$/i.test(text)) {
    return { kind: 'overloaded', text }
  }
  return null
}

// Only classify a whole failure-only batch. An ordinary answer may discuss or
// quote these errors; treating a substring match as terminal would truncate a
// legitimate response before its normal Stop hook arrives.
export function claudeTerminalFailureBatch(value) {
  const paragraphs = String(value || '').trim().split(/\n\s*\n/).map(clean).filter(Boolean)
  if (!paragraphs.length) return null
  const failures = paragraphs.map(classifyFailureParagraph)
  if (failures.some(value => !value)) return null

  const unique = []
  const seen = new Set()
  for (const failure of failures) {
    if (seen.has(failure.kind)) continue
    seen.add(failure.kind)
    unique.push(failure)
  }
  return {
    key: unique.map(failure => failure.kind).join('|'),
    kinds: unique.map(failure => failure.kind),
    text: unique.map(failure => failure.text).join('\n\n'),
  }
}

export function claudePollerDecision({
  spinner = false,
  newAssistantText = '',
  hasForm = false,
  sawSpinner = false,
  idleTicks = 0,
  pendingPermission = false,
} = {}) {
  if (spinner) return { action: 'working', idleTicks: 0 }

  const failure = claudeTerminalFailureBatch(newAssistantText)
  if (failure) return { action: 'failure', idleTicks, failure }
  if (hasForm) return { action: 'form', idleTicks: 0 }

  if (sawSpinner && !pendingPermission) {
    const nextIdle = idleTicks + 1
    return { action: nextIdle >= 4 ? 'finalize' : 'wait', idleTicks: nextIdle }
  }
  return { action: 'wait', idleTicks }
}

// A coordinator follow-up starts a distinct durable work generation even when
// Claude keeps the same native session and poller. Spinner disappearance from
// the preceding generation is not evidence that the follow-up completed.
export function resetClaudePollerEvidence(poller) {
  if (!poller) return null
  poller.sawSpinner = false
  poller.idle = 0
  return poller
}

export function prepareClaudeTerminalDelivery(text, previousFailure = null, now = Date.now()) {
  const raw = String(text || '').trim()
  const batch = claudeTerminalFailureBatch(raw)
  if (!batch) return { text: raw, suppress: false, failure: null }

  const failure = { key: batch.key, at: now }
  const suppress = previousFailure?.key === batch.key &&
    now - Number(previousFailure?.at || 0) < CLAUDE_FAILURE_DEDUPE_MS
  return { text: batch.text, suppress, failure }
}

// Claude ends a turn at a usage limit with "You've hit your … limit" and, when
// it can sell extra usage, a chooser whose last option buys credits on the
// exhausted account. Report that surface only while the notice is the latest
// output, so an old notice never hides a newer prompt, answer or spinner.
const USAGE_LIMIT_NOTICE = /\b(?:You['’]ve hit your (?:[\w-]+ )*limit|(?:usage|session|weekly|daily|5-hour) limit reached)\b/i
const USAGE_LIMIT_MENU = /\bStop and wait for (?:the )?limit to reset\b/i

export function claudeUsageLimitSurface(pane) {
  const lines = String(pane || '').split('\n')
  let notice = -1
  for (let i = lines.length - 1; i >= 0 && notice < 0; i--) if (USAGE_LIMIT_NOTICE.test(lines[i])) notice = i
  if (notice < 0) return null
  const later = lines.slice(notice + 1)
  if (later.some(line => /^\s*(?:⏺|>\s+\S)/.test(line) || /[A-Za-z][A-Za-z ]*…\s*\(.*?\)/.test(line))) return null
  return later.some(line => USAGE_LIMIT_MENU.test(line)) ? 'menu' : 'ended'
}

// The chooser's last option buys credits on the exhausted account. Send one
// Escape, which cancels it and cannot select any option, then require the
// chooser gone; never a digit, never Enter, never a second key.
export async function dismissClaudeUsageLimitMenu({ capture, sendKey, sleep, attempts = 20, intervalMs = 250 }) {
  let pane = await capture()
  if (claudeUsageLimitSurface(pane) !== 'menu') return { pane, dismissed: false }
  await sendKey('Escape')
  for (let attempt = 0; attempt < attempts && claudeUsageLimitSurface(pane) === 'menu'; attempt++) {
    await sleep(intervalMs)
    pane = await capture()
  }
  if (claudeUsageLimitSurface(pane) === 'menu') throw new Error('account_limit_menu_not_dismissed')
  return { pane, dismissed: true }
}

export const USAGE_LIMIT_RESUME_PROMPT = 'Your account was switched after a usage limit; resume your task where you left off.'

// Re-deliver what the limit interrupted, exactly once: queued input if there
// is any, otherwise one short line. Shells the restart stopped are always
// named, so an idle agent waiting on one is not left waiting forever.
export function usageLimitResumeInput({ interrupted = false, shells = [], queued = 0 } = {}) {
  const parts = []
  if (interrupted && !queued) parts.push(USAGE_LIMIT_RESUME_PROMPT)
  else if (shells.length) parts.push('Your account was switched after a usage limit.')
  if (shells.length) {
    parts.push(`The restart stopped ${shells.length === 1 ? 'the background shell' : `these ${shells.length} background shells`} you had running:\n` +
      shells.slice(0, 8).map(shell => `- ${shell.command}`).join('\n') + (shells.length > 8 ? `\n- and ${shells.length - 8} more` : '') +
      '\nRestart any you still need.')
  }
  const notes = []
  if (interrupted) notes.push(queued ? 'Its queued input resumes the interrupted turn.' : 'The interrupted turn was asked to resume.')
  if (shells.length) notes.push(`${shells.length} background shell${shells.length === 1 ? ' was' : 's were'} stopped, and the agent was given ${shells.length === 1 ? 'its command' : 'their commands'} to restart.`)
  return { prompt: parts.length ? parts.join('\n\n') : null, note: notes.join(' ') }
}

// Claude's Bash tool runs each command as `<shell> -c source <snapshot> … &&
// eval '<command>' < /dev/null && pwd -P >| <file>`. Recover the command from
// exactly that shape; any other process is not a Bash-tool shell.
const BASH_TOOL_SHELL = /^\S*\/(?:zsh|bash|sh) -c source \S*\/shell-snapshots\/snapshot-\S+ .* && eval '((?:[^']|'"'"')*)' < \/dev\/null && pwd -P >\| \S+$/s

export function claudeBackgroundShellCommand(argv) {
  const match = BASH_TOOL_SHELL.exec(String(argv || ''))
  if (!match) return null
  const command = match[1].replace(/'"'"'/g, "'").replace(/\s+/g, ' ').trim()
  if (!command) return null
  return command.length > 300 ? `${command.slice(0, 299)}…` : command
}
