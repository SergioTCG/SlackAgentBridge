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
