import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const cli = fs.readFileSync(new URL('../scripts/sab-team.mjs', import.meta.url), 'utf8')
const claudeHook = fs.readFileSync(new URL('../hooks/hook.sh', import.meta.url), 'utf8')
const teamModules = ['teams.mjs', 'team-auth.mjs', 'team-files.mjs', 'team-http.mjs']
  .map(file => fs.readFileSync(new URL(`../daemon/${file}`, import.meta.url), 'utf8'))
  .join('\n')

test('all provider-stable final paths report the exact delegated team task', () => {
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
  assert.match(daemon, /providerInputUncertain[\s\S]*refusing retry/)
  const injection = daemon.slice(daemon.indexOf('async function injectText('), daemon.indexOf('async function downloadSlackFile('))
  const tmuxWrite = injection.indexOf('await tmuxPaste')
  const transportTry = injection.lastIndexOf('try {', tmuxWrite)
  const transportCatchEnd = injection.indexOf('// Only a provably failed tmux write', tmuxWrite)
  assert.doesNotMatch(injection.slice(transportTry, transportCatchEnd), /acceptExpectedTeamTurn/,
    'post-write lifecycle persistence must not be caught by the transport fallback')
  assert.match(injection.slice(transportTry, transportCatchEnd),
    /expectedTeamTurn[\s\S]*uncertainTeamProviderInput/,
    'an exact delegated tmux rejection is uncertain and must not reach another transport')
  const acceptedBoundary = injection.indexOf('if (tmuxAccepted)', tmuxWrite)
  const acceptancePersist = injection.indexOf('acceptExpectedTeamTurn()', acceptedBoundary)
  assert.ok(tmuxWrite > 0 && acceptedBoundary > tmuxWrite && acceptancePersist > acceptedBoundary)
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

test('hookless successful workers report with warning and cannot race an authenticated final', () => {
  const start = daemon.indexOf('function startCodexPoller(')
  const end = daemon.indexOf('function startPiPoller(', start)
  const poller = daemon.slice(start, end)
  assert.match(poller, /await validProviderRootClaim[\s\S]*if \(p\.stopped\) return[\s\S]*finishTeamTaskWithWarningForSession/)
  assert.match(poller, /finishTeamTaskWithWarningForSession\(session, task\.status === 'running'/)
  assert.match(poller, /omitted its acknowledgement and completion hooks/)
  assert.match(poller, /warning-bearing turn report[\s\S]*task remains reserved until explicit release/)
  assert.doesNotMatch(poller, /SAB completed the task with a warning/)
  assert.match(daemon, /reportTeamTaskTurn/)
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
  const piReady = daemon.slice(daemon.indexOf("provider === 'pi' && ev === 'StreamReady'"), daemon.indexOf("provider === 'pi' && ev === 'InputError'"))
  assert.match(piReady, /body\.idle[\s\S]*trackedProviderTurn: 'pi'/)
  assert.doesNotMatch(piReady, /delete session\.piTurnStartedAt/)
  assert.match(fs.readFileSync(new URL('../pi/sab-extension.ts', import.meta.url), 'utf8'),
    /event: "StreamReady", idle: ctx\.isIdle\(\)/)
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
  assert.match(messageDelivery, /forgetInjected\(expected\.sid, prompt\)[\s\S]*knownUndeliveredTeamMessage/)
  assert.match(daemon, /teamMessageFailureDisposition\(\{ providerAttempted, error \}\)[\s\S]*failure\.retryable/)

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
  const tracked = daemon.slice(
    daemon.indexOf('function providerTurnTracked('),
    daemon.indexOf('async function liveInterruptedContinuationTurn('),
  )
  assert.match(tracked, /pollers\.has\(session\.id\)/)
  assert.match(tracked, /codexPollers\.has\(session\.id\)/)
  assert.match(tracked, /piPollers\.has\(session\.id\)/)
  assert.doesNotMatch(tracked, /codexTurnStartedAt|piTurnStartedAt/,
    'persisted timestamps are not post-restart proof that a coordinator turn is live')
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
  assert.match(daemon, /function teamTargetBusyReasons[\s\S]*session\.teamActiveTaskId[\s\S]*teamInputReservation[\s\S]*codexPollers\.has\(session\.id\)/)
  assert.match(daemon, /reconcileTeamSessionBindings\(state/)
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
  assert.match(completion, /reportTeamTaskTurn\(state[\s\S]*persistTeamLifecycle\(task\)[\s\S]*ensureTeamReportDelivery/)

  const reply = /async reply\(caller, request\) \{[\s\S]*?\n  },\n  async checkpoint/.exec(daemon)?.[0] || ''
  assert.match(reply, /appendTeamTaskReply[\s\S]*stageTeamContinuation\(task[\s\S]*saveStateNow\(state\)[\s\S]*scheduleTeamContinuation/)
})

test('provider turn reporting preserves task and process ownership until explicit release', () => {
  const completion = /async function finishTeamTaskForSession\([\s\S]*?\n}/.exec(daemon)?.[0] || ''
  assert.match(completion, /reportTeamTaskTurn/)
  assert.match(completion, /expectedTeamTaskTurn[\s\S]*teamTaskProviderWorkGeneration\(task\)[\s\S]*ignored stale team task final/)
  assert.match(completion, /const taskId = expectedTeamTaskTurn\?\.taskId/)
  assert.doesNotMatch(completion, /expectedTeamTaskTurn\?\.taskId \|\| session\.teamActiveTaskId/)
  assert.match(completion, /reported\.stale[\s\S]*!reported\.created/)
  assert.match(completion, /if \(isTerminalTeamTask\(task\)\) \{[\s\S]*delete session\.teamActiveTaskId/)
  assert.doesNotMatch(completion, /process\.kill|tmuxKill/)
  assert.match(daemon, /task\.status === 'awaiting_release'[\s\S]*Preserve[\s\S]*task reservation/)
  assert.match(daemon, /providerMissing && task\.status !== 'awaiting_release'/)
  assert.match(daemon, /SessionEnd[\s\S]*failTeamTaskForSession\(session,[\s\S]*preserveReported: true/)
  assert.match(daemon, /preserveReported && existingTask\?\.status === 'awaiting_release'/)
  assert.match(daemon, /releaseTeamTask\(state[\s\S]*delete target\.teamActiveTaskId[\s\S]*persistTeamLifecycle\(task, \{ enqueueContinuation: false \}\)/)
  assert.match(daemon, /beginCoordinatorTaskMessageDelivery\(state[\s\S]*saveStateNow\(state\)[\s\S]*injectCoordinatorTaskMessageOnce/)
  assert.match(daemon, /injectCoordinatorTaskMessageOnce[\s\S]*completeCoordinatorTaskMessageDelivery\(state[\s\S]*saveStateNow\(state\)/)
  assert.match(daemon, /const teamTaskTurn = currentTeamTaskProviderTurn\(session, body\)[\s\S]*completePrivateTurn[\s\S]*finalizeTurn\(session, \{ teamTaskTurn \}\)/)
  assert.match(daemon, /stageTeamProviderTurn\(target,[\s\S]*saveStateNow\(state\)[\s\S]*injectCoordinatorTaskMessageOnce/)
  assert.match(daemon, /injectCoordinatorTaskMessageOnce[\s\S]*activateTeamProviderTurn\(target[\s\S]*ensureCodexTurnStarted\(target/)
  assert.match(daemon, /currentTeamTaskProviderTurn\(session, body\)/)
  const promptHook = daemon.slice(
    daemon.indexOf("if (ev === 'UserPromptSubmit')"),
    daemon.indexOf("if (ev === 'PreToolUse')"),
  )
  const submittedTurnSnapshot = promptHook.indexOf('const submittedTeamTaskTurn =')
  const auditAwait = promptHook.indexOf('await updateTeamTaskAudit(task)')
  assert.ok(submittedTurnSnapshot >= 0 && auditAwait > submittedTurnSnapshot,
    'prompt generation must be captured before an audit await can admit a follow-up')
  assert.match(promptHook, /acknowledgedTurn[\s\S]*submittedTeamTaskTurn/)
  assert.match(promptHook, /providerPromptTurnMarker\(p\)[\s\S]*pendingTeamProviderTurn/)
  assert.match(claudeHook, /UserPromptSubmit[\s\S]*observed_at[\s\S]*--argjson observed_at/)
  assert.match(daemon, /failure\.retryable[\s\S]*deferCoordinatorTaskMessageDelivery\(state/)
  const claudeFinal = /async function finalizeTurn\([\s\S]*?\n}/.exec(daemon)?.[0] || ''
  assert.match(claudeFinal, /claudeFinalDeliveries\.has\(deliveryKey\)[\s\S]*stopPoller\(session\)[\s\S]*waitTranscriptSettle/)
  assert.match(claudeFinal,
    /teamTaskTurnOwnsCurrentLifecycle[\s\S]*stopPoller[\s\S]*waitTranscriptSettle[\s\S]*teamTaskTurnOwnsCurrentLifecycle[\s\S]*readNewAssistantText/)
  assert.ok(claudeFinal.indexOf('teamTaskTurnOwnsCurrentLifecycle') < claudeFinal.indexOf('readNewAssistantText'),
    'a stale Claude final must be rejected before transcript consumption')
  const completionDeclaration = /async complete\(caller, request\) \{[\s\S]*?\n  },\n  async release/.exec(daemon)?.[0] || ''
  assert.match(completionDeclaration, /task\.status === 'awaiting_release'[\s\S]*stageTeamContinuation\(task[\s\S]*saveStateNow\(state\)[\s\S]*scheduleTeamContinuation/)
  assert.ok(completionDeclaration.indexOf('priorRequest') < completionDeclaration.indexOf('session.teamActiveTaskId !== task.id'),
    'an exact completion retry must be recovered before the released session binding is rejected')
  assert.match(completionDeclaration,
    /requestTeamTaskCompletion\(state[\s\S]*recordTeamWorkerProof\(session, task\)[\s\S]*saveStateNow\(state\)/)

  const continuation = /async continue\(caller, request\) \{[\s\S]*?\n  },\n  async reply/.exec(daemon)?.[0] || ''
  assert.match(continuation, /to: previous\.targetChannel/)
  assert.doesNotMatch(continuation, /to: previous\.targetAlias/)
  assert.ok(continuation.indexOf('teamTaskForRequest') < continuation.indexOf('teamTask(state, request.taskId)'),
    'an accepted continuation retry must resolve before its bounded parent history is loaded')
})

test('coordinator wait returns actionable release state and dormant message retries stay quiet', () => {
  assert.match(cli, /\['awaiting_release', 'completed', 'completed_with_warning', 'failed', 'cancelled'\]\.includes\(task\.status\)/)
  const reconciliation = daemon.slice(
    daemon.indexOf('async function reconcileTeamTasks('),
    daemon.indexOf('function startTeamReconciler('),
  )
  assert.match(reconciliation,
    /task\.status === 'awaiting_release'[\s\S]*pidAlive\(target\.pid\)[\s\S]*tmuxAlive\(target\.tmux\)[\s\S]*continue/)
  assert.match(reconciliation,
    /\['worker_dormant', 'task_message_predecessor_pending'\]\.includes\(error\?\.code\)[\s\S]*return/)
})

test('stale Pi finals cannot clear a newer provider turn', () => {
  const piFinal = /async function finalizePiTurn\([\s\S]*?\n}/.exec(daemon)?.[0] || ''
  const firstGuard = piFinal.indexOf('if (!stillCurrent())')
  const stop = piFinal.indexOf('stopPoller(session)')
  const post = piFinal.indexOf('await postProviderOutput')
  const secondGuard = piFinal.indexOf("if (!stillCurrent({ afterStop: true }))")
  const finish = piFinal.indexOf('await finishTeamTaskForSession')
  const usage = piFinal.indexOf('recordPiUsage(session, body)')
  assert.ok(firstGuard >= 0 && stop > firstGuard && post > stop && secondGuard > post &&
    finish > secondGuard && usage > finish)
})

test('coordinator follow-ups serialize and coordinator release does not mint worker authority', () => {
  const delivery = daemon.slice(
    daemon.indexOf('function ensureCoordinatorTaskMessageDelivery('),
    daemon.indexOf('async function resolveTeamCaller('),
  )
  assert.match(delivery, /teamMessageDeliveryTails\.get\(task\.id\)/)
  assert.match(delivery, /await prior\.catch/)
  assert.match(delivery, /undeliveredTeamMessagePredecessor\(task, message\)/)
  assert.ok(delivery.indexOf('await prior.catch') < delivery.indexOf('performCoordinatorTaskMessageDelivery(task, message)'))

  const release = /async release\(caller, request\) \{[\s\S]*?\n  },\n  async cancel/.exec(daemon)?.[0] || ''
  assert.match(release, /persistTeamLifecycle\(task, \{ enqueueContinuation: false \}\)/)
  assert.doesNotMatch(release, /stageTeamContinuation/)
  assert.match(daemon, /function refreshTeamTaskPoller[\s\S]*claude\.teamTaskTurn = snapshot[\s\S]*codex\.teamTaskTurn = snapshot/)
  assert.match(daemon, /injectCoordinatorTaskMessageOnce[\s\S]*refreshTeamTaskPoller\(target, activeTurn\)/)
})

test('reported-worker dormancy is re-evaluated after Slack message audit delivery', () => {
  const delivery = daemon.slice(
    daemon.indexOf('async function performCoordinatorTaskMessageDelivery('),
    daemon.indexOf('function ensureCoordinatorTaskMessageDelivery('),
  )
  const targetPost = delivery.indexOf('message.targetSlackTs = posted?.ts || null')
  const validation = delivery.indexOf('await validateCoordinatorTaskMessageTarget', targetPost)
  const durableRecheck = delivery.indexOf('durableAwaitingTarget()', validation)
  assert.ok(targetPost > 0 && validation > targetPost && durableRecheck > validation)
  assert.match(delivery, /durableAwaitingTarget\(\)[\s\S]*worker_dormant/)
  assert.match(delivery, /durableAwaitingTarget\(\)[\s\S]*knownUndeliveredTeamMessage/)
})

test('reported dormant workers can be resumed and deferred follow-ups remain visible and proved', () => {
  const inbound = /async function handleSlackMessage\([\s\S]*?\/\/ Collaborators may only send prompts/.exec(daemon)?.[0] || ''
  assert.match(inbound, /managedSession\?\.teamActiveTaskId[\s\S]*activeTeamTask\?\.status === 'awaiting_release'[\s\S]*!sender[\s\S]*pidAlive[\s\S]*resurrect\(managedSession\)/)

  const delivery = /async function performCoordinatorTaskMessageDelivery\([\s\S]*?\n}/.exec(daemon)?.[0] || ''
  const sourceAudit = delivery.indexOf("message.sourceSlackTs")
  const targetAudit = delivery.indexOf("message.targetSlackTs")
  const dormant = delivery.indexOf("worker_dormant")
  const injection = delivery.indexOf("injectCoordinatorTaskMessageOnce")
  const proof = delivery.indexOf("recordTeamWorkerProof")
  assert.ok(sourceAudit >= 0 && targetAudit > sourceAudit && dormant > targetAudit,
    'both Slack audit copies must precede dormant provider deferral')
  assert.ok(injection >= 0 && proof > injection,
    'an exactly delivered follow-up must establish fresh live-turn proof')

  assert.match(teamModules, /function delegatedTaskPrompt[\s\S]*teamTaskCompletionPolicy\(task\)/)
  assert.match(teamModules,
    /beginCoordinatorTaskMessageDelivery[\s\S]*message\.resumesTask = task\.status === 'awaiting_release'[\s\S]*if \(message\.resumesTask\)[\s\S]*invalidateCompletionRequest/)
})

test('team mutation responses carry the journaled receipt from the original authority check', () => {
  assert.match(daemon, /function acceptedTeamMutation\([\s\S]*teamMutationForRequest/)
  assert.match(daemon, /mutation: acceptedTeamMutation\(session, result\.task, request\.requestId\)/)
  assert.match(cli, /verify acceptance with sab team mutation --request-id/)
  assert.match(teamModules, /result\?\.mutation \|\| await service\.mutation/)
})

test('nested provider utilities are not registered as SAB sessions', () => {
  assert.match(daemon, /validProviderRootClaim/)
  assert.match(daemon, /rejected nested provider claim/)
})
