import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')

test('argument-free management commands render controls through existing command paths', () => {
  assert.match(daemon, /name === 'terminal'[\s\S]*const interactive = rest\.length === 0[\s\S]*postTerminalManagement/)
  assert.match(daemon, /name === 'switch'[\s\S]*!rest\.length && !ingressProvider[\s\S]*postSwitchManagement/)
  assert.match(daemon, /name === 'model' \|\| name === 'effort'[\s\S]*postModelManagement[\s\S]*postEffortManagement/)
  assert.match(daemon, /name === 'update' \|\| name === 'restart'[\s\S]*!rest\.length[\s\S]*postUpdateManagement/)
  assert.match(daemon, /name === 'new'[\s\S]*!rest\.length[\s\S]*postNewSessionManagement/)
})

test('Claude interactive model controls carry exact provider model identities', () => {
  assert.match(daemon, /return claudeModelPickerOptions\(models\)/)
  assert.doesNotMatch(daemon, /value: model\.alias \|\| model\.id/)
})

test('textual management forms remain routed for automation and muscle memory', () => {
  assert.match(daemon, /\['current', 'here'\]\.includes\(rest\[0\]\.toLowerCase\(\)\)/)
  assert.match(daemon, /if \(all\) return updateAllSessions\(channel\)/)
  assert.match(daemon, /return setCodexSetting\(session, name, val, \{ expectedSessionId \}\)/)
  assert.match(daemon, /return setPiSetting\(session, name, val, \{ expectedSessionId \}\)/)
  assert.match(daemon, /return beginProviderSwitch\(channel, channelSession, \{ replaceMissing, targetProvider, expectedSessionId \}\)/)
  assert.match(daemon, /return spawnNew\(channel, rest\[0\], rest\.slice\(1\), commandProvider\)/)
})

