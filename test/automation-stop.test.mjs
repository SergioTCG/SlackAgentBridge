import test from 'node:test'
import assert from 'node:assert/strict'

import { detachAutomationState } from '../daemon/automation-stop.mjs'

test('exact automation detach removes only its binding and relevant lineage', () => {
  const record = { sessionId: 'auto', tmux: 'sab-auto-1', channelId: 'CAUTO', provider: 'codex' }
  const state = {
    sessions: {
      auto: { id: 'auto', tmux: 'sab-auto-1', channel: 'CAUTO', provider: 'codex' },
      standby: { id: 'standby', tmux: 'standby', channel: null },
      unrelated: { id: 'unrelated', tmux: 'other', channel: 'COTHER' },
    },
    channels: { CAUTO: 'auto', COTHER: 'unrelated' },
    channelTmux: { CAUTO: 'sab-auto-1', COTHER: 'other' },
    whitelist: { CAUTO: { U098WAUUX5M: 'Rade' }, COTHER: { UOTHER000: 'Other' } },
    lineages: { CAUTO: { activeProvider: 'codex', legs: { claude: 'standby', codex: 'auto', pi: null } } },
  }
  const unrelated = structuredClone({ session: state.sessions.unrelated, channel: state.channels.COTHER, tmux: state.channelTmux.COTHER, whitelist: state.whitelist.COTHER })
  const detached = detachAutomationState(state, record)
  assert.equal(detached.session.id, 'auto')
  assert.equal(state.sessions.auto, undefined)
  assert.ok(state.sessions.standby)
  assert.equal(state.channels.CAUTO, undefined)
  assert.equal(state.channelTmux.CAUTO, undefined)
  assert.equal(state.whitelist.CAUTO, undefined)
  assert.equal(state.lineages.CAUTO, undefined)
  assert.deepEqual({ session: state.sessions.unrelated, channel: state.channels.COTHER, tmux: state.channelTmux.COTHER, whitelist: state.whitelist.COTHER }, unrelated)
})

test('a rebound channel or reused tmux causes a no-mutation refusal', () => {
  const record = { sessionId: 'auto', tmux: 'sab-auto-1', channelId: 'CAUTO', provider: 'claude' }
  for (const state of [
    {
      sessions: { auto: { id: 'auto', tmux: 'sab-auto-1', channel: 'CAUTO' }, other: { id: 'other', tmux: 'other', channel: 'CAUTO' } },
      channels: { CAUTO: 'other' }, whitelist: { CAUTO: { U098WAUUX5M: 'Rade' } },
    },
    {
      sessions: { auto: { id: 'auto', tmux: 'sab-auto-1', channel: 'CAUTO' }, other: { id: 'other', tmux: 'sab-auto-1', channel: 'COTHER' } },
      channels: { CAUTO: 'auto', COTHER: 'other' }, whitelist: { CAUTO: { U098WAUUX5M: 'Rade' } },
    },
  ]) {
    const before = structuredClone(state)
    assert.throws(() => detachAutomationState(state, record), /refusing/)
    assert.deepEqual(state, before)
  }
})
