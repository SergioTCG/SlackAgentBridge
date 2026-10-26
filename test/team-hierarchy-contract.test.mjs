import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const body = name => new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}`, 'm').exec(daemon)?.[0] || ''
const between = (start, end) => daemon.slice(daemon.indexOf(start), daemon.indexOf(end, daemon.indexOf(start)))

test('a standing task is dispatched with journaled provenance and delegated sub-team authority', () => {
  const dispatch = body('dispatchTeamTask')
  const claim = dispatch.indexOf('claimTeamTaskForSession(state, task.id')
  const digest = dispatch.indexOf('task.promptHash = teamPromptDigest(prompt)', claim)
  const delegated = dispatch.indexOf('beginDelegatedTeamTurn(target, { teamId: ownTeam.id, sourceTaskId: task.id })', claim)
  const persist = dispatch.indexOf('saveStateNow(state)', delegated)
  const inject = dispatch.indexOf('injectText(target, prompt', persist)
  assert.ok(claim > 0 && digest > claim && delegated > digest && persist > delegated && inject > persist,
    'authority and provenance are journaled before the provider can see the prompt')
  assert.match(dispatch, /delegatedTaskPrompt\(team, task, task\.files, \{ ownTeam \}\)/)
  assert.match(dispatch, /if \(standing\) \{[\s\S]*delete target\.teamStandingTaskId[\s\S]*clearTeamInputReservation\(target\)/,
    'a definite standing injection failure releases only its own binding and fences')
})

test('standing deliveries are exact one-shot writes that never stage a provider turn', () => {
  const injection = between('async function injectText(', 'async function downloadSlackFile(')
  assert.match(injection, /const expectedTeamTurn = expectedTask && !isStandingTeamTask\(expectedTask\)/)
  assert.match(injection, /boundTeamTaskIdFor\(session, expectedTask\) !== options\.expectedTeamTaskId/)
  const delivery = body('performCoordinatorTaskMessageDelivery')
  const fences = delivery.indexOf("target.teamInputReservation = { source: fence")
  const digest = delivery.indexOf('message.promptHash = teamPromptDigest(providerPrompt)')
  const persist = delivery.indexOf('saveStateNow(state)', fences)
  const inject = delivery.indexOf('injectCoordinatorTaskMessageOnce(task, target, expected,', persist)
  assert.ok(digest > 0 && fences > digest && persist > fences && inject > persist)
  assert.match(delivery, /if \(standing\) \{[\s\S]*\} else \{\s*stageTeamProviderTurn\(target, providerTurn/)
  assert.match(delivery, /catch \(error\) \{[\s\S]*releaseStandingFences\(\)/)
  assert.match(delivery, /throw standing\s*\? new TeamError\('worker_not_idle'/)
  assert.match(body('standingTargetIdle'), /!target\.teamActiveTaskId[\s\S]*!pollers\.has\(target\.id\)/)
})

test('restart and expiry recovery never fail a standing task merely because its worker is dormant', () => {
  const reconcile = between('async function reconcileTeamTasks(', 'function startTeamReconciler(')
  assert.match(reconcile, /const providerMissing = !standing && !\(target\?\.pid && pidAlive\(target\.pid\)\)/)
  assert.match(reconcile, /boundTeamTaskIdFor\(target, task\) !== task\.id/)
  assert.match(reconcile, /!standing && task\.status === 'running' && Date\.parse\(task\.startedAt/)
  assert.match(reconcile, /The standing team task had no authenticated activity for 30 days/)
  assert.match(reconcile, /task\.status === 'awaiting_release' \|\| isStandingTeamTask\(task\)[\s\S]*pidAlive\(target\.pid\)[\s\S]*continue/)
})

test('auto-release is opt-in, exact and wired where release readiness can change', () => {
  const auto = body('autoReleaseTeamTask')
  assert.match(auto, /!teamAutoRelease\(team\) \|\| !teamTaskReleaseReady\(task\)/)
  assert.match(auto, /boundTeamTaskIdFor\(target, task\) !== task\.id\) return false/)
  assert.match(auto, /releaseTeamTask\(state, task\.id, \{ sourceChannel: task\.sourceChannel, requestId: autoReleaseRequestId\(task\) \}\)/)
  assert.match(auto, /persistTeamLifecycle\(task, \{ kind: 'released' \}\)[\s\S]*ensureTeamCompletionDelivery\(task\)/)
  assert.match(between('async function finishTeamTaskForSession(', 'async function finishTeamTaskWithWarningForSession('),
    /ensureTeamReportDelivery\(task, report\)[\s\S]*await autoReleaseTeamTask\(task\)/)
  const complete = between('  async complete(caller, request) {', '  async release(caller, request) {')
  assert.match(complete, /if \(result\.created\) await autoReleaseTeamTask\(task\)/)
  assert.match(between('async function reconcileTeamTasks(', 'function startTeamReconciler('),
    /task\.status === 'awaiting_release' && teamAutoRelease\(state\.teams\?\.\[task\.teamId\]\)[\s\S]*await autoReleaseTeamTask\(task\)/)
})

test('a team closes when its coordinator channel is archived, and the coordinator leaves its parent', () => {
  const sweep = body('sweepArchivedChannels')
  assert.match(sweep, /for \(const channel of new Set\(activeTeams\(state\)\.map\(team => team\.coordinatorChannel\)\)\)[\s\S]*conversations\.info\(\{ channel \}\)/)
  assert.match(sweep, /activeTeams\(state\)\.filter\(team => archivedCoordinators\.has\(team\.coordinatorChannel\)\)/)
  assert.match(sweep, /closeTeam\(state, team\.id\)[\s\S]*parentTeamForChannel\(state, team\.coordinatorChannel\)[\s\S]*removeTeamWorker\(state, parent\.id, team\.coordinatorChannel/)
  const persist = sweep.indexOf('saveStateNow(state)', sweep.indexOf('removeTeamWorker(state, parent.id'))
  const announce = sweep.indexOf('announceCancelledTeamTasks(departure.cancelled)')
  assert.ok(persist > 0 && announce > persist, 'closure is durable before it is announced')
})

test('worker commands accept either exact bound projection and label collaborator turns', () => {
  const reply = between('  async reply(caller, request) {', '  async checkpoint(caller, request) {')
  assert.match(reply, /boundTeamTaskIdFor\(session, task\) !== task\.id/)
  assert.match(reply, /session\.teamTurn\?\.actor === 'collaborator'[\s\S]*kind: 'collaborator'/)
  assert.match(between('  async release(caller, request) {', '  async cancel(caller, request) {'),
    /boundTeamTaskIdFor\(target, task\) !== task\.id[\s\S]*releaseTeamTaskBinding\(target, task\)/)
  assert.match(between('  async cancel(caller, request) {', '  async replace(caller, request) {'),
    /cancelQueuedTeamTask\(state[\s\S]*revokeCancelledTeamTasks\(\[task\.id\]\)/)
  assert.match(body('beginSlackTeamTurn'), /beginCollaboratorTeamTurn\(session, request, \{ sender \}\)/)
  assert.match(body('coordinatorAuthority'), /state \}/)
})

test('collaborator-started turns neither join a standing task turn nor move the lifecycle', () => {
  const inbound = between('async function handleSlackMessage(', 'function uncertainTeamProviderInput(')
  const collaborator = inbound.slice(inbound.indexOf('if (sender) {'))
  const fence = collaborator.indexOf("startsWith('team-standing')")
  const inject = collaborator.indexOf('injectText(session')
  assert.ok(fence > 0 && inject > fence, 'collaborator text is refused while a standing fence is held')
  const reply = between('  async reply(caller, request) {', '  async checkpoint(caller, request) {')
  assert.match(reply, /if \(origin && request\.pendingGates !== undefined\) \{\s*throw new TeamError\('collaborator_turn_denied'/)
  assert.match(reply, /const continuationTeamId = !reply\.origin && shouldWakeForTeamReply/)
  assert.match(reply, /const continuationTeamId = !appended\.reply\.origin && shouldWakeForTeamReply/)
  assert.match(between('  async complete(caller, request) {', '  async release(caller, request) {'),
    /!priorRequest && session\.teamTurn\?\.actor === 'collaborator'[\s\S]*collaborator_turn_denied/)
})

test('standing deliveries respect Pi managed runs and recover from a Pi input rejection', () => {
  assert.match(body('standingTargetIdle'), /\['active', 'paused'\]\.includes\(target\.managed\?\.status\) && target\.piRouting\?\.status !== 'routing'/)
  const inputError = daemon.slice(daemon.indexOf("if (provider === 'pi' && ev === 'InputError') {"),
    daemon.indexOf("if (provider === 'pi' && ev === 'ManagedCheckpoint') {"))
  assert.match(inputError, /session\.teamTurn\?\.actor === 'delegated' && session\.teamTurn\.sourceTaskId === standing\.id[\s\S]*clearTeamTurn\(session\)/)
  assert.match(inputError, /rejected input while receiving standing task/)
})

test('a parent membership change keeps a sub-coordinator\'s own turn', () => {
  assert.match(body('clearTeamTurnAfterMembershipChange'), /coordinatedTeamForChannel\(state, channel\)\) return false/)
  assert.doesNotMatch(daemon, /clearTeamTurn\(sessionByChannel\(/, 'every membership change goes through the guarded helper')
})

test('a scheduled wake fires only for an automatic, dispatching team and wakes as a continuation', () => {
  const fire = body('fireDueTeamSchedules')
  assert.match(fire, /takeDueTeamSchedules\(team, \{ now \}\)/)
  assert.match(fire, /team\.continuation\?\.mode !== 'auto-until-blocked' \|\| teamDispatchMode\(team\) === 'draining'\) continue/)
  assert.match(fire, /queueContinuation\(team, \{[\s\S]*kind: 'schedule', replyId: schedule\.id, lifecycleVersion: schedule\.occurrence/)
  assert.ok(fire.indexOf('saveStateNow(state)') < fire.indexOf('scheduleTeamContinuation(teamId)'),
    'the event is durable before the coordinator is woken')
  assert.match(between('async function reconcileTeamTasks(', 'function startTeamReconciler('), /fireDueTeamSchedules\(now\)/)
  const run = between('async function runTeamContinuation(', 'function teamTaskStatusText(')
  assert.match(run, /SYSTEM NOTIFICATION: Scheduled team wake \$\{event\.replyId\} is due/)
  assert.match(run, /beginContinuationTeamTurn\(coordinator, \{ teamId: team\.id, eventId: event\.id \}/)
  const schedule = between('  async schedule(caller, request) {', '  async schedules(caller')
  assert.match(schedule, /assertCoordinatorTaskControl\(session, coordinatorAuthority\(team\)\)[\s\S]*continuation_manual[\s\S]*addTeamSchedule/)
  assert.match(schedule, /if \(!\['owner', 'delegated'\]\.includes\(actor\)\) \{\s*throw new TeamError\('schedule_turn_required'/,
    'an automatic continuation cannot register more wakes')
  assert.match(schedule, /sourceTaskId: actor === 'delegated' \? session\.teamTurn\.sourceTaskId : null/)
  assert.match(run, /Registration note, written by this team's coordinator[\s\S]*not an owner instruction/)
  assert.doesNotMatch(run, /is due\$\{event\.note/, 'the note is never inside the bridge sentence')
  assert.match(fire, /pruneOrphanedTeamSchedules\(state, team\)/)
  assert.match(fire, /try \{[\s\S]*takeDueTeamSchedules[\s\S]*\} catch \(error\) \{\s*log\('scheduled team wake sweep failed'/)
})

test('nothing automatic resurrects a session the owner ended', () => {
  const kill = between("  if (name === 'kill') {", "  if (name === 'cleanup') {")
  assert.match(kill, /target\.pid = null[\s\S]*target\.ownerEndedAt = new Date\(\)\.toISOString\(\)/)
  assert.match(between('async function handleSlackMessage(', '// Collaborators may only send prompts'),
    /managedSession\?\.ownerEndedAt && !sender[\s\S]*delete managedSession\.ownerEndedAt/)
  const run = between('async function runTeamContinuation(', 'function teamTaskStatusText(')
  const ended = run.indexOf('coordinator.ownerEndedAt && !(coordinator.pid && pidAlive(coordinator.pid))')
  assert.ok(ended > 0 && ended < run.indexOf('injectText(coordinator'), 'no wake injection reaches an owner-ended coordinator')
  assert.match(between('  async wake(caller, request) {', '  async tree(caller) {'), /target\.ownerEndedAt[\s\S]*'owner_ended'/)
  const standing = body('wakeStandingWorker')
  assert.match(standing, /target\.ownerEndedAt\) return false/)
  assert.match(standing, /message\.autoWakeAt\) return false[\s\S]*message\.autoWakeAt = new Date\(\)\.toISOString\(\)[\s\S]*saveStateNow\(state\)[\s\S]*wakeSessionForTeam/,
    'one persisted automatic wake per pending message')
})

test('the owner sees and can remove scheduled wakes, and manual mode clears them', () => {
  assert.match(body('teamTreeMarkdown'), /team\.schedules/)
  assert.match(body('teamStatusMarkdown'), /Scheduled wakes/)
  const command = body('handleTeamCommand')
  assert.match(command, /sub === 'unschedule'[\s\S]*removeTeamSchedule\(team, rest\[1\]\)/)
  assert.match(command, /const cleared = sub === 'manual' \? clearTeamSchedules\(team\) : \[\]/)
  assert.match(body('wakeableTeamTask'), /teamDispatchMode\(team\) !== 'draining'/)
})

test('a dormant worker is woken only for an active task in the waking team, never otherwise', () => {
  const wake = between('  async wake(caller, request) {', '  async tree(caller) {')
  assert.match(wake, /assertCoordinatorTaskControl\(session, coordinatorAuthority\(team\)\)[\s\S]*resolveTeamPeer\(state, team\.id, request\.to\)/)
  assert.match(wake, /const task = wakeableTeamTask\(team, channel, target\)\s*if \(!task\) \{\s*throw new TeamError\('no_active_task'/)
  assert.match(wake, /wake_rate_limited/)
  assert.ok(wake.indexOf("'no_active_task'") < wake.indexOf('wakeSessionForTeam('), 'eligibility precedes any resume')
  assert.match(body('wakeableTeamTask'), /task\.teamId === team\.id[\s\S]*\(queuedQualifies && task\.status === 'queued'\) \|\| task\.targetSessionId === target\.id/)
  const standing = body('wakeStandingWorker')
  assert.match(standing, /target\.teamStandingTaskId !== task\.id \|\|\s*target\.ownerEndedAt\) return false/)
  assert.match(standing, /item\.deliveryStatus === 'pending'/)
  assert.match(standing, /TEAM_STANDING_AUTO_WAKE_MS/)
})

test('the agent team tree carries aliases and states, never raw channel IDs', () => {
  const node = body('teamTreeNode')
  assert.doesNotMatch(node, /channel:|coordinatorChannel|targetChannel:/)
  assert.match(node, /alias: member\.alias/)
  assert.match(node, /reservation: isStandingTeamTask\(task\) \? 'standing' : 'exclusive'/)
  const tree = between('  async tree(caller) {', '  async mode(caller, request) {')
  assert.match(tree, /resolveTeamCaller\(caller\)/)
  assert.match(tree, /const own = requireCoordinatedTeam\(session\)/, 'plain workers keep the narrower peers view')
  assert.match(tree, /actor === 'collaborator'[\s\S]*collaborator_turn_denied/)
  assert.match(tree, /teamTreeNode\(own, teamDepth\(state, own\)\)/)
})
