import test from 'node:test'
import assert from 'node:assert/strict'
import { validTeamCallerBinding } from '../daemon/team-auth.mjs'

const session = {
  id: 'native-one', provider: 'codex', pid: 123, tmux: 'sab-worker', channel: 'C-WORKER',
}
const state = { channels: { 'C-WORKER': 'native-one' }, sessions: { 'native-one': session } }

test('team caller binding requires the exact live authoritative local leg', () => {
  const exact = { pid: 123, tmux: 'sab-worker', provider: 'codex', live: true, tmuxClaimed: true }
  assert.equal(validTeamCallerBinding(state, session, exact), true)
  for (const mutation of [
    { pid: 999 }, { tmux: 'sab-other' }, { provider: 'claude' }, { live: false }, { tmuxClaimed: false },
  ]) assert.equal(validTeamCallerBinding(state, session, { ...exact, ...mutation }), false)
  assert.equal(validTeamCallerBinding({ ...state, channels: { 'C-WORKER': 'replacement' } }, session, exact), false)
  assert.equal(validTeamCallerBinding(state, { ...session, nodeId: 'remote-one' }, exact), false)
})

test('missing-provider legacy sessions remain Claude without weakening binding', () => {
  const legacy = { id: 'legacy', pid: 55, tmux: 'ccs-old', channel: 'C-OLD' }
  const legacyState = { channels: { 'C-OLD': 'legacy' }, sessions: { legacy } }
  assert.equal(validTeamCallerBinding(legacyState, legacy, {
    pid: 55, tmux: 'ccs-old', provider: 'claude', live: true, tmuxClaimed: true,
  }), true)
})
