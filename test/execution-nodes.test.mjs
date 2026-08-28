import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_NODE_ID,
  bindSessionNode,
  channelNodeId,
  localSessionByChannel,
  localSessionByPid,
  nodeIdForSession,
  validateNodeId,
} from '../daemon/nodes.mjs'
import { createExecutionNodeRouter, createLocalExecutionNode } from '../daemon/execution-nodes.mjs'

test('legacy sessions without node metadata remain local without state migration', () => {
  const state = {
    channels: { C1: 'legacy' },
    sessions: { legacy: { id: 'legacy', channel: 'C1' } },
  }
  assert.equal(nodeIdForSession(state.sessions.legacy), LOCAL_NODE_ID)
  assert.equal(channelNodeId(state, 'C1'), LOCAL_NODE_ID)
  assert.equal('nodeId' in state.sessions.legacy, false)
  assert.equal('channelNodes' in state, false)
})

test('node IDs are bounded immutable identifiers, not display names', () => {
  assert.equal(validateNodeId('node_01jabcdef0123456789'), 'node_01jabcdef0123456789')
  assert.throws(() => validateNodeId('Rade’s MacBook Pro'), /invalid execution node ID/)
  assert.throws(() => validateNodeId('../other-machine'), /invalid execution node ID/)
})

test('remote channel routes require an exact session and route match', () => {
  const state = {
    channels: { C1: 'remote-session' },
    sessions: { 'remote-session': { id: 'remote-session', channel: 'C1' } },
  }
  bindSessionNode(state, state.sessions['remote-session'], 'node_rade')
  assert.equal(state.sessions['remote-session'].nodeId, 'node_rade')
  assert.equal(state.channelNodes.C1, 'node_rade')
  assert.equal(channelNodeId(state, 'C1'), 'node_rade')

  delete state.channelNodes
  assert.equal(channelNodeId(state, 'C1'), null)
  state.channelNodes = { C1: 'node_rade' }
  state.channelNodes.C1 = 'node_someone_else'
  assert.equal(channelNodeId(state, 'C1'), null)
  state.channelNodes.C1 = 'node_rade'
  state.sessions['remote-session'].channel = 'OTHER'
  assert.equal(channelNodeId(state, 'C1'), null)
})

test('the all-in-one daemon never adopts an explicit remote route as local', () => {
  const state = {
    channels: { LOCAL: 'legacy', REMOTE: 'remote' },
    channelNodes: { REMOTE: 'node_rade' },
    sessions: {
      legacy: { id: 'legacy', channel: 'LOCAL', pid: 11 },
      remote: { id: 'remote', channel: 'REMOTE', pid: 22, nodeId: 'node_rade' },
    },
  }
  assert.equal(localSessionByChannel(state, 'LOCAL'), state.sessions.legacy)
  assert.equal(localSessionByChannel(state, 'REMOTE'), null)
  assert.equal(localSessionByPid(state, 11), state.sessions.legacy)
  assert.equal(localSessionByPid(state, 22), null)
})

test('rebinding a session to local removes explicit compatibility metadata', () => {
  const state = { channelNodes: { C1: 'node_rade' } }
  const session = { id: 'one', channel: 'C1', nodeId: 'node_rade' }
  bindSessionNode(state, session, LOCAL_NODE_ID)
  assert.equal('nodeId' in session, false)
  assert.equal('channelNodes' in state, false)
})

test('execution router dispatches only to the exact registered node', async () => {
  const calls = []
  const local = createLocalExecutionNode({
    spawnSession: async options => { calls.push(['spawn', options.tmuxName]); return options.tmuxName },
    pidAlive: pid => pid === 42,
    tmuxAlive: async tmux => tmux === 'sab-live',
    tmuxClientPids: async tmux => tmux === 'sab-live' ? [100] : [],
    openTmuxTerminal: async tmux => ({ action: 'focused', tmux }),
    closeTmuxTerminal: async tmux => ({ action: 'closed', tmux }),
  })
  const router = createExecutionNodeRouter({ nodes: [local] })
  const session = { id: 'legacy', pid: 42, tmux: 'sab-live' }

  assert.equal(await router.sessionAlive(session), true)
  assert.deepEqual(await router.terminalClientPids(session), [100])
  assert.deepEqual(await router.openTerminal(session), { action: 'focused', tmux: 'sab-live' })
  assert.equal(await router.spawn(LOCAL_NODE_ID, { tmuxName: 'sab-new' }), 'sab-new')
  assert.deepEqual(calls, [['spawn', 'sab-new']])

  await assert.rejects(router.spawn('node_offline', { tmuxName: 'nope' }), /not registered or is offline/)
  await assert.rejects(router.openTerminal({ ...session, nodeId: 'node_offline' }), /not registered or is offline/)
})

test('execution router rejects duplicate node identities', () => {
  const dependencies = {
    spawnSession: async () => {}, pidAlive: () => true, tmuxAlive: async () => true,
    tmuxClientPids: async () => [], openTmuxTerminal: async () => {}, closeTmuxTerminal: async () => {},
  }
  assert.throws(() => createExecutionNodeRouter({
    nodes: [createLocalExecutionNode(dependencies), createLocalExecutionNode(dependencies)],
  }), /duplicate execution node/)
})
