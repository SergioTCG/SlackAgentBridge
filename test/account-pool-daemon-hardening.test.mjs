import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { claudeUsageLimitSurface } from '../daemon/claude-terminal.mjs'
import { holdsUsageLimitWork } from '../daemon/session-update.mjs'
import { accountCredentialReference } from '../daemon/account-profiles.mjs'
import { targetStartupState } from '../daemon/providers.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const AsyncFunction = (async () => {}).constructor
const BOX = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const BANNER_PANE = [BOX, '❯ ', BOX, '  ⚠ Usage limit reached · limit resets 8am', '    Continuing automatically at 8am · Esc to cancel', '', FOOTER].join('\n')
const IDLE_PANE = [BOX, '❯ ', BOX, '', FOOTER].join('\n')
const between = (from, to) => {
  const start = daemon.indexOf(from), end = daemon.indexOf(to, start)
  assert.ok(start > 0 && end > start, `missing ${from}`)
  return daemon.slice(start, end)
}
const declaration = name => {
  const found = new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(daemon)?.[0]
  assert.ok(found, `missing function ${name}`)
  return found
}

async function pollerAtLimit({ pane = BANNER_PANE, held = true, exhausted = true, pending = false, dispatching = false } = {}) {
  const block = between('const limit = line || form || holdAnsweredForm ? null : claudeUsageLimitSurface(pane)', 'const decision = claudePollerDecision({')
  const calls = [], p = { stopped: false, sawSpinner: false }
  const session = { id: 'worker-one', channel: 'CWORK', ...(held ? { teamActiveTaskId: 'task' } : {}), ...(pending ? { teamProviderTurnPending: {} } : {}) }
  const deps = { line: '', form: null, holdAnsweredForm: false, pane, claudeUsageLimitSurface, holdsUsageLimitWork, session, p, observation: {},
    state: { teamTasks: { task: { status: dispatching ? 'dispatching' : 'running' } } },
    accountPools: { measuredExhaustion: () => exhausted ? { accountId: 'acct-out', email: 'out@example.test' } : null },
    ownsAutomationRecord: () => false, teamProviderPollerObservationCurrent: () => true,
    stopPoller: () => calls.push('stop'), saveStateNow: () => calls.push('save'), clearStatus: async () => calls.push('clear'),
    log: message => calls.push(message), post: async (channel, text) => { calls.push(`post ${channel}: ${text}`) } }
  const result = await new AsyncFunction('deps', `const { ${Object.keys(deps).join(', ')} } = deps\n${block}\nreturn 'continued'`)(deps)
  return { result, calls, p, session }
}

test('a held Claude turn that a usage limit ended at once is paused instead of read as running', async () => {
  const { result, calls, p, session } = await pollerAtLimit()
  assert.equal(result, undefined, 'the poller stops here')
  assert.equal(p.stopped, true)
  assert.deepEqual(session.usageLimitPause.accountId, 'acct-out')
  assert.deepEqual(calls.slice(0, 4), ['stop', 'save', 'clear', 'Claude turn paused at a usage limit'])
  assert.match(calls.at(-1), /^post CWORK: ⏸️ Claude hit the usage limit on out@example\.test\. SAB paused this turn/)
})

test('a limit-ended turn with nothing held, or nothing the pool can act on, simply ends', async () => {
  for (const options of [{ held: false }, { exhausted: false }, { pending: true }, { dispatching: true }]) {
    const { result, calls, p, session } = await pollerAtLimit(options)
    assert.equal(result, 'continued', JSON.stringify(options))
    assert.equal(p.sawSpinner, true, 'the limit counts as the turn having run, so the poller finalizes it')
    assert.equal(session.usageLimitPause, undefined)
    assert.deepEqual(calls, [])
  }
  const idle = await pollerAtLimit({ pane: IDLE_PANE })
  assert.equal(idle.result, 'continued')
  assert.equal(idle.p.sawSpinner, false, 'an idle pane without the limit proves nothing')
})

test('the Claude poller checks the limit before its idle decision, and only without a spinner or open form', () => {
  const poller = between('function startPoller(session) {', 'const codexPollers = new Map()')
  assert.ok(poller.indexOf('claudeUsageLimitSurface(pane)') < poller.indexOf('claudePollerDecision({'))
  assert.match(poller, /const limit = line \|\| form \|\| holdAnsweredForm \? null : claudeUsageLimitSurface\(pane\)/)
})

function syncAutomation() {
  return new Function('deps', `const { state } = deps\n${declaration('syncAutomationTmux')}\nreturn syncAutomationTmux`)
}

