import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHooklessCodexClaim, canonicalCodexAppServerPid, codexAppServerProcessPid,
  hooklessAuthoritativeCodexSessions,
  parseProcessTable,
  selectCodexProcessPid,
  tmuxCodexProcessPid,
  waitForCodexResumeClaim,
} from '../daemon/codex-resume.mjs'

const processRows = [
  { pid: 100, ppid: 1, comm: '/bin/bash', args: '/bin/bash run-session.sh codex resume session-1' },
  { pid: 110, ppid: 100, comm: 'node', args: 'node /opt/homebrew/bin/codex app-server --listen ws://127.0.0.1:0' },
  { pid: 120, ppid: 100, comm: 'node', args: 'node /bridge/scripts/codex-event-proxy.mjs --agent-pid 110' },
  { pid: 130, ppid: 100, comm: 'node', args: 'node /opt/homebrew/bin/codex --remote ws://127.0.0.1:1 resume session-1' },
  { pid: 140, ppid: 130, comm: '/bin/zsh', args: '/bin/zsh -lc codex status' },
  { pid: 210, ppid: 200, comm: 'node', args: 'node /opt/homebrew/bin/codex app-server --listen ws://127.0.0.1:2' },
]

test('process-table parsing preserves PID ancestry and full arguments', () => {
  assert.deepEqual(parseProcessTable(`
  100     1 /bin/bash /bin/bash run-session.sh codex resume session-1
  110   100 node      node /opt/homebrew/bin/codex app-server --listen ws://127.0.0.1:0
`), processRows.slice(0, 2))
})

test('Codex PID selection is confined to the exact tmux tree and prefers App Server', () => {
  assert.equal(selectCodexProcessPid(processRows, [100]), 110)
  assert.equal(selectCodexProcessPid(processRows, [200]), 210)
  assert.equal(selectCodexProcessPid(processRows, [999]), null)
})

test('Codex App Server identity follows its npm launcher to the matching native child', async () => {
  const rows = [
    ...processRows,
    { pid: 111, ppid: 110, comm: '/opt/homebrew/lib/codex', args: '/opt/homebrew/lib/vendor/codex app-server --listen ws://127.0.0.1:0' },
    { pid: 112, ppid: 110, comm: '/bin/sh', args: '/bin/sh unrelated-helper' },
    { pid: 211, ppid: 210, comm: '/opt/homebrew/lib/codex', args: '/opt/homebrew/lib/vendor/codex app-server --listen ws://127.0.0.1:2' },
  ]
  assert.equal(canonicalCodexAppServerPid(rows, 110), 111)
  assert.equal(canonicalCodexAppServerPid(rows, 111), 111)
  assert.equal(canonicalCodexAppServerPid(rows, 120), 120)
  assert.equal(selectCodexProcessPid(rows, [100]), 111)
  assert.equal(selectCodexProcessPid(rows, [200]), 211)

  assert.equal(await codexAppServerProcessPid(110, {
    execFile: async command => {
      assert.equal(command, 'ps')
      return { stdout: rows.map(row => `${row.pid} ${row.ppid} ${row.comm} ${row.args}`).join('\n') }
    },
  }), 111)
  assert.equal(await codexAppServerProcessPid(110, {
    execFile: async () => { throw new Error('ps unavailable') },
  }), 110)
})

test('Codex PID selection supports the direct native TUI fallback', () => {
  assert.equal(selectCodexProcessPid([
    { pid: 300, ppid: 1, comm: '/opt/homebrew/bin/codex', args: 'codex resume session-2' },
    { pid: 310, ppid: 300, comm: '/bin/zsh', args: '/bin/zsh -lc run tool' },
    { pid: 320, ppid: 310, comm: 'node', args: 'node /opt/homebrew/bin/codex app-server --listen ws://127.0.0.1:3' },
  ], [300]), 300)
})

test('tmux process lookup rejects invalid identities and isolates command failures', async () => {
  let calls = 0
  assert.equal(await tmuxCodexProcessPid('../bad', { execFile: async () => { calls++; return {} } }), null)
  assert.equal(calls, 0)
  assert.equal(await tmuxCodexProcessPid('sab-good', {
    execFile: async command => {
      if (command === 'tmux') return { stdout: '100\n' }
      return { stdout: '100 1 /bin/bash /bin/bash run-session.sh codex\n110 100 node node /opt/homebrew/bin/codex app-server\n' }
    },
  }), 110)
  assert.equal(await tmuxCodexProcessPid('sab-good', { execFile: async () => { throw new Error('gone') } }), null)
})

function readinessFixture(session, overrides = {}) {
  const calls = { find: 0, sleeps: 0 }
  const dependencies = {
    tmuxAlive: async () => true,
    pidAlive: pid => pid === 222,
    findCodexPid: async () => { calls.find++; return 222 },
    validTmuxClaim: async (pid, tmux) => pid === 222 && tmux === 'sab-resume',
    sleep: async () => { calls.sleeps++ },
    attempts: 2,
    intervalMs: 1,
    ...overrides,
  }
  return { session, calls, dependencies }
}

