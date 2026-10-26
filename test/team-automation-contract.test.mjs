import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const body = name => new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}`, 'm').exec(daemon)?.[0] || ''

test('a prepared automation channel is bound at SessionStart and never replaced', () => {
  const create = body('createSessionChannel')
  const prepared = create.indexOf('preparedAutomationChannel(state, session, prior)')
  assert.ok(prepared > 0, 'SessionStart must look for the automation channel first')
  assert.ok(prepared < create.indexOf('conversations.info'), 'no Slack lookup can divert a prepared channel')
  assert.ok(prepared < create.indexOf('conversations.create'), 'a prepared channel is never replaced by a new one')
  const bind = body('bindPreparedAutomationChannel')
  assert.match(bind, /state\.channels\[channel\] = session\.id/)
  assert.doesNotMatch(bind, /conversations\.create/)
})

test('a requested channel name is used verbatim and only generated names get a suffix', () => {
  const prepare = body('prepareAutomationChannel')
  assert.match(prepare, /if \(requested \|\| error\?\.data\?\.error !== 'name_taken'\) throw automationChannelError/)
  assert.match(prepare, /state\.channelTmux\[channelId\] = record\.tmux/)
  assert.match(body('automationChannelError'), /definitive: true/)
})

test('channel creation is a single journaled attempt, never a client retry', () => {
  const prepare = body('prepareAutomationChannel')
  assert.doesNotMatch(prepare, /\bweb\.conversations\.create/, 'the retrying client must not create channels')
  const creates = prepare.match(/slackRuntime\.webOnce\.conversations\.create/g) || []
  assert.equal(creates.length, 2)
  assert.ok(prepare.indexOf('journalName(name)') < prepare.indexOf('slackRuntime.webOnce.conversations.create'))
  assert.ok(prepare.indexOf('journalName(suffixed)') < prepare.lastIndexOf('slackRuntime.webOnce.conversations.create'))
  const classify = body('automationChannelError')
  assert.match(classify, /error\?\.data\?\.ok === false && code/)
  assert.match(classify, /slack_webapi_rate_limited_error[\s\S]*definitive: true/)
  assert.doesNotMatch(classify, /slack_webapi_request_error|slack_webapi_http_error/, 'transport failures stay uncertain')
})

test('no team task reaches an automation session before its setup completes', () => {
  assert.match(body('teamTargetBusyReasons'), /automationSetupPending\(state, session\.channel\)\) reasons\.push\('automation setup'\)/)
  const dispatch = body('dispatchTeamTask')
  const wait = dispatch.indexOf('if (automationSetupPending(state, task.targetChannel)) return false')
  const fail = dispatch.indexOf("'The target channel no longer has an authoritative SAB session.'")
  assert.ok(wait > 0 && fail > wait, 'a launching worker waits instead of failing the task')
})

test('a bootstrap task is held until its automation finished setup and is claimed exactly once', () => {
  const dispatch = body('dispatchTeamTask')
  const hold = dispatch.indexOf('bootstrapTaskHold(state, task)')
  const claim = dispatch.indexOf('claimTeamTaskForSession(state, task.id')
  assert.ok(hold > 0 && claim > hold)
  assert.match(dispatch, /bootstrapHold === 'wait'\) return false/)
  assert.match(dispatch, /bootstrapHold === 'ended'[\s\S]*failTeamTask/)
})

test('stopping an automation detaches its team roles before its session record', () => {
  const terminate = body('terminateAutomation')
  const teams = terminate.indexOf('detachAutomationTeams(state, record)')
  const detach = terminate.indexOf('detachAutomationState(state, record)')
  const persist = terminate.indexOf('saveStateNow(state)', detach)
  const announce = terminate.indexOf('announceAutomationTeamDepartures(record, teamDepartures)')
  assert.ok(teams > 0 && detach > teams && persist > detach && announce > persist)
  assert.match(terminate, /revokeCancelledTeamTasks\(departure\.cancelled\)/)
})

test('team-bound automation creation reuses the exact caller proof and dispatch authority', () => {
  assert.match(daemon, /createAutomationTeamBootstrap\(\{[\s\S]*resolveCaller: caller => resolveTeamCaller\(caller\)/)
  assert.match(daemon, /requireDispatch: \(session, team\) => requireCoordinatorDispatch\(session, team\)/)
  assert.match(daemon, /createAutomationLifecycle\(\{\s*state,\s*prepareChannel: prepareAutomationChannel,\s*teamBootstrap: automationTeamBootstrap,/)
  const send = daemon.slice(daemon.indexOf('  async send(caller, request) {'), daemon.indexOf('  async continue(caller, request) {'))
  assert.match(send, /requireCoordinatorDispatch\(session, team, authority\)/)
  const renewal = daemon.slice(daemon.indexOf('function requireCoordinatorDispatch('), daemon.indexOf('function acceptedTeamMutation('))
  assert.match(renewal, /claimContinuationDispatchAuthority\(team, session\)[\s\S]*saveStateNow\(state\)[\s\S]*assertCoordinatorDispatch/)
})