test('an automation record follows its session to a new terminal, and only an exact, open one', () => {
  const session = { id: 'sid', channel: 'CAUTO', tmux: 'sab-res-new' }
  const state = { sessions: { sid: session }, automations: {
    open: { sessionId: 'sid', channelId: 'CAUTO', status: 'active', tmux: 'sab-auto-old' },
    failed: { sessionId: 'sid', channelId: 'CAUTO', status: 'failed', tmux: 'sab-auto-old' },
    stopped: { sessionId: 'sid', channelId: 'CAUTO', status: 'stopped', tmux: 'sab-auto-old' },
    released: { sessionId: 'sid', channelId: 'CAUTO', status: 'released', tmux: 'sab-auto-old' },
    otherChannel: { sessionId: 'sid', channelId: 'COTHER', status: 'active', tmux: 'sab-auto-old' },
    otherSession: { sessionId: 'other', channelId: 'CAUTO', status: 'active', tmux: 'sab-auto-old' },
  } }
  const sync = syncAutomation()({ state })
  assert.equal(sync(session), true)
  assert.equal(state.automations.open.tmux, 'sab-res-new')
  assert.equal(state.automations.failed.tmux, 'sab-res-new', 'a failed stop becomes repeatable')
  for (const key of ['stopped', 'released', 'otherChannel', 'otherSession']) assert.equal(state.automations[key].tmux, 'sab-auto-old', key)
  assert.equal(sync(session), false, 'nothing left to change')
  state.sessions.thief = { id: 'thief', tmux: 'sab-res-new' }
  state.automations.open.tmux = 'sab-auto-old'
  assert.equal(sync(session), false, 'a terminal another session claims is never adopted')
})

test('records are healed at boot and whenever a hook binds a terminal, and after a usage-limit handover', () => {
  const readopt = between('async function readoptStatus() {', 'const deferred = deferredTeamProviderFinal(s)')
  assert.match(readopt, /syncAutomationTmux\(s\)/)
  const hook = between('session.tmux = tmux || session.tmux', 'session.cwd = body.cwd || session.cwd')
  assert.ok(hook.indexOf('validTmuxClaim(pid, session.tmux)') < hook.indexOf('syncAutomationTmux(session)'), 'only a verified terminal is adopted')
  assert.match(declaration('settleUsageLimitHandover'), /syncAutomationTmux\(session\)/)
})

function probe({ panes, profileLeased = false, ref = 'profile' }) {
  const source = between('const CLAUDE_LAUNCH_BLOCKERS = [', '// The account the Mac\'s own Claude login')
  const calls = [], configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-probe-'))
  let index = 0
  const deps = { accountCredentialReference, targetStartupState, fs, path, os, crypto, CONFIG_DIR: configDir,
    claudeProfileHome: (dir, profile) => { if (profileLeased) throw new Error('account_profile_busy'); return `/profiles/${profile}` },
    seedClaudeFirstRunState: () => calls.push(['seed']), claudeNativeConfigFile: () => '/native/.claude.json',
    sleep: async () => {},
    execFile: async (command, args) => {
      calls.push([command, ...args])
      if (args[0] === 'capture-pane') return { stdout: panes[Math.min(index++, panes.length - 1)] }
      return { stdout: '' }
    } }
  const run = new AsyncFunction('deps', `const { ${Object.keys(deps).join(', ')} } = deps\n${source}\nreturn probeClaudeLaunch(deps.account)`)
  const account = { provider: 'claude', email: 'x@example.test',
    credentials: ref === 'profile' ? [{ kind: 'claude-profile', profile: 'spare' }] : [{ kind: 'native-default' }] }
  return { run: () => run({ ...deps, account }), calls, cleanup: () => fs.rmSync(configDir, { recursive: true, force: true }) }
}

test("SAB's hidden launch check starts Claude exactly like a session, with no prompt and no bridge, and reports what it saw", async () => {
  const ready = probe({ panes: ['loading', IDLE_PANE] })
  try {
    assert.deepEqual(await ready.run(), { ok: true })
    const launch = ready.calls.find(call => call[1] === 'new-session')
    assert.ok(launch.includes('env') && launch.includes('-i'), 'a clean environment')
    assert.ok(!launch.some(arg => /^CCS_/.test(arg)), 'no CCS_BRIDGE: the hooks never reach SAB')
    assert.ok(launch.includes('CLAUDE_CONFIG_DIR=/profiles/spare'))
    assert.deepEqual(launch.slice(-2), ['claude', '--dangerously-skip-permissions'])
    assert.ok(launch[launch.indexOf('-s') + 1].startsWith('ccs-probe-'), 'never an sab- session name')
    assert.ok(ready.calls.some(call => call[0] === 'seed'), 'the profile gets the same first-run seeding as a session launch')
    assert.ok(ready.calls.at(-1)[1] === 'kill-session', 'the terminal is always removed')
  } finally { ready.cleanup() }
  const native = probe({ panes: [IDLE_PANE], ref: 'native' })
  try {
    await native.run()
    assert.ok(!native.calls.find(call => call[1] === 'new-session').some(arg => arg.startsWith('CLAUDE_CONFIG_DIR=')))
  } finally { native.cleanup() }
})

