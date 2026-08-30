import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalControl } from '../daemon/terminal-control.mjs'
import { parseTmuxClientPids } from '../daemon/util.mjs'

test('tmux client parsing does not turn empty output into PID zero', () => {
  assert.deepEqual(parseTmuxClientPids(''), [])
  assert.deepEqual(parseTmuxClientPids('\n  123\n456\nnot-a-pid\n0\n'), [123, 456])
})

function fixture() {
  const state = {
    channels: { C1: 'claude-one', C2: 'codex-two', C3: 'dead-tmux', STALE: 'wrong-alias' },
    sessions: {
      'claude-one': { id: 'claude-one', pid: 11, tmux: 'sab-one', cwd: '/work/one', channel: 'C1' },
      'codex-two': { id: 'codex-two', provider: 'codex', pid: 22, tmux: 'sab-two', cwd: '/work/two', channel: 'C2' },
      'dead-tmux': { id: 'dead-tmux', provider: 'pi', pid: 55, tmux: 'dead', cwd: '/work/dead', channel: 'C3' },
      standby: { id: 'standby', provider: 'pi', pid: 33, tmux: 'sab-standby', cwd: '/work/standby', channel: null },
      'wrong-alias': { id: 'wrong-alias', pid: 44, tmux: 'sab-wrong', cwd: '/work/wrong', channel: 'OTHER' },
    },
  }
  const clients = new Map([['sab-one', [101]], ['sab-two', []]])
  const calls = []
  const control = createTerminalControl({
    state,
    pidAlive: pid => [11, 22, 33, 44, 55].includes(pid),
    tmuxAlive: async tmux => tmux !== 'dead',
    tmuxClientPids: async tmux => clients.get(tmux) || [],
    openTmuxTerminal: async tmux => {
      calls.push(['open', tmux])
      if ((clients.get(tmux) || []).length) return { action: 'focused', focused: true }
      clients.set(tmux, [202]); return { action: 'opened', focused: true }
    },
    closeTmuxTerminal: async tmux => {
      calls.push(['close', tmux])
      const detached = (clients.get(tmux) || []).length
      clients.set(tmux, [])
      return { action: detached ? 'closed' : 'already-closed', detached }
    },
  })
  return { control, calls, clients }
}

test('terminal list contains only authoritative live channel sessions', async () => {
  const { control } = fixture()
  assert.deepEqual((await control.list()).map(row => [row.sessionId, row.nodeId, row.attached]), [
    ['claude-one', 'local', true], ['codex-two', 'local', false],
  ])
})

test('open focuses an existing viewport and creates a missing one idempotently', async () => {
  const { control, calls } = fixture()
  assert.equal((await control.act('open', { channel: 'C1' })).focused, 1)
  assert.equal((await control.act('open', { selector: 'codex' })).changed, 1)
  assert.equal((await control.act('open', { selector: 'codex' })).focused, 1)
  assert.deepEqual(calls, [['open', 'sab-one'], ['open', 'sab-two'], ['open', 'sab-two']])
})

test('close-all detaches viewports without mutating session state or standby legs', async () => {
  const { control, calls } = fixture()
  const result = await control.act('close', { all: true })
  assert.equal(result.total, 2)
  assert.equal(result.changed, 1)
  assert.deepEqual(calls, [['close', 'sab-one'], ['close', 'sab-two']])
})

test('terminal selectors fail closed on missing or non-authoritative sessions', async () => {
  const { control } = fixture()
  await assert.rejects(control.act('open', { selector: 'standby' }), /no active session/)
  await assert.rejects(control.act('close', { channel: 'STALE' }), /no active session/)
})
