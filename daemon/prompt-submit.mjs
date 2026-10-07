import { isProviderInternalPrompt, isSystemPrompt } from './providers.mjs'
import {
  acknowledgeCoordinatorTaskMessageDelivery, clearTeamTurn, markTeamTaskRunning, taskMarker,
  teamTaskProviderWorkGeneration,
} from './teams.mjs'
import {
  activatePendingTeamProviderTurn, activateTeamProviderTurn, journaledTeamProviderPrompt,
  pendingTeamProviderTurn, providerPromptAcknowledgesTask, providerPromptTurnMarker,
  retireTeamProviderTurn, unacknowledgedPromptTeamEffect,
} from './team-provider-turn.mjs'
import { unwrapPastedContent } from './util.mjs'

// UserPromptSubmit: decide whether a native prompt is the bridge's own input
// (a delegated task, a coordinator message, a Slack injection) or local input,
// apply that to the session's team lifecycle, and mirror only genuine typing.
// The daemon supplies its persistence, poller, Slack and audit effects.
export function createPromptSubmitHandler({
  state,
  automationLifecycle,
  internalTurns,
  consumeInjected,
  currentTeamTaskProviderTurn,
  teamTaskTurnOwnsCurrentLifecycle,
  refreshTeamTaskPoller,
  codexFinalAlreadyClaimed,
  beginCodexTurn,
  scheduleDeferredTeamProviderFinal,
  persistedCoordinatorMessageAcks,
  reserveTeamInput,
  ensureChannel,
  updateTeamTaskAudit,
  teamTurnProof,
  failTeamTaskForSession,
  startPoller,
  saveStateNow,
  post,
  log,
}) {
  return async function handlePromptSubmit({ session, sid, provider, body, targetClaim = null }) {
    const p = (body.prompt || '').trim()
    const automationEcho = automationLifecycle.consumeInitialPromptEcho(sid, p)
    if (targetClaim || internalTurns.has(session.id)) {
      consumeInjected(sid, p)
      return
    }
    // A provider notification is never a delegated-task delivery, even when its
    // payload quotes a task envelope (for example a Monitor tailing team output).
    const providerInternal = isProviderInternalPrompt(provider, p)
    const teamTaskId = providerInternal ? null : taskMarker(p)
    const promptTeamTurn = providerInternal ? null : providerPromptTurnMarker(p)
    // The journal holds a digest of the exact text the bridge submitted; Claude
    // Code may wrap that pasted text in a <pasted_content> envelope.
    const deliveredPrompt = unwrapPastedContent(p)
    // Snapshot the exact task generation represented by this native prompt
    // before any Slack audit await can let a coordinator follow-up advance the
    // mutable task journal underneath this hook.
    const pendingPromptTeamTurn = promptTeamTurn
      ? pendingTeamProviderTurn(session, promptTeamTurn)
      : null
    const submittedTeamTaskTurn = pendingPromptTeamTurn ||
      currentTeamTaskProviderTurn(session, body)
    // Provenance only: a journaled prompt is the bridge's own input even after
    // the injected-text record expired, but it authorizes nothing by itself.
    const journaledDelivery = journaledTeamProviderPrompt(session, deliveredPrompt)
    const injected = consumeInjected(sid, p)
    const task = session.teamActiveTaskId ? state.teamTasks?.[session.teamActiveTaskId] : null
    const acknowledgesTask = providerPromptAcknowledgesTask(session, {
      taskId: task?.id,
      // Provider delivery advances the task journal only after the transport
      // callback settles. An earlier exact prompt hook is itself the durable
      // acceptance proof, so compare it with its staged generation rather than
      // the still-preceding task projection.
      currentGeneration: pendingPromptTeamTurn?.providerWorkGeneration ??
        (task ? teamTaskProviderWorkGeneration(task) : null),
      promptTurn: promptTeamTurn,
      submittedTurn: submittedTeamTaskTurn,
      prompt: deliveredPrompt,
      injected,
      pending: Boolean(pendingPromptTeamTurn),
    })
    const acknowledgedTurn = task && task.targetSessionId === session.id &&
      task.targetChannel === session.channel && acknowledgesTask &&
      submittedTeamTaskTurn?.taskId === task.id
      ? submittedTeamTaskTurn
      : null
    const staleSameTaskPrompt = Boolean(task && promptTeamTurn?.taskId === task.id &&
      Number.isSafeInteger(promptTeamTurn.providerWorkGeneration) &&
      promptTeamTurn.providerWorkGeneration < teamTaskProviderWorkGeneration(task))
    let acknowledgedCoordinatorMessage = null
    if (acknowledgedTurn) {
      // An uncertain tmux delivery may leave only the pending generation for
      // this hook to recover. Promote and persist it before channel/audit I/O:
      // a fast Stop during either await must see the accepted exact turn.
      const activation = {
        providerTurnId: body.turn_id || null,
        startedAt: body.observed_at || Date.now(),
        acceptedAt: body.observed_at || Date.now(),
      }
      const activeTurn = pendingPromptTeamTurn
        ? activatePendingTeamProviderTurn(session, pendingPromptTeamTurn, activation)
        : activateTeamProviderTurn(session, { turn: acknowledgedTurn, ...activation })
      acknowledgedCoordinatorMessage = acknowledgeCoordinatorTaskMessageDelivery(state, task.id, {
        targetSessionId: session.id,
        providerWorkGeneration: acknowledgedTurn.providerWorkGeneration,
        now: activation.startedAt,
      })
      refreshTeamTaskPoller(session, activeTurn)
      const acknowledgedTurnStillCurrent = Boolean(activeTurn &&
        activeTurn.taskId === acknowledgedTurn.taskId &&
        activeTurn.providerWorkGeneration === acknowledgedTurn.providerWorkGeneration &&
        teamTaskTurnOwnsCurrentLifecycle(session, acknowledgedTurn))
      // Codex Stop/App Server completion can race the Slack audit below. Start
      // and persist its lifecycle now so that finalization may clear this exact
      // turn. A delayed prompt hook must not recreate a final already claimed,
      // retag a newer generation, or use handler wall-clock time as its start.
      if (provider === 'codex' && acknowledgedTurnStillCurrent &&
          ['dispatching', 'running'].includes(task.status) &&
          !codexFinalAlreadyClaimed(session, body.turn_id)) {
        beginCodexTurn(session, activation.startedAt, body.turn_id || null)
      }
      saveStateNow(state)
      scheduleDeferredTeamProviderFinal(session, activeTurn)
      if (acknowledgedCoordinatorMessage?.message) {
        // This in-memory proof is deliberately recorded only after the atomic
        // state write. A racing transport error may trust it; locally mutated
        // `delivered` fields whose persistence failed are not sufficient.
        persistedCoordinatorMessageAcks.add(acknowledgedCoordinatorMessage.message)
      }
    } else if (p && !session.teamActiveTaskId && retireTeamProviderTurn(session)) {
      saveStateNow(state)
    }
    if (p && !acknowledgedTurn && !promptTeamTurn &&
        !(teamTaskId && session.teamActiveTaskId === teamTaskId)) reserveTeamInput(session, 'provider')
    const ch = session.channel || (await ensureChannel(session))
    if (acknowledgedCoordinatorMessage?.created) {
      await updateTeamTaskAudit(task).catch(error =>
        log('team coordinator message acknowledgement audit deferred', task.id, String(error?.message || error)))
    }
    if (acknowledgedTurn && teamTaskId && session.teamActiveTaskId === teamTaskId) {
      try {
        const task = markTeamTaskRunning(state, teamTaskId)
        teamTurnProof.add(session.id)
        saveStateNow(state)
        await updateTeamTaskAudit(task)
      }
      catch (error) { log('team task prompt acknowledgement rejected', teamTaskId, String(error?.message || error)) }
    } else if (acknowledgedTurn && !teamTaskId) {
      // An authenticated coordinator message for the current generation is the
      // bridge's own input even when its hook arrives after the injected-text
      // record expired (a provider may queue it behind a running turn) or after
      // a daemon restart. The acknowledgement above already settled it; it
      // never replaces the delegated turn or ends the worker's authority.
      if (!injected) {
        log('acknowledged journaled coordinator message', acknowledgedTurn.taskId,
          acknowledgedTurn.providerWorkGeneration)
      }
    } else if (staleSameTaskPrompt) {
      // Provider hooks may be delayed beyond the in-memory injected-text cache
      // or a daemon restart. An older exact generation for this same task is
      // system input, not a local owner prompt and not authority for the newer
      // work. Ignore it without changing either lifecycle.
      log('ignored stale team prompt acknowledgement', promptTeamTurn.taskId,
        promptTeamTurn.providerWorkGeneration, 'current', teamTaskProviderWorkGeneration(task))
    } else if (teamTaskId && session.teamActiveTaskId && teamTaskId !== session.teamActiveTaskId) {
      await failTeamTaskForSession(session, 'The provider acknowledged a different delegated task identity.')
    } else {
      const localPromptEffect = unacknowledgedPromptTeamEffect({
        prompt: p, activeTaskId: session.teamActiveTaskId, injected, automationEcho, providerInternal,
      })
      if (localPromptEffect === 'fail_task') {
        await failTeamTaskForSession(session, 'A local terminal prompt replaced the delegated worker turn.')
      } else if (localPromptEffect === 'revoke_turn') {
        // Local terminal input and uncorrelated prompts do not inherit a prior
        // Slack owner's lateral team authority. Provider notifications that
        // Claude Code submits mid-turn keep the current turn's authority.
        clearTeamTurn(session)
        saveStateNow(state)
      }
    }
    // Mirror only genuine typing: skip the bridge's own input, recognized by its
    // injected-text record or, once that expires, its persisted team journal,
    // and system-injected content (task notifications, reminders, echoes).
    if (p && !automationEcho && !injected && !acknowledgedTurn && !journaledDelivery &&
        !p.includes('source="slack-bridge"') && !isSystemPrompt(p)) {
      await post(ch, `💬 *You (terminal):*\n${p}`)
    }
    if (provider === 'claude') startPoller(session) // Claude TUI-specific spinner/form relay
    else if (provider === 'codex' && !acknowledgedTurn && !promptTeamTurn &&
        !codexFinalAlreadyClaimed(session, body.turn_id)) {
      beginCodexTurn(session, body.observed_at || Date.now(), body.turn_id || null)
    }
  }
}
