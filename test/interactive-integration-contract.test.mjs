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

test('textual management forms remain routed for automation and muscle memory', () => {
  assert.match(daemon, /\['current', 'here'\]\.includes\(rest\[0\]\.toLowerCase\(\)\)/)
  assert.match(daemon, /if \(all\) return updateAllSessions\(channel\)/)
  assert.match(daemon, /return setCodexSetting\(session, name, val, \{ expectedSessionId \}\)/)
  assert.match(daemon, /return setPiSetting\(session, name, val, \{ expectedSessionId \}\)/)
  assert.match(daemon, /return beginProviderSwitch\(channel, channelSession, \{ replaceMissing, targetProvider, expectedSessionId \}\)/)
  assert.match(daemon, /return spawnNew\(channel, rest\[0\], rest\.slice\(1\), commandProvider\)/)
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

test('session update ownership is reserved before Slack and released by immutable identity', () => {
  const reserve = /function reserveSessionMaintenance\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(reserve, /const sessionId = expectedSessionId \|\| session\?\.id/)
  assert.match(reserve, /restarting\.add\(sessionId\)/)
  assert.match(reserve, /updatingSessions\.add\(sessionId\)/)
  assert.match(reserve, /resurrectInFlight\.has\(sessionId\)/)

  const stop = /async function stopSessionForUpdate\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(stop, /reserveSessionMaintenance\(session/)
  assert.match(stop, /releaseSessionMaintenance\(reservation\)/)

  const update = /async function updateAndRestart\([\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.match(update, /const updateSessionId = expectedSessionId \|\| session\.id/)
  assert.match(update, /restarting\.delete\(updateSessionId\)/)
  assert.match(update, /updatingSessions\.delete\(updateSessionId\)/)
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
