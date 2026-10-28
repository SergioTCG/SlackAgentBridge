import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAUDE_FAILURE_DEDUPE_MS,
  USAGE_LIMIT_RESUME_PROMPT,
  claudeBackgroundShellCommand,
  claudePollerDecision,
  claudeTerminalFailureBatch,
  claudeUsageLimitSurface,
  dismissClaudeUsageLimitMenu,
  prepareClaudeTerminalDelivery,
  resetClaudePollerEvidence,
  usageLimitResumeInput,
} from '../daemon/claude-terminal.mjs'

const LOGIN = 'Login expired · Please run /login'
const OVERLOADED = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.'

test('Claude terminal failures recognize authentication and overload batches', () => {
  assert.deepEqual(claudeTerminalFailureBatch(LOGIN), {
    key: 'auth',
    kinds: ['auth'],
    text: LOGIN,
  })
  assert.deepEqual(claudeTerminalFailureBatch(`${LOGIN}\n\n${LOGIN}\n\n${LOGIN}`), {
    key: 'auth',
    kinds: ['auth'],
    text: LOGIN,
  })
  assert.deepEqual(claudeTerminalFailureBatch(OVERLOADED), {
    key: 'overloaded',
    kinds: ['overloaded'],
    text: OVERLOADED,
  })
  assert.equal(claudeTerminalFailureBatch('The API was overloaded earlier, but the retry passed.'), null)
  assert.equal(claudeTerminalFailureBatch(`${LOGIN}\n\nAuthentication succeeded after the retry.`), null)
})

test('Claude poller finalizes an immediate terminal failure without ever seeing a spinner', () => {
  const auth = claudePollerDecision({ newAssistantText: LOGIN, sawSpinner: false, idleTicks: 0 })
  assert.equal(auth.action, 'failure')
  assert.equal(auth.failure.key, 'auth')

  const overload = claudePollerDecision({ newAssistantText: OVERLOADED, sawSpinner: false, idleTicks: 0 })
  assert.equal(overload.action, 'failure')
  assert.equal(overload.failure.key, 'overloaded')

  assert.deepEqual(claudePollerDecision({ newAssistantText: '', sawSpinner: false, idleTicks: 0 }), {
    action: 'wait', idleTicks: 0,
  })
})

test('Claude poller preserves spinner, form, and missing-Stop fallback behavior', () => {
  assert.deepEqual(claudePollerDecision({ spinner: true, sawSpinner: false, idleTicks: 2 }), {
    action: 'working', idleTicks: 0,
  })
  assert.deepEqual(claudePollerDecision({ hasForm: true, sawSpinner: true, idleTicks: 2 }), {
    action: 'form', idleTicks: 0,
  })
  assert.deepEqual(claudePollerDecision({ sawSpinner: true, idleTicks: 2 }), {
    action: 'wait', idleTicks: 3,
  })
  assert.deepEqual(claudePollerDecision({ sawSpinner: true, idleTicks: 3 }), {
    action: 'finalize', idleTicks: 4,
  })
  assert.deepEqual(claudePollerDecision({ sawSpinner: true, idleTicks: 3, pendingPermission: true }), {
    action: 'wait', idleTicks: 3,
  })
})

test('Claude follow-up generations cannot inherit spinner completion evidence', () => {
  const poller = { sawSpinner: true, idle: 3, last: 'Flibbergibbiting' }

  resetClaudePollerEvidence(poller)

  assert.deepEqual(poller, { sawSpinner: false, idle: 0, last: 'Flibbergibbiting' })
  assert.deepEqual(claudePollerDecision({
    sawSpinner: poller.sawSpinner, idleTicks: poller.idle,
  }), { action: 'wait', idleTicks: 0 })
})

test('Claude terminal failure delivery is deduplicated for a bounded interval', () => {
  const now = 10_000
  const first = prepareClaudeTerminalDelivery(`${LOGIN}\n\n${LOGIN}`, null, now)
  assert.equal(first.text, LOGIN)
  assert.equal(first.suppress, false)
  assert.deepEqual(first.failure, { key: 'auth', at: now })

  const duplicate = prepareClaudeTerminalDelivery(LOGIN, first.failure, now + 1_000)
  assert.equal(duplicate.suppress, true)

  const later = prepareClaudeTerminalDelivery(LOGIN, first.failure, now + CLAUDE_FAILURE_DEDUPE_MS + 1)
  assert.equal(later.suppress, false)

  const recovery = prepareClaudeTerminalDelivery('Authentication restored.', first.failure, now + 2_000)
  assert.equal(recovery.suppress, false)
  assert.equal(recovery.failure, null)
})

