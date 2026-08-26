import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bulkUpdateBlockReason, planBulkSessionUpdate, runBulkSessionUpdate,
} from '../daemon/session-update.mjs'

function stateFixture() {
  return {
    channels: {
      CCLAUDE: 'claude-id', CCODEX: 'codex-id', CPI: 'pi-id', STALE: 'wrong-alias', CAUTO: 'automation-id',
    },
    sessions: {
      'claude-id': { id: 'claude-id', pid: 11, tmux: 'sab-claude', cwd: '/work/a', channel: 'CCLAUDE' },
      'codex-id': { id: 'codex-id', provider: 'codex', pid: 22, tmux: 'sab-codex', cwd: '/work/b', channel: 'CCODEX' },
      'pi-id': { id: 'pi-id', provider: 'pi', pid: 33, tmux: 'sab-pi', cwd: '/work/c', channel: 'CPI' },
      'automation-id': { id: 'automation-id', provider: 'codex', pid: 44, tmux: 'sab-auto', cwd: '/work/d', channel: 'CAUTO' },
      standby: { id: 'standby', provider: 'codex', pid: 55, tmux: 'sab-standby', cwd: '/work/e', channel: null },
      'wrong-alias': { id: 'wrong-alias', pid: 66, tmux: 'sab-wrong', cwd: '/work/f', channel: 'OTHER' },
    },
    automations: {
      job: { status: 'active', sessionId: 'automation-id', tmux: 'sab-auto' },
    },
  }
}

test('bulk update plan includes only idle authoritative active sessions', () => {
  const state = stateFixture()
  const plan = planBulkSessionUpdate(state, {
    pidAlive: () => true,
    busySessionIds: new Set(['codex-id']),
  })
  assert.deepEqual(plan.eligible.map(session => session.id), ['claude-id', 'pi-id'])
  assert.deepEqual(plan.skipped.map(item => [item.session.id, item.reason]), [
    ['codex-id', 'turn in progress'],
    ['automation-id', 'automation-owned session'],
  ])
})

test('bulk update blockers cover interactive, transitional, managed, and restart work', () => {
  const base = { id: 'one', channel: 'C1', tmux: 'sab-one' }
  assert.equal(bulkUpdateBlockReason(base, { questionSessionIds: new Set(['one']) }), 'question awaiting an answer')
  assert.equal(bulkUpdateBlockReason(base, { pendingPermissionChannels: new Set(['C1']) }), 'permission awaiting a decision')
  assert.equal(bulkUpdateBlockReason(base, { transitionChannels: new Set(['C1']) }), 'provider switch in progress')
  assert.equal(bulkUpdateBlockReason(base, { internalSessionIds: new Set(['one']) }), 'private maintenance turn in progress')
  assert.equal(bulkUpdateBlockReason({ ...base, managed: { status: 'paused' } }), 'managed Pi work in progress')
  assert.equal(bulkUpdateBlockReason(base, { restartingSessionIds: new Set(['one']) }), 'session already restarting')
})

test('provider binaries update once and every stopped session resumes even after update failure', async () => {
  const sessions = [
    { id: 'c1' }, { id: 'c2' }, { id: 'x1', provider: 'codex' }, { id: 'p1', provider: 'pi' },
  ]
  const calls = []
  const result = await runBulkSessionUpdate(sessions, {
    revalidateSession: async session => session.id === 'p1' ? 'became busy' : null,
    stopSession: async session => { calls.push(`stop:${session.id}`) },
    updateProvider: async provider => {
      calls.push(`update:${provider}`)
      if (provider === 'codex') throw new Error('offline')
      return { summary: 'latest' }
    },
    resumeSession: async (session, update) => { calls.push(`resume:${session.id}:${update.updateError || 'ok'}`) },
  })

  assert.deepEqual(calls, [
    'stop:c1', 'stop:c2', 'update:claude', 'resume:c1:ok', 'resume:c2:ok',
    'stop:x1', 'update:codex', 'resume:x1:offline',
  ])
  assert.equal(result.providers.length, 2)
  assert.deepEqual(result.results.map(item => [item.session.id, item.status]), [
    ['c1', 'resumed'], ['c2', 'resumed'], ['x1', 'resumed'], ['p1', 'skipped'],
  ])
})

test('a stop failure affects only that exact session', async () => {
  const calls = []
  const result = await runBulkSessionUpdate([{ id: 'one' }, { id: 'two' }], {
    revalidateSession: async () => null,
    stopSession: async session => {
      calls.push(`stop:${session.id}`)
      if (session.id === 'one') throw new Error('cannot stop')
    },
    updateProvider: async provider => { calls.push(`update:${provider}`); return { summary: 'latest' } },
    resumeSession: async session => { calls.push(`resume:${session.id}`) },
  })
  assert.deepEqual(calls, ['stop:one', 'stop:two', 'update:claude', 'resume:two'])
  assert.deepEqual(result.results.map(item => [item.session.id, item.status, item.phase]), [
    ['one', 'failed', 'stop'], ['two', 'resumed', undefined],
  ])
})