test('a standby Claude leg whose conversation Claude Code deleted is replaced only with new', () => {
  const begin = /async function beginProviderSwitch\([\s\S]*?\n\}\n/.exec(daemon)?.[0] || ''
  assert.match(begin, /const savedTargetGone = !!savedTarget && claudeConversationGone\(savedTarget\)/)
  assert.match(begin, /\(!savedTarget \|\| savedTargetGone\) && !replaceMissing\) \{[\s\S]*?deleted its conversation[\s\S]*?return post\(/)
  assert.match(begin, /\(!savedTarget \|\| savedTargetGone\) && replaceMissing\) \{\s*if \(savedTarget\) delete state\.sessions\[savedTargetSid\]\s*lineage\.legs\[targetProvider\] = null/)
  const gone = /function claudeConversationGone\(session\) \{[\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(gone, /providerOf\(session\) !== 'claude'\) return false/)
  assert.match(gone, /resumeCwd\(session\)/)
})

test('a Claude session with no conversation yet is refused by every restart path before teardown', () => {
  // Bulk and scheduled updates, their revalidation and account-pool handover
  // all read the shared bulk-update context.
  const context = /function bulkUpdateContext\(\) \{[\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(context, /conversationMissing: claudeConversationGone,/)
  assert.match(daemon, /function accountPoolBlockReason\([\s\S]*?const context = bulkUpdateContext\(\)/)
  const guarded = [
    ['updateAndRestart', 'stopSessionForUpdate('],
    ['switchAccount', 'restartSessionWithMutation('],
    ['setFlags', 'restartSessionWithMutation('],
  ]
  for (const [name, teardown] of guarded) {
    const body = new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`).exec(daemon)?.[0] || ''
    const check = body.indexOf('if (claudeConversationGone(session)) return post(session.channel, NO_CONVERSATION_NOTICE)')
    assert.ok(check > 0 && check < body.indexOf(teardown), `${name} must refuse before ${teardown}`)
  }
  const restart = /async function restartSessionWithMutation\([\s\S]*?\n\}\n\nasync function switchAccount/.exec(daemon)?.[0] || ''
  const refused = restart.indexOf('if (claudeConversationGone(session)) throw new Error(')
  assert.ok(refused > 0 && refused < restart.indexOf('reserveSessionMaintenance('))
  // Both owner-initiated pool switches explain the refusal instead of failing generically.
  const switches = daemon.split('await accountPools.switchAccount(').slice(0, -1)
  assert.equal(switches.length, 2)
  for (const before of switches) {
    assert.match(before.slice(-200), /if \(claudeConversationGone\(session\)\) return post\(channel, NO_CONVERSATION_NOTICE\)\n\s*const result = $/)
  }
})

test('a SAB restart never ends the held work it is resuming', () => {
  // Claude sends SessionEnd when SAB closes its tmux. A usage-limit handover
  // remembers the stopped pid before teardown, for a bounded time, and every
  // later hook from it is ignored, so it cannot fail the running task or revoke
  // the turn it resumes. Other restarts keep the old rule.
  const stop = /async function stopReservedSession\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.ok(stop.indexOf('if (resumesTurn) rememberStoppedProviderPid(oldPid)') >= 0 &&
    stop.indexOf('if (resumesTurn) rememberStoppedProviderPid(oldPid)') < stop.indexOf('tmuxKill('))
  assert.match(daemon, /resumesTurn: Boolean\(options\.usageLimit\),/)
  assert.match(daemon, /function providerStoppedForHandover\(pid\) \{[\s\S]*?Date\.now\(\) - at < STOPPED_PROVIDER_PID_TTL_MS/)
  assert.match(daemon, /if \(session && ev !== 'SessionStart' && providerStoppedForHandover\(pid\)\) \{\n\s+log\('ignored hook from a provider SAB stopped'/)
  assert.ok(daemon.indexOf('providerStoppedForHandover(pid)') < daemon.indexOf("if (ev === 'SessionEnd') {"))
  // The liveness sweep leaves a restart's own stop to the restart.
  assert.match(daemon, /if \(s\.pid && !pidAlive\(s\.pid\)\) \{\n\s+\/\/ [^\n]+\n\s+if \(restarting\.has\(s\.id\) \|\| providerStoppedForHandover\(s\.pid\)\) continue/)
  // Daemon re-adoption keeps a turn a usage limit paused, with live-turn proof
  // for its running task, instead of failing it as an unproven idle turn.
  const idle = /if \(accountPools\.mode === 'auto' && claudeUsageLimitSurface\(pane\) \|\| accountMaintenanceHoldsTask\(s\)\) \{[\s\S]*?\} else if \(idleTask\) await releaseIdleReadoptedTeamTaskIfStillIdle\(s, idleTask, 'Claude Code'\)/.exec(daemon)?.[0] || ''
  assert.match(idle, /if \(s\.teamActiveTaskId\) teamTurnProof\.add\(s\.id\)/)
  // Every path that fails a worker's task first yields to pending account
  // maintenance: the task is kept, and only the turn is revoked.
  const fail = /async function failTeamTaskForSession\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(fail, /^async function failTeamTaskForSession\([^\n]*\n\s+if \(accountMaintenanceHoldsTask\(session\)\) \{\n\s+if \(clearTeamTurn\(session\)\) saveStateNow\(state\)\n[^\n]*\n\s+return false/)
})

test('a turn a usage limit paused is resumed, never reported, failed or released', () => {
  // Codex: the live poller pauses the limit-ended turn before its idle report,
  // boot keeps it, and an idle coordinator keeps its authority.
  const poller = daemon.indexOf("log('Codex turn paused at a usage limit'")
  assert.ok(poller > 0 && poller < daemon.indexOf("'Codex returned to idle without its lifecycle completion hook. The accepted worker turn completed"))
  assert.match(daemon, /if \(accountPools\.mode === 'auto' && usageLimitSurface\('codex', pane\) \|\| accountMaintenanceHoldsTask\(s\)\) \{[\s\S]*?\} else if \(idleTask\) await releaseIdleReadoptedTeamTaskIfStillIdle\(s, idleTask, 'Codex'\)/)
  const coordinator = /async function reconcileIdleCodexCoordinator\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.ok(coordinator.indexOf('codexUsageLimitSurface(pane)') > 0 && coordinator.indexOf('codexUsageLimitSurface(pane)') < coordinator.indexOf('clearTeamTurn(coordinator)'))
  // The in-place resume: held work only, rate-limited, the chooser closed with
  // the one-Escape helper, then one bridge-injected line.
  const resume = /async function resumeSessionAfterLimit\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(resume, /if \(!usageLimitResumeWanted\(session, \{/)
  assert.match(resume, /dismissClaudeUsageLimitMenu\(/)
  assert.ok(resume.indexOf('session.usageLimitResumedAt = Date.now()') < resume.indexOf('injectText(session, USAGE_LIMIT_LIFTED_PROMPT)'))
  assert.doesNotMatch(resume, /send-keys', '-t', expected\.tmux, '(?:[0-9]|Enter)'/)
  assert.match(daemon, /resumeAfterLimit: session => resumeSessionAfterLimit\(session\),/)
  // New sessions start on an account with capacity.
  assert.equal((daemon.match(/const launch = account \? null : newSessionLaunchAccount\(provider\)/g) || []).length, 2)
})

test('interactive actions are owner-only and revalidate exact authoritative bindings', () => {
  const handler = /async function handleSocketInteractive\(\{ body \}\) \{([\s\S]*?)\n\}\n\nconst socketCoordinator/.exec(daemon)?.[1] || ''
  assert.match(handler, /body\?\.user\?\.id !== USER/)
  assert.match(handler, /handleAppHomeSubmission/)
  assert.match(handler, /parseAppHomeActionId/)
  assert.match(handler, /parseManagementActionId/)
  assert.match(daemon, /authoritativeManagementBinding\(state, channel, target\)/)
  assert.match(daemon, /authoritative\.id !== target/)
  assert.match(daemon, /request\?\.expectedSessionId/)
  assert.match(daemon, /managementTargetStillAuthoritative\(channel, session, request\)/)
  assert.match(daemon, /const expectedSessionId = request\?\.expectedSessionId \|\| null/)
  assert.match(daemon, /const expectedSessionId = parsed\.target === 'bridge' \? null : parsed\.target/)
  assert.doesNotMatch(daemon, /await managementModelCatalog\(session\)[\s\S]{0,600}expectedSessionId: session\.id/)
  assert.match(daemon, /terminalControl\.act\(operation, \{[\s\S]{0,160}expectedSessionId/)
  assert.match(daemon, /beginProviderSwitch\(channel, channelSession, \{ replaceMissing, targetProvider, expectedSessionId \}\)/)
  assert.match(daemon, /updateAndRestart\(session, \{ expectedSessionId \}\)/)
})

test('team management actions reject a panel rendered for a replaced team', () => {
  assert.match(daemon, /request\?\.expectedTeamId/)
  assert.match(daemon, /activeTeamForChannel\(state, channel\)\?\.id !== expectedTeamId/)
  assert.match(daemon, /expectedTeamId: parsed\.binding/)
})

test('team management actions redraw state-dependent controls after refresh and mutations', () => {
  const action = /if \(parsed\.kind === 'team'\) \{[\s\S]*?\n  \}/.exec(daemon)?.[0] || ''
  assert.match(action, /interactiveManagement: true/)

  const handler = /async function handleTeamCommand\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(handler, /request\?\.interactiveManagement/)
  assert.match(handler, /sub === 'status'[\s\S]*postTeamManagement\(channel, session, team\)/)
  assert.match(handler, /sub === 'auto' \|\| sub === 'manual'[\s\S]*postTeamManagement\(channel, session, team\)/)
  assert.match(handler, /sub === 'drain' \|\| sub === 'resume'[\s\S]*setTeamDispatchMode/)
})

test('session update ownership is reserved before Slack and follows a native identity replacement', () => {
  const reserve = /function reserveSessionMaintenance\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(reserve, /const sessionId = expectedSessionId \|\| session\?\.id/)
  assert.match(reserve, /restarting\.add\(sessionId\)/)
  assert.match(reserve, /beginSessionInputFence\(sessionId\)/)
  assert.match(reserve, /fenceOwner/)
  assert.match(reserve, /resurrectInFlight\.has\(sessionId\)/)

  const stop = /async function stopSessionForUpdate\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(stop, /reserveSessionMaintenance\(session/)
  assert.match(stop, /releaseSessionMaintenance\(reservation, session\)/)

  const update = /async function updateAndRestart\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(update, /const updateSessionId = expectedSessionId \|\| session\.id/)
  assert.match(update, /if \(reservation\) releaseSessionMaintenance\(reservation, session\)/)
  assert.match(daemon, /rebindSessionRuntimeState\(priorSid, sid, \{[\s\S]{0,500}pendingBySession: pendingBySid/)
})

test('replacement startup drains all queued input before releasing direct delivery', () => {
  const completion = /async function completeAuthoritativeSessionStart\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(completion, /ensureSessionInputFence\(sid\)/)
  assert.match(completion, /scheduleSessionInputDrain\(session, provider, tmux\)/)
  const drain = /function scheduleSessionInputDrain\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(drain, /drainSessionInputQueue\(\(\) => session\.id/)
  assert.doesNotMatch(completion, /pendingBySid\.set\(sid, \[\]\)[\s\S]*setTimeout/)

  const start = /if \(ev === 'SessionStart'\) \{[\s\S]{0,1200}completeAuthoritativeSessionStart/.exec(daemon)?.[0] || ''
  assert.doesNotMatch(start, /updatingSessions\.delete\(sid\)/)
})

test('retained input on a live idle surface is reconciled instead of remaining in limbo', () => {
  const blocker = /function liveSessionInputRecoveryBlocked\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(blocker, /qforms\.has/)
  assert.match(blocker, /session\.teamActiveTaskId/)
  assert.match(blocker, /codexTurnStartedAt/)
  assert.match(blocker, /codexPollers\.has/)
  const recovery = /async function recoverLiveSessionInputQueue\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(recovery, /shouldRecoverLiveSessionInput/)
  assert.match(recovery, /completedSessionStartTmux/)
  assert.match(recovery, /pendingSessionStartTmux/)
  assert.match(recovery, /completedSessionStartTmux\.set\(expected\.id, expected\.tmux\)/)
  assert.match(recovery, /targetStartupState/)
  assert.match(recovery, /validProviderRootClaim/)
  assert.match(recovery, /bootSessionInputClaims\.consume\(session\)/)
  assert.ok(recovery.split('liveSessionInputRecoveryBlocked').length >= 3,
    'interactive and active-turn fences must be rechecked after awaited authority proofs')
  assert.match(recovery, /scheduleSessionInputDrain/)
  const completion = /async function completeAuthoritativeSessionStart\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(completion, /bootSessionInputClaims\.revoke\(session\)/,
    'a startup handled by this daemon must revoke boot-only reconstruction before metadata can fail')
  assert.match(daemon, /setInterval\(async \(\) => \{[\s\S]*recoverLiveSessionInputQueues/)
})

test('replacement input drain ownership follows the session object across identity changes', () => {
  assert.match(daemon, /const sessionInputDrainOwners = new WeakSet\(\)/)
  const drain = /function scheduleSessionInputDrain\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(drain, /sessionInputDrainOwners\.has\(session\)/)
  assert.ok(drain.indexOf('sessionInputDrainOwners.add(session)') < drain.indexOf('setTimeout('),
    'drain ownership must be reserved synchronously before either native surface can schedule another consumer')
  assert.match(drain, /finally \{[\s\S]*sessionInputDrainOwners\.delete\(session\)/,
    'the stable session-object reservation must be released after success, failure, or a superseded timer')
})

test('the ordered startup drain is the sole consumer of maintenance input', () => {
  const resurrection = /async function resurrect\([\s\S]*?\n\}\nconst pendingBySid/.exec(daemon)?.[0] || ''
  assert.doesNotMatch(resurrection, /queued\.shift\(\)/,
    'Codex resume argv must not consume a queued prompt before lifecycle adoption')

  const piStream = /if \(url\.pathname === '\/pi\/stream'[\s\S]*?\n  \}/.exec(daemon)?.[0] || ''
  assert.doesNotMatch(piStream, /pendingBySid\.(?:get|set)/,
    'Pi stream attachment must not bypass the ordered startup drain')
  assert.match(piStream, /scheduleSessionInputDrain\(session, 'pi'/,
    'a reconnected Pi stream must ask the sole ordered drain to resume')
  assert.match(piStream, /session && !restarting\.has\(session\.id\)[\s\S]*scheduleSessionInputDrain/,
    'the superseded Pi stream must not drain input reserved for its replacement')
  assert.match(piStream, /completedSessionStartTmux\.get\(session\.id\) === tmux[\s\S]*scheduleSessionInputDrain/,
    'Pi stream attachment must not deliver input before SessionStart metadata is complete')

  const claudeStream = /if \(url\.pathname === '\/channel\/stream'\)[\s\S]*?\n  \}/.exec(daemon)?.[0] || ''
  assert.doesNotMatch(claudeStream, /pendingBySid\.(?:get|set)/,
    'Claude stream attachment must not bypass the ordered startup drain')
})

test('session-start metadata failure releases maintenance for an explicit retry', () => {
  const completion = /async function completeAuthoritativeSessionStart\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(completion, /const exactStartup = session\.id === sid/)
  assert.match(completion, /recoverSessionInputFence\(sid/)
  assert.match(completion, /expectedOwner: fenceOwner/)
})

test('provider maintenance blocks overlapping session mutations but leaves observation available', () => {
  assert.match(daemon, /const MAINTENANCE_SAFE_COMMANDS = new Set\(\['status', 'usage', 'terminal'\]\)/)
  assert.match(daemon, /updatingSessions\.has\(channelSession\.id\)[\s\S]{0,500}MAINTENANCE_SAFE_COMMANDS\.has\(name\)/)
})

test('every restart-causing settings path reserves maintenance before its first Slack wait', () => {
  for (const name of ['switchAccount', 'setFlags', 'setCodexSetting']) {
    const body = new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`).exec(daemon)?.[0] || ''
    assert.match(body, /restartSessionWithMutation\(/, `${name} must use exact-session restart fencing`)
  }
  const restart = /async function restartSessionWithMutation\([\s\S]*?\n\}\n\nasync function switchAccount/.exec(daemon)?.[0] || ''
  assert.ok(restart.indexOf('reserveSessionMaintenance(') < restart.indexOf('await post('),
    'restart maintenance must be reserved before the notice crosses an async boundary')
  assert.match(daemon, /updatingSessions\.has\(session\.id\)[\s\S]{0,500}ownerPromptPrivateContext/)
})

test('status dashboard binds the pre-await native session identity', () => {
  const status = /if \(name === 'status'\) \{[\s\S]*?\n  if \(name === 'health'\)/.exec(daemon)?.[0] || ''
  assert.match(status, /const statusSessionId = session\.id/)
  assert.match(status, /authoritativeManagementSession\(channel, statusSessionId\)/)
  assert.match(status, /postSessionDashboard\(channel, authoritative\)/)
  assert.doesNotMatch(status, /postSessionDashboard\(channel, session\)/)
})

test('App Home uses the sole Socket Mode coordinator and hides data from non-owners', () => {
  assert.match(daemon, /app_home_opened: handleAppHomeOpened/)
  assert.match(daemon, /if \(!USER \|\| userId !== USER\) return appHomeOverviewView\(\{ authorized: false \}\)/)
  assert.match(daemon, /web\.views\.publish\(\{ user_id: userId, view \}\)/)
})

test('App Home stale-load fallback uses defined fresh stats and never invents switch success', () => {
  assert.match(daemon, /function appHomeStats\(sessions = appHomeSessions\(\)\)/)
  assert.doesNotMatch(daemon, /stats: appHomeStats\(\), sessions: appHomeSessions\(\)/)
  assert.match(daemon, /Switch request processed\. The session channel contains the authoritative result\./)
  assert.doesNotMatch(daemon, /Provider-switch review started\. Continue from the session channel\./)
})

test('Claude menu settings are durable before the visible topic confirms them', () => {
  const settings = daemon.slice(
    daemon.indexOf("if (name === 'model' || name === 'effort')"),
    daemon.indexOf("if (name === 'stop')"),
  )
  assert.match(settings, /if \(name === 'model'\) session\.model = val/)
  assert.match(settings, /if \(name === 'effort'\) session\.effort = val/)
  assert.ok(settings.indexOf('saveStateNow(state)') < settings.indexOf('await updateTopic(session)'))
})