test('idle Codex resume falls back to an ancestry-validated process claim', async () => {
  const fixture = readinessFixture({ id: 'session-1', provider: 'codex', pid: null, tmux: 'sab-resume' })
  assert.deepEqual(await waitForCodexResumeClaim(fixture.session, fixture.dependencies), {
    source: 'process-tree', pid: 222, tmux: 'sab-resume',
  })
  assert.equal(fixture.calls.find, 1)
  assert.equal(fixture.calls.sleeps, 2)
})

test('native SessionStart wins without process-tree adoption', async () => {
  const session = { id: 'session-1', provider: 'codex', pid: null, tmux: 'sab-resume' }
  const fixture = readinessFixture(session, {
    sleep: async () => { fixture.calls.sleeps++; session.pid = 222 },
  })
  assert.deepEqual(await waitForCodexResumeClaim(session, fixture.dependencies), {
    source: 'hook', pid: 222, tmux: 'sab-resume',
  })
  assert.equal(fixture.calls.find, 0)
})

test('readiness fails closed on a rebound tmux or unrelated process', async () => {
  const rebound = readinessFixture({ id: 'session-1', provider: 'codex', pid: null, tmux: 'sab-resume' }, {
    sleep: async () => { rebound.session.tmux = 'sab-other' },
  })
  await assert.rejects(waitForCodexResumeClaim(rebound.session, rebound.dependencies), /identity changed/)

  const unrelated = readinessFixture({ id: 'session-1', provider: 'codex', pid: null, tmux: 'sab-resume' }, {
    validTmuxClaim: async () => false,
  })
  await assert.rejects(waitForCodexResumeClaim(unrelated.session, unrelated.dependencies), /ancestry check/)
})

test('boot recovery considers only hookless authoritative Codex sessions', () => {
  const state = {
    channels: { C1: 'codex-idle', C2: 'claude-idle', C3: 'rebound', C4: 'codex-live' },
    sessions: {
      'codex-idle': { id: 'codex-idle', provider: 'codex', pid: null, tmux: 'sab-idle', channel: 'C1' },
      'claude-idle': { id: 'claude-idle', pid: null, tmux: 'sab-claude', channel: 'C2' },
      rebound: { id: 'rebound', provider: 'codex', pid: null, tmux: 'sab-rebound', channel: 'OTHER' },
      'codex-live': { id: 'codex-live', provider: 'codex', pid: 44, tmux: 'sab-live', channel: 'C4' },
      standby: { id: 'standby', provider: 'codex', pid: null, tmux: 'sab-standby', channel: null },
    },
  }
  assert.deepEqual(hooklessAuthoritativeCodexSessions(state).map(session => session.id), ['codex-idle'])
})

test('hookless adoption repairs only the exact authoritative session mapping', () => {
  const session = { id: 'codex-idle', provider: 'codex', pid: null, tmux: 'sab-new', channel: 'C1' }
  const other = { id: 'other', provider: 'codex', pid: 77, tmux: 'sab-other', channel: 'C2' }
  const state = {
    channels: { C1: session.id, C2: other.id },
    channelTmux: { C1: 'sab-old', C2: 'sab-other' },
    sessions: { [session.id]: session, [other.id]: other },
  }
  assert.equal(applyHooklessCodexClaim(state, session, { pid: 222, tmux: 'sab-new' }), true)
  assert.equal(session.pid, 222)
  assert.equal(state.channelTmux.C1, 'sab-new')
  assert.deepEqual(other, { id: 'other', provider: 'codex', pid: 77, tmux: 'sab-other', channel: 'C2' })
  assert.equal(state.channelTmux.C2, 'sab-other')
  assert.equal(applyHooklessCodexClaim(state, session, { pid: 333, tmux: 'sab-new' }), false)
})

test('hookless adoption rejects rebound channels and tmux identities without mutation', () => {
  const session = { id: 'codex-idle', provider: 'codex', pid: null, tmux: 'sab-new', channel: 'C1' }
  const state = { channels: { C1: 'replacement' }, channelTmux: { C1: 'sab-old' }, sessions: { [session.id]: session } }
  assert.throws(() => applyHooklessCodexClaim(state, session, { pid: 222, tmux: 'sab-new' }), /non-authoritative/)
  assert.equal(session.pid, null)
  assert.equal(state.channelTmux.C1, 'sab-old')

  state.channels.C1 = session.id
  assert.throws(() => applyHooklessCodexClaim(state, session, { pid: 222, tmux: 'sab-wrong' }), /mismatched/)
  assert.equal(session.pid, null)
})