const LIMIT_NOTICE = "  ⎿  You've hit your weekly limit · resets Oct 31 at 4pm (Europe/Ljubljana)"
const IDLE_FOOTER = ['', '✻ Churned for 44s · done 7:52 AM', '────────', '❯ ', '────────', '  HEAD',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
const LIMIT_IDLE = ['  </sab-team-message>', '', '  Ran 1 shell command', LIMIT_NOTICE, ...IDLE_FOOTER].join('\n')
const LIMIT_MENU = ['  </sab-team-message>', LIMIT_NOTICE, '', '✻ Cooked for 9s · done 7:52 AM · 2 shells still running', '▔▔▔▔▔▔▔▔',
  '   What do you want to do?', '', '   ❯ 1. Stop and wait for limit to reset',
  '     2. Wait here, then continue automatically at Oct 31 at 4pm', '     3. Switch to usage credits', '',
  '   Enter to confirm · Esc to cancel'].join('\n')

test('a usage-limit surface is recognised only while its notice is the latest output', () => {
  assert.equal(claudeUsageLimitSurface(LIMIT_MENU), 'menu')
  assert.equal(claudeUsageLimitSurface(LIMIT_IDLE), 'ended')
  assert.equal(claudeUsageLimitSurface(['⏺ Done.', ...IDLE_FOOTER].join('\n')), null)
  for (const later of ['⏺ Resumed on the new account.', '> next prompt', '✶ Newspapering… (8s · ↓ 487 tokens)']) {
    assert.equal(claudeUsageLimitSurface([LIMIT_NOTICE, later, ...IDLE_FOOTER].join('\n')), null, later)
  }
})

test('only Claude\'s own limit rendering counts, never a reply that quotes it', () => {
  const footer = ['❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
  assert.equal(claudeUsageLimitSurface(["⏺ The pane said: You've hit your weekly limit · resets 4pm", ...footer].join('\n')), null)
  assert.equal(claudeUsageLimitSurface([LIMIT_NOTICE, '❯ typed but not sent', ...footer].join('\n')), null, 'typed input is newer')
  // Quoted option rows without the dialog's footer are not an open chooser.
  assert.equal(claudeUsageLimitSurface([LIMIT_NOTICE, '   1. Stop and wait for limit to reset', ...footer].join('\n')), 'ended')
  assert.equal(claudeUsageLimitSurface(['⏺ Reply quoting a chooser:', '  ❯ 1. Stop and wait for limit to reset',
    '  Enter to confirm · Esc to cancel', ...footer].join('\n')), null, 'no notice row, no surface')
})

test('the usage-limit chooser is dismissed with one Escape and never buys credits', async () => {
  const sent = []
  let pane = LIMIT_MENU
  const result = await dismissClaudeUsageLimitMenu({
    capture: async () => pane,
    sendKey: async key => { sent.push(key); pane = LIMIT_IDLE },
    sleep: async () => {},
  })
  assert.deepEqual(sent, ['Escape'])
  assert.equal(result.dismissed, true)
  assert.equal(claudeUsageLimitSurface(result.pane), 'ended')

  const stuck = []
  await assert.rejects(dismissClaudeUsageLimitMenu({
    capture: async () => LIMIT_MENU, sendKey: async key => { stuck.push(key) }, sleep: async () => {}, attempts: 3,
  }), /account_limit_menu_not_dismissed/)
  assert.deepEqual(stuck, ['Escape'], 'a chooser that stays up is never answered with a second key')

  const idle = []
  assert.equal((await dismissClaudeUsageLimitMenu({ capture: async () => LIMIT_IDLE, sendKey: async key => { idle.push(key) },
    sleep: async () => {} })).dismissed, false)
  assert.deepEqual(idle, [])
})

test('usage-limit re-delivery is the queued input or one short line, and names stopped shells', () => {
  assert.deepEqual(usageLimitResumeInput({ interrupted: true }), { prompt: USAGE_LIMIT_RESUME_PROMPT,
    note: 'The interrupted turn was asked to resume.' })
  assert.equal(USAGE_LIMIT_RESUME_PROMPT, 'Your account was switched after a usage limit; resume your task where you left off.')
  assert.deepEqual(usageLimitResumeInput({ interrupted: true, queued: 1 }), { prompt: null,
    note: 'Its queued input resumes the interrupted turn.' })
  assert.deepEqual(usageLimitResumeInput({}), { prompt: null, note: '' }, 'an idle session is not prompted')
  const shells = [{ command: 'gh run watch 42' }, { command: 'sleep 600' }]
  const idle = usageLimitResumeInput({ shells })
  assert.match(idle.prompt, /^Your account was switched after a usage limit\.\n\nThe restart stopped these 2 background shells/)
  assert.match(idle.prompt, /- gh run watch 42\n- sleep 600\nRestart any you still need\.$/)
  assert.match(usageLimitResumeInput({ interrupted: true, shells }).prompt, /^Your account was switched after a usage limit; resume your task where you left off\.\n\n/)
  assert.match(idle.note, /2 background shells were stopped/)
})

test('only Claude Bash-tool shells are recognised, with their exact command', () => {
  const wrap = command => `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-abc.sh 2>/dev/null || true && ` +
    `setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '${command}' < /dev/null && pwd -P >| /tmp/claude-ce1d-cwd`
  assert.equal(claudeBackgroundShellCommand(wrap(`gh pr view 1 --jq '"'"'.state'"'"'; sleep 600`)), "gh pr view 1 --jq '.state'; sleep 600")
  assert.equal(claudeBackgroundShellCommand(wrap('python3 -I watch.py').replace('/Users/me/.claude', '/Users/me/.config/ccs/account-auth/claude/personal')),
    'python3 -I watch.py', 'a profile login keeps its snapshots elsewhere')
  assert.equal(claudeBackgroundShellCommand(wrap('x'.repeat(400))).length, 300)
  for (const other of ['node /bridge/channel/server.mjs', 'claude --resume abc', '/bin/zsh -c npm test', '']) {
    assert.equal(claudeBackgroundShellCommand(other), null, other)
  }
})
