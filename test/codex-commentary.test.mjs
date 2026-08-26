import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CODEX_COMMENTARY_MAX_CHARS,
  claimCodexCommentary,
  codexCommentaryDisposition,
  commentaryFromAppServerMessage,
  releaseCodexCommentary,
} from '../daemon/codex-commentary.mjs'

const completed = item => ({
  method: 'item/completed',
  params: {
    threadId: '01a-thread',
    turnId: 'turn-1',
    item,
  },
})

test('only completed user-facing Codex commentary is selected', () => {
  assert.deepEqual(commentaryFromAppServerMessage(completed({
    id: 'item-1',
    type: 'agentMessage',
    phase: 'commentary',
    text: '  Five minutes in, the job remains active.  ',
  })), {
    threadId: '01a-thread',
    turnId: 'turn-1',
    itemId: 'item-1',
    text: 'Five minutes in, the job remains active.',
  })

  for (const message of [
    { method: 'item/agentMessage/delta', params: { delta: 'partial' } },
    completed({ id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'Done.' }),
    completed({ id: 'reasoning', type: 'reasoning', summary: ['hidden'] }),
    completed({ id: 'command', type: 'commandExecution', command: 'git diff' }),
    completed({ id: 'diff', type: 'fileChange', changes: [{ diff: 'secret' }] }),
    completed({ id: 'empty', type: 'agentMessage', phase: 'commentary', text: '  ' }),
  ]) assert.equal(commentaryFromAppServerMessage(message), null)
})

test('commentary delivery claims are bounded, durable, and retryable after failure', () => {
  const session = {}
  assert.equal(claimCodexCommentary(session, 'item-1', 3), true)
  assert.equal(claimCodexCommentary(session, 'item-1', 3), false)
  assert.equal(claimCodexCommentary(session, 'item-2', 3), true)
  assert.equal(claimCodexCommentary(session, 'item-3', 3), true)
  assert.equal(claimCodexCommentary(session, 'item-4', 3), true)
  assert.deepEqual(session.codexCommentaryItems, ['item-2', 'item-3', 'item-4'])

  releaseCodexCommentary(session, 'item-3')
  assert.deepEqual(session.codexCommentaryItems, ['item-2', 'item-4'])
  assert.equal(claimCodexCommentary(session, 'item-3', 3), true)
})

test('malformed or oversized event identities are rejected', () => {
  assert.equal(commentaryFromAppServerMessage(completed({
    id: 'x'.repeat(300), type: 'agentMessage', phase: 'commentary', text: 'hello',
  })), null)
  assert.equal(commentaryFromAppServerMessage({
    method: 'item/completed', params: {
      threadId: '', turnId: 'turn-1',
      item: { id: 'item-1', type: 'agentMessage', phase: 'commentary', text: 'hello' },
    },
  }), null)
  assert.equal(commentaryFromAppServerMessage(completed({
    id: 'object-text', type: 'agentMessage', phase: 'commentary', text: { not: 'text' },
  })), null)

  const bounded = commentaryFromAppServerMessage(completed({
    id: 'long-text', type: 'agentMessage', phase: 'commentary',
    text: `${'a'.repeat(CODEX_COMMENTARY_MAX_CHARS - 2)}😀tail`,
  }))
  assert.equal(bounded.text.length, CODEX_COMMENTARY_MAX_CHARS - 1)
  assert.match(bounded.text, /…$/)
  assert.doesNotMatch(bounded.text, /�/)
})

test('commentary is accepted only for its exact active Codex process, tmux, and channel', () => {
  const commentary = { turnId: 'turn-1' }
  const session = { id: 'thread-1', provider: 'codex', pid: 42, tmux: 'ccs-one', channel: 'C1' }
  const valid = {
    session, commentary, pid: 42, tmux: 'ccs-one', tmuxClaimValid: true, activeSessionId: 'thread-1',
  }
  assert.equal(codexCommentaryDisposition(valid), 'accept')
  assert.equal(codexCommentaryDisposition({ ...valid, pid: 43 }), 'forbidden')
  assert.equal(codexCommentaryDisposition({ ...valid, tmux: 'ccs-other' }), 'forbidden')
  assert.equal(codexCommentaryDisposition({ ...valid, activeSessionId: 'another-thread' }), 'not_ready')
  assert.equal(codexCommentaryDisposition({ ...valid, session: { ...session, provider: 'claude' } }), 'forbidden')
  assert.equal(codexCommentaryDisposition({ ...valid, privateTurn: true }), 'ignore')
  assert.equal(codexCommentaryDisposition({ ...valid, targetClaim: true }), 'ignore')
  assert.equal(codexCommentaryDisposition({ ...valid, session: { ...session, lastMirroredTurn: 'turn-1' } }), 'ignore')
})
