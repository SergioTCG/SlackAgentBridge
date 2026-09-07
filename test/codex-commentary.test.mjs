import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CODEX_COMMENTARY_MAX_CHARS,
  claimCodexFinal,
  claimCodexCommentary,
  codexFinalDisposition,
  codexFinalFromAppServerMessage,
  codexFinalLifecycleFingerprint,
  codexFinalLifecycleStillCurrent,
  codexCommentaryDisposition,
  commentaryFromAppServerMessage,
  finalAnswerItemFromAppServerMessage,
  releaseCodexFinal,
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
  assert.equal(codexCommentaryDisposition({
    ...valid, session: { ...session, lastMirroredTurn: 'turn-2', codexFinalTurns: ['turn-1', 'turn-2'] },
  }), 'ignore')
})

test('completed Codex App Server turns expose only their stable final answer', () => {
  const finalItem = {
    id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '  Finished safely.  ',
  }
  const completedTurn = {
    method: 'turn/completed',
    params: {
      threadId: '01a-thread',
      turn: {
        id: 'turn-1', status: 'completed',
        items: [
          { id: 'reasoning-1', type: 'reasoning', summary: ['hidden'] },
          { id: 'comment-1', type: 'agentMessage', phase: 'commentary', text: 'Still working.' },
          finalItem,
        ],
      },
    },
  }
  assert.deepEqual(codexFinalFromAppServerMessage(completedTurn), {
    threadId: '01a-thread', turnId: 'turn-1', itemId: 'final-1', text: 'Finished safely.',
  })
  assert.deepEqual(finalAnswerItemFromAppServerMessage(completed(finalItem)), {
    threadId: '01a-thread', turnId: 'turn-1', itemId: 'final-1', text: 'Finished safely.',
  })

  for (const message of [
    { ...completedTurn, params: { ...completedTurn.params, threadId: '' } },
    { ...completedTurn, params: { ...completedTurn.params, turn: { ...completedTurn.params.turn, status: 'failed' } } },
    { ...completedTurn, params: { ...completedTurn.params, turn: { ...completedTurn.params.turn, items: [] } } },
    { method: 'turn/started', params: completedTurn.params },
  ]) assert.equal(codexFinalFromAppServerMessage(message), null)
})

test('Codex final claims deduplicate Stop and App Server completion paths durably', () => {
  const session = { lastMirroredTurn: 'legacy-turn' }
  assert.equal(claimCodexFinal(session, 'legacy-turn', 3), false)
  assert.equal(claimCodexFinal(session, 'turn-1', 3), true)
  assert.equal(claimCodexFinal(session, 'turn-1', 3), false)
  assert.equal(claimCodexFinal(session, 'turn-2', 3), true)
  assert.equal(claimCodexFinal(session, 'turn-3', 3), true)
  assert.equal(claimCodexFinal(session, 'turn-4', 3), true)
  assert.deepEqual(session.codexFinalTurns, ['turn-2', 'turn-3', 'turn-4'])
  assert.equal(session.lastMirroredTurn, 'turn-4')

  releaseCodexFinal(session, 'turn-4')
  assert.deepEqual(session.codexFinalTurns, ['turn-2', 'turn-3'])
  assert.equal(session.lastMirroredTurn, 'turn-3')
  assert.equal(claimCodexFinal(session, 'turn-4', 3), true)
})

test('Codex finals are accepted only for the exact live authority and distinguish private turns', () => {
  const final = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'final-1', text: 'Done.' }
  const session = { id: 'thread-1', provider: 'codex', pid: 42, tmux: 'sab-one', channel: 'C1' }
  const valid = {
    session, final, pid: 42, tmux: 'sab-one', tmuxClaimValid: true, activeSessionId: 'thread-1',
  }
  assert.equal(codexFinalDisposition(valid), 'accept')
  assert.equal(codexFinalDisposition({ ...valid, pid: 43 }), 'forbidden')
  assert.equal(codexFinalDisposition({ ...valid, tmux: 'sab-other' }), 'forbidden')
  assert.equal(codexFinalDisposition({ ...valid, activeSessionId: 'another-thread' }), 'not_ready')
  assert.equal(codexFinalDisposition({ ...valid, privateTurn: true }), 'private')
  assert.equal(codexFinalDisposition({ ...valid, targetClaim: true }), 'private')
  assert.equal(codexFinalDisposition({ ...valid, session: { ...session, lastMirroredTurn: 'turn-1' } }), 'ignore')
})

test('a late Codex final cannot clear lifecycle state belonging to a newer turn', () => {
  const session = {
    teamActiveTaskId: 'task-1',
    teamInputReservation: { acceptedAt: '2026-09-07T12:00:00.000Z' },
    teamTurn: { startedAt: 100 },
  }
  const expected = codexFinalLifecycleFingerprint(session)
  assert.equal(codexFinalLifecycleStillCurrent(session, expected), true)
  assert.equal(codexFinalLifecycleStillCurrent({ ...session, codexTurnStartedAt: 101 }, expected), false)
  assert.equal(codexFinalLifecycleStillCurrent({ ...session, teamActiveTaskId: 'task-2' }, expected), false)
  assert.equal(codexFinalLifecycleStillCurrent({
    ...session, teamInputReservation: { acceptedAt: '2026-09-07T12:01:00.000Z' },
  }, expected), false)
  assert.equal(codexFinalLifecycleStillCurrent({ ...session, teamTurn: { startedAt: 200 } }, expected), false)
})
