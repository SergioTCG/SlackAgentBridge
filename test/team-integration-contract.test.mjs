import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const cli = fs.readFileSync(new URL('../scripts/sab-team.mjs', import.meta.url), 'utf8')
const teamModules = ['teams.mjs', 'team-auth.mjs', 'team-files.mjs', 'team-http.mjs']
  .map(file => fs.readFileSync(new URL(`../daemon/${file}`, import.meta.url), 'utf8'))
  .join('\n')

test('all provider-stable final paths complete the exact delegated team task', () => {
  for (const fn of ['finalizeTurn', 'finalizeCodexTurn', 'finalizePiTurn']) {
    const body = new RegExp(`async function ${fn}\\([\\s\\S]*?\\n}`, 'm').exec(daemon)?.[0] || ''
    assert.match(body, /finishTeamTaskForSession/, `${fn} lost team final correlation`)
  }
  assert.match(daemon, /await failTeamTaskForSession\(session, 'The worker session ended/)
  assert.match(daemon, /session\.teamActiveTaskId.*delegated team task in progress|teamActiveTaskId/s)
  assert.match(daemon, /codexFinalDeliveries\.has\(deliveryKey\)[\s\S]*codexFinalDeliveries\.set\(deliveryKey, delivery\)/)
})

test('team tools remain provider-neutral and cannot acquire Slack credentials or history', () => {
  assert.doesNotMatch(cli, /SLACK_(?:BOT|APP)_TOKEN|channel_id/)
  assert.doesNotMatch(teamModules, /conversations\.history|SLACK_(?:BOT|APP)_TOKEN/)
  assert.match(daemon, /validTeamCallerBinding/)
  assert.match(daemon, /beginCollaboratorTeamTurn/)
  assert.match(daemon, /beginOwnerTeamTurn/)
  assert.match(daemon, /handleTeamHttp\(req, res, url, teamService\)/)
})

test('team task injection is journal-first and uncertain claims are not replayed', () => {
  const claim = daemon.indexOf('claimTeamTaskForSession(state, task.id')
  const persist = daemon.indexOf('saveStateNow(state)', claim)
  const inject = daemon.indexOf('injectText(target, prompt', claim)
  assert.ok(claim > 0 && persist > claim && inject > persist)
  assert.match(daemon, /Delivery became uncertain[\s\S]*SAB did not retry it to avoid duplicate work/)
  assert.match(daemon, /startTeamReconciler\(\) \/\/ status adoption must fence workers/)
  const dispatchBody = /async function dispatchTeamTask\([\s\S]*?\n}/.exec(daemon)?.[0] || ''
  assert.doesNotMatch(dispatchBody, /markTeamTaskRunning/)
  assert.match(daemon, /teamTaskId && session\.teamActiveTaskId === teamTaskId[\s\S]*markTeamTaskRunning/)
})

test('team file relay journals an in-flight claim before every Slack upload', () => {
  for (const marker of ['task.fileDeliveryStatus = \'uploading\'', 'reply.fileDeliveryStatus = \'uploading\'']) {
    const claim = daemon.indexOf(marker)
    const persist = daemon.indexOf('saveStateNow(state)', claim)
    const upload = daemon.indexOf('await uploadTeamFiles(', claim)
    assert.ok(claim > 0 && persist > claim && upload > persist)
  }
  assert.match(daemon, /outcome became uncertain during daemon restart; SAB did not retry it to avoid duplicate delivery/g)
  assert.match(daemon, /teamTaskFileDeliveries\.get\(task\.id\)/)
  assert.match(daemon, /teamReplyDeliveries\.get\(reply\.id\)/)
})

test('team lifecycle recovery cannot rebind, lose finals, or fence a worker indefinitely', () => {
  assert.match(daemon, /session\.teamActiveTaskId[\s\S]*worker native session identity changed/)
  assert.doesNotMatch(daemon, /task\.targetSessionId = sid/)
  assert.doesNotMatch(daemon, /if \(!delivery\.suppress\) await finishTeamTaskForSession/)
  assert.match(daemon, /TEAM_RESTART_PROOF_GRACE_MS/)
  assert.match(daemon, /no live-turn proof returned/)
  assert.match(daemon, /exceeded its seven-day lifetime/)
  assert.match(daemon, /task\.status === 'dispatching' && task\.replies\?\.length[\s\S]*markTeamTaskRunning\(state, task\.id/)
  assert.match(daemon, /const workerProof = appended\.accepted[\s\S]*session\.teamActiveTaskId === task\.id[\s\S]*recordTeamWorkerProof\(session, task\)/)
  assert.match(daemon, /const startCodexStatus = recordTeamWorkerProof\(session, task\)[\s\S]*saveStateNow\(state\)[\s\S]*updateTeamTaskAudit\(task\)/)
  assert.match(daemon, /target\.teamActiveTaskId !== task\.id/)
  assert.match(daemon, /claimTeamTaskForSession\(state, task\.id, target[\s\S]*saveStateNow\(state\)[\s\S]*injectText\(target, prompt/)
  assert.match(daemon, /teamInputReservation/)
  assert.match(daemon, /InputError[\s\S]*clearTeamInputReservation\(session\)/)
  assert.match(daemon, /dispatchClaimedAt[\s\S]*discardQueuedTeamTaskPrompt\(target, task\.id\)/)
  assert.match(daemon, /abandonedInput = clearTeamInputReservation\(s\)/)
  assert.match(daemon, /markTeamTaskRunning\(state, teamTaskId\)[\s\S]*updateTeamTaskAudit\(task\)/)
})

test('hookless successful workers complete with warning and cannot race an authenticated final', () => {
  const start = daemon.indexOf('function startCodexPoller(')
  const end = daemon.indexOf('function startPiPoller(', start)
  const poller = daemon.slice(start, end)
  assert.match(poller, /await validProviderRootClaim[\s\S]*if \(p\.stopped\) return[\s\S]*finishTeamTaskWithWarningForSession/)
  assert.match(poller, /finishTeamTaskWithWarningForSession\(session, task\.status === 'running'/)
  assert.match(poller, /omitted its acknowledgement and completion hooks/)
  assert.match(daemon, /completed_with_warning/)
})

test('team task control is journal-first, exact-task scoped, and drain-aware', () => {
  assert.match(daemon, /appendCoordinatorTaskMessage\(state, task\.id[\s\S]*saveStateNow\(state\)[\s\S]*ensureCoordinatorTaskMessageDelivery/)
  assert.match(daemon, /target\.teamActiveTaskId !== task\.id[\s\S]*target_authority_lost/)
  assert.match(daemon, /providerDeliveryStatus = 'delivering'[\s\S]*saveStateNow\(state\)[\s\S]*injectCoordinatorTaskMessageOnce/)
  assert.match(daemon, /teamDispatchMode\(team\) === 'draining'/)
  assert.match(daemon, /tasksPageForChannel/)
})

test('restart re-adoption proves active turns but fails closed for already-idle historical tasks', () => {
  const readopt = daemon.slice(daemon.indexOf('async function readoptStatus('), daemon.indexOf('function isSystemPrompt('))
  const piReadopt = readopt.slice(readopt.indexOf("providerOf(s) === 'pi'"), readopt.indexOf("providerOf(s) === 'codex'"))
  assert.doesNotMatch(piReadopt, /teamTurnProof\.add|startPiPoller/)
  assert.match(piReadopt, /awaiting post-restart Pi activity proof/)
  const piStatus = daemon.slice(daemon.indexOf("provider === 'pi' && (ev === 'Status'"), daemon.indexOf("provider === 'pi' && ev === 'AgentStart'"))
  assert.match(piStatus, /session\.piTurnStartedAt && !piPollers\.has\(session\.id\)[\s\S]*startPiPoller\(session\)/)
  assert.match(piStatus, /session\.teamActiveTaskId[\s\S]*teamTurnProof\.add\(session\.id\)/)
  for (const provider of ['Codex', 'Claude Code', 'Pi']) {
    assert.match(daemon, new RegExp(`releaseIdleReadoptedTeamTaskIfStillIdle\\(s, idleTask, '${provider}'\\)`))
  }
  assert.match(daemon, /historical worker turn could not be proven complete and was released without replay/)
  assert.match(daemon, /let teamRecoveryComplete = false/)
  assert.match(daemon, /function scheduleTeamContinuation[\s\S]*if \(!teamRecoveryComplete\) return/)
  assert.match(daemon, /function startTeamReconciler[\s\S]*teamRecoveryComplete = true/)
  assert.ok(daemon.lastIndexOf('await readoptStatus()') < daemon.lastIndexOf('await recoverInterruptedTeamContinuations()'))
  assert.ok(daemon.lastIndexOf('await recoverInterruptedTeamContinuations()') < daemon.lastIndexOf('startTeamReconciler()'))
})

test('reviewed lifecycle races revalidate exact state at the last safe boundary', () => {
  const continuation = daemon.slice(
    daemon.indexOf('async function runTeamContinuation('),
    daemon.indexOf('function teamTaskStatusText('),
  )
  const claim = continuation.indexOf('const event = claimContinuation(team)')
  assert.ok(claim > 0)
  assert.ok(continuation.lastIndexOf("teamDispatchMode(team) === 'draining'", claim) > 0)

  const readopt = daemon.slice(daemon.indexOf('async function readoptStatus('), daemon.indexOf('function isSystemPrompt('))
  assert.match(readopt, /const idleTask = readoptedTeamTaskFingerprint\(s\)[\s\S]*releaseIdleReadoptedTeamTaskIfStillIdle/)
  assert.doesNotMatch(readopt, /releaseIdleReadoptedTeamTaskIfStillIdle\(s[\s\S]*clearTeamInputReservation\(s\)/)
  assert.match(daemon, /function releaseIdleReadoptedTeamTaskIfStillIdle[\s\S]*validProviderRootClaim[\s\S]*readoptedTeamTaskStillIdle[\s\S]*clearTeamTurn[\s\S]*clearTeamInputReservation/)

  const messageDelivery = daemon.slice(
    daemon.indexOf('function coordinatorTaskMessageTargetMatches('),
    daemon.indexOf('function ensureCoordinatorTaskMessageDelivery('),
  )
  assert.match(messageDelivery, /Object\.freeze\(\{[\s\S]*pid: target\.pid[\s\S]*tmux: target\.tmux/)
  assert.match(messageDelivery, /validProviderRootClaim\(expected\.pid, expected\.tmux, expected\.provider\)/)
  assert.match(messageDelivery, /await tmuxPaste\(expected\.tmux, prompt\)[\s\S]*coordinatorTaskMessageTargetMatches/)
  assert.doesNotMatch(messageDelivery, /injectText\(/)

  assert.match(messageDelivery, /!qforms\.has\(expected\.sid\) && !hasPendingPerm\(target\)/)

  const audit = daemon.slice(
    daemon.indexOf('async function performTeamTaskPayloadAuditUpdate('),
    daemon.indexOf('async function updateTeamTaskAudit('),
  )
  assert.match(audit, /if \(!ts\)[\s\S]*failure \|\|=/)
  assert.match(audit, /const instructionVersion[\s\S]*const snapshots[\s\S]*payloadAuditInstructionVersion = instructionVersion/)
  assert.match(audit, /teamPayloadAuditTails\.get\(task\.id\)[\s\S]*teamPayloadAuditTails\.set\(task\.id, operation\)/)

  const dispatch = daemon.slice(daemon.indexOf('async function dispatchTeamTask('), daemon.indexOf('async function reconcileTeamTasks('))
  assert.match(dispatch, /expectedInstructionVersion[\s\S]*expectedAuditInstructionVersion[\s\S]*claimTeamTaskForSession/)
  assert.match(dispatch, /task_revision_changed[\s\S]*task_audit_stale/)
  assert.match(daemon, /stopPoller\(target\)[\s\S]*clearTeamTurn\(target\)[\s\S]*no live-turn proof returned; SAB released it/)
})

test('an interrupted automatic coordinator wake is recovered without uncertain replay', () => {
  const recovery = daemon.slice(
    daemon.indexOf('async function recoverInterruptedTeamContinuations('),
    daemon.indexOf('async function finishTeamTaskForSession('),
  )
  assert.match(recovery, /liveInterruptedContinuationTurn[\s\S]*settleContinuation\(team, event\.id, \{ status: 'succeeded' \}\)/)
  assert.match(recovery, /status: 'needs_owner'/)
  assert.match(recovery, /did not replay/)
  assert.match(recovery, /matchingContinuationTurn[\s\S]*clearTeamTurn\(coordinator\)[\s\S]*clearTeamInputReservation\(coordinator\)/)
  assert.doesNotMatch(recovery, /deferContinuation|injectText|queueContinuation/)
})

test('automatic continuation recovers a hookless idle Codex coordinator without replaying backlog', () => {
  assert.match(daemon, /validProviderRootClaim\(expected\.pid, expected\.tmux, 'codex'\)/)
  assert.match(daemon, /observeIdleCodexCoordinator\(coordinator/)
  assert.match(daemon, /stopPoller\(coordinator\)[\s\S]*clearTeamTurn\(coordinator\)[\s\S]*clearTeamInputReservation\(coordinator\)/)
  assert.match(daemon, /coalesceContinuations\(team\)[\s\S]*claimContinuation\(team\)/)
  assert.match(daemon, /Team continuation is queued while the coordinator remains busy/)
})

test('hookless resumed Codex workers release stale owner fences before queued dispatch', () => {
  assert.match(daemon, /observeIdleCodexTurn\(session,/)
  assert.match(daemon, /allowDelegatedTask: true/)
  assert.match(daemon, /Codex delegated task fallback completed with warning \(Stop hook missing\)/)
  assert.match(daemon, /omitted its acknowledgement and completion hooks[\s\S]*did not replay it/)
  assert.match(daemon, /Codex idle fallback released owner turn \(Stop hook missing\)/)
  assert.match(daemon, /state\.sessions\?\.\[expected\.sid\] !== session[\s\S]*state\.channels\?\.\[session\.channel\] !== expected\.sid/)
  assert.match(daemon, /validProviderRootClaim\(expected\.pid, expected\.tmux, 'codex'\)/)
  assert.match(daemon, /clearTeamInputReservation\(session\)[\s\S]*saveStateNow\(state\)[\s\S]*reconcileTeamTasks\(\)/)
  assert.match(daemon, /teamActiveTaskId \|\| session\.teamInputReservation[\s\S]*pollers\.has\(session\.id\)[\s\S]*codexPollers\.has\(session\.id\)/)
})

test('automatic continuation renews exhausted dispatch authority before task side effects', () => {
  assert.match(daemon, /beginContinuationTeamTurn\(coordinator, \{ teamId: team\.id, eventId: event\.id \}/)
  const claim = daemon.indexOf('const renewed = claimContinuationDispatchAuthority(team, session)')
  const persist = daemon.indexOf('saveStateNow(state)', claim)
  const create = daemon.indexOf('result = createTeamTask(state', claim)
  assert.ok(claim > 0 && persist > claim && create > persist)
  assert.match(daemon, /consumeCoordinatorDispatch\(session, authority\)/)
})

test('completion, pruning, and retry side effects remain durable and idempotent', () => {
  assert.match(daemon, /completionDeliveryStatus = 'delivering'[\s\S]*client_msg_id: teamAuditClientId\(task, 'completion'\)/)
  assert.match(daemon, /ensureTeamCompletionDelivery\(task\)/)
  assert.match(daemon, /for \(const removed of result\.pruned \|\| \[\]\) removeTeamTaskFiles\(removed\)/)
  assert.match(daemon, /const priorReply = task\.replies\.find[\s\S]*session\.teamActiveTaskId !== task\.id/)
  assert.match(cli, /timeout: 10 \* 60_000/)
  assert.match(cli, /retry safely with --request-id/)
  assert.match(daemon, /!Object\.hasOwn\(task, 'completionDeliveryStatus'\)[\s\S]*completionDeliveryStatus = 'delivered'/)
  assert.doesNotMatch(daemon, /updateTeamTaskAudit\(task, \{ strict: true \}\)/)
  const persistPrune = daemon.indexOf('for (const removed of result.pruned || []) removeTeamTaskFiles(removed)')
  assert.ok(daemon.lastIndexOf('saveStateNow(state)', persistPrune) < persistPrune)
})

test('worker lifecycle transitions and coordinator wakes share one atomic state write', () => {
  const stageStart = daemon.indexOf('function stageTeamContinuation(')
  const persistStart = daemon.indexOf('function persistTeamLifecycle(', stageStart)
  const nextFunction = daemon.indexOf('function teamContinuationBusyReason(', persistStart)
  const stage = daemon.slice(stageStart, persistStart)
  const persist = daemon.slice(persistStart, nextFunction)
  assert.match(stage, /queueContinuation\(team/)
  assert.match(persist, /stageTeamContinuation\(task[\s\S]*saveStateNow\(state\)[\s\S]*scheduleTeamContinuation/)

  const completion = /async function finishTeamTaskForSession\([\s\S]*?\n}/.exec(daemon)?.[0] || ''
  assert.match(completion, /completeTeamTask\(state[\s\S]*persistTeamLifecycle\(task\)[\s\S]*ensureTeamCompletionDelivery/)

  const reply = /async reply\(caller, request\) \{[\s\S]*?\n  },\n  async cancel/.exec(daemon)?.[0] || ''
  assert.match(reply, /appendTeamTaskReply\(state[\s\S]*stageTeamContinuation\(task[\s\S]*saveStateNow\(state\)[\s\S]*scheduleTeamContinuation/)
})

test('nested provider utilities are not registered as SAB sessions', () => {
  assert.match(daemon, /validProviderRootClaim/)
  assert.match(daemon, /rejected nested provider claim/)
})
