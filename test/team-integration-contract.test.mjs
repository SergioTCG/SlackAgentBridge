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
  const claim = daemon.indexOf('claimTeamTask(state, task.id')
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
  assert.match(daemon, /teamInputReservation/)
  assert.match(daemon, /InputError[\s\S]*clearTeamInputReservation\(session\)/)
  assert.match(daemon, /dispatchClaimedAt[\s\S]*discardQueuedTeamTaskPrompt\(target, task\.id\)/)
  assert.match(daemon, /abandonedInput = clearTeamInputReservation\(s\)/)
  assert.match(daemon, /markTeamTaskRunning\(state, teamTaskId\)[\s\S]*updateTeamTaskAudit\(task\)/)
})

test('automatic continuation recovers a hookless idle Codex coordinator without replaying backlog', () => {
  assert.match(daemon, /validProviderRootClaim\(expected\.pid, expected\.tmux, 'codex'\)/)
  assert.match(daemon, /observeIdleCodexCoordinator\(coordinator/)
  assert.match(daemon, /stopPoller\(coordinator\)[\s\S]*clearTeamTurn\(coordinator\)[\s\S]*clearTeamInputReservation\(coordinator\)/)
  assert.match(daemon, /coalesceContinuations\(team\)[\s\S]*claimContinuation\(team\)/)
  assert.match(daemon, /Team continuation is queued while the coordinator remains busy/)
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

test('nested provider utilities are not registered as SAB sessions', () => {
  assert.match(daemon, /validProviderRootClaim/)
  assert.match(daemon, /rejected nested provider claim/)
})