test('the hidden launch answers folder trust only on a visibly selected Yes, and reports blocking screens', async () => {
  const trustYes = probe({ panes: ['Is this a project you created or one you trust?\n❯ Yes, I trust this folder\n  No, exit', IDLE_PANE] })
  const trustNo = probe({ panes: ['Is this a project you created or one you trust?\n  Yes, I trust this folder\n❯ No, exit', IDLE_PANE] })
  try {
    assert.deepEqual(await trustYes.run(), { ok: true })
    assert.ok(trustYes.calls.some(call => call[1] === 'send-keys' && call.at(-1) === 'Enter'))
    await trustNo.run()
    assert.ok(trustNo.calls.some(call => call[1] === 'send-keys' && call.at(-1) === 'Down'))
    assert.ok(!trustNo.calls.some(call => call[1] === 'send-keys' && call.at(-1) === 'Enter'), 'never Enter on "No, exit"')
  } finally { trustYes.cleanup(); trustNo.cleanup() }
  for (const [reason, pane] of [['terms', "We've updated our Consumer Terms. Please review and accept."], ['login', 'Select login method:'],
    ['onboarding', 'Choose the text style that looks best'], ['chrome', 'Claude in Chrome extension detected'],
    ['permissions', 'WARNING: Claude Code running in Bypass Permissions mode\n1. No, exit\n2. Yes, I accept']]) {
    const blocked = probe({ panes: [pane] })
    try { assert.deepEqual(await blocked.run(), { ok: false, reason }) } finally { blocked.cleanup() }
  }
  const stuck = probe({ panes: ['loading'] })
  try { assert.deepEqual(await stuck.run(), { ok: false, reason: 'timeout' }) } finally { stuck.cleanup() }
})

test('a profile held by a renewal or sign-in is skipped, never launched', async () => {
  const leased = probe({ panes: [IDLE_PANE], profileLeased: true })
  try {
    assert.deepEqual(await leased.run(), { skipped: true })
    assert.ok(!leased.calls.some(call => call[0] === 'tmux'))
  } finally { leased.cleanup() }
})

test("the Mac login's account is read from Claude's own config, and only again when it changes", () => {
  const source = between('let nativeIdentityCache = null', 'const accountPools = createAccountPoolRuntime({')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-native-')), file = path.join(dir, '.claude.json')
  let reads = 0
  const counting = { ...fs, readFileSync: (...args) => { reads++; return fs.readFileSync(...args) } }
  try {
    const read = new Function('deps', `const { fs, os, claudeNativeConfigFile } = deps\n${source}\nreturn readNativeClaudeIdentity`)({
      fs: counting, os, claudeNativeConfigFile: () => file })
    assert.equal(read(), null, 'no config: unknown')
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'mac@example.test' }, projects: {} }))
    assert.deepEqual(read(), { email: 'mac@example.test' })
    assert.deepEqual(read(), { email: 'mac@example.test' })
    assert.equal(reads, 1, 'unchanged files are not parsed again')
    fs.writeFileSync(file, '{ not json')
    assert.equal(read(), null)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the daemon wires the launch check, the Mac login reader and the owner limit rule into the pool, and reports each session start', () => {
  assert.match(daemon, /nativeLoginIdentity: async \(\) => readNativeClaudeIdentity\(\),/)
  assert.match(daemon, /probeLaunch: account => probeClaudeLaunch\(account\),/)
  assert.match(daemon, /atUsageLimit: async session => Boolean\(session\.usageLimitPause\) \|\|\n\s*Boolean\(session\.tmux && usageLimitSurface\(providerOf\(session\), await tmuxCapture\(session\.tmux\)\)\),/)
  assert.match(daemon, /await completeAuthoritativeSessionStart\(session, provider, body\.source\)\n(?:\s*\/\/.*\n)*\s*accountPools\.noteLaunch\(session\)\n\s*return/)
})

test('/sab-account words the wait reasons and refusals plainly', () => {
  const text = new Function(`${declaration('accountWaitingText')}\n${declaration('accountSwitchBlockedNotice')}\nreturn { accountWaitingText, accountSwitchBlockedNotice }`)()
  assert.equal(text.accountWaitingText('no-capacity'), 'no account in the group has capacity')
  assert.equal(text.accountWaitingText('launch-check:terms'), "the target login's launch check is failing (terms)")
  assert.equal(text.accountWaitingText('launch-check:pending'), "the target login's launch check is still to run")
  assert.equal(text.accountWaitingText('blocked:question awaiting an answer'), 'question awaiting an answer')
  assert.match(text.accountSwitchBlockedNotice({ blockReason: 'turn in progress' }), /^❌ Can't switch accounts right now: turn in progress\. Nothing was changed\./)
})

test('a screen that shows for one look and then gives way to the prompt is not a failure', async () => {
  const passing = probe({ panes: Array(7).fill('loading').concat(["We've updated our Consumer Terms.", IDLE_PANE]) })
  try { assert.deepEqual(await passing.run(), { ok: true }) } finally { passing.cleanup() }
})
