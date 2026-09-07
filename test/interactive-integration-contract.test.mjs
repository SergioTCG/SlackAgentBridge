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

test('App Home uses the sole Socket Mode coordinator and hides data from non-owners', () => {
  assert.match(daemon, /app_home_opened: handleAppHomeOpened/)
  assert.match(daemon, /if \(!USER \|\| userId !== USER\) return appHomeOverviewView\(\{ authorized: false \}\)/)
  assert.match(daemon, /web\.views\.publish\(\{ user_id: userId, view \}\)/)
})
