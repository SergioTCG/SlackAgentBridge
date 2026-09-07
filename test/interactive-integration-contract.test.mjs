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
  assert.match(daemon, /return setCodexSetting\(session, name, val\)/)
  assert.match(daemon, /return setPiSetting\(session, name, val\)/)
  assert.match(daemon, /return beginProviderSwitch\(channel, channelSession, \{ replaceMissing, targetProvider \}\)/)
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
  assert.match(daemon, /expectedSessionId: session\.id/)
  assert.match(daemon, /request\?\.expectedSessionId/)
  assert.match(daemon, /managementTargetStillAuthoritative\(channel, session, request\)/)
})

test('App Home uses the sole Socket Mode coordinator and hides data from non-owners', () => {
  assert.match(daemon, /app_home_opened: handleAppHomeOpened/)
  assert.match(daemon, /if \(!USER \|\| userId !== USER\) return appHomeOverviewView\(\{ authorized: false \}\)/)
  assert.match(daemon, /web\.views\.publish\(\{ user_id: userId, view \}\)/)
})
