#!/usr/bin/env node
// Slack Agent Bridge daemon. Owns the Socket Mode connection and bridge logic.
import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BRIDGE, CONFIG_DIR, log, sleep, loadEnv, loadState, saveState, saveStateNow,
  resolveClaudePid, resolveAgentPid, pidAlive, gitInfo, gitStatusText, gitBranch, channelName,
  tmuxSendCommand, tmuxAlive, tmuxKill, tmuxCapture, tmuxInterrupt, tmuxPaste,
  spawnSession, clearKillOnClose, execFile, availableModels, tmuxTitle, safeAccount,
  tmuxClientPids, openTmuxTerminal, closeTmuxTerminal,
} from './util.mjs'
import { enqueue, mdToMessages, reportSlashFailure, unescapeSlack, escapeText } from './slackout.mjs'
import {
  CODEX_DANGEROUS_FLAG, CODEX_EFFORTS, PI_EFFORTS, PROVIDERS, acceptHookSettings, allowedFlags,
  codexFlagsWithoutInitialPrompt, codexModelFromArgs, codexPermissionDecision, codexStatusRecoveryDecision,
  defaultNewFlagsFor, displayFlagsFor,
  isPathWithin, isSupersededHook, normalizeLaunchFlag, normalizeProvider, normalizeRemoteLaunchFlags, parseSlackCommand,
  providerCommand, providerLabel, providerOf, resolveCodexEffort, resumeArgsFor, slackCommand,
  submitTargetValidation, switchActionBlocks, switchTargetLaunch, targetStartupState, waitForTargetSessionClaim,
  waitForCodexInterrupt,
} from './providers.mjs'
import { CONTROL_CHANNEL_NAME, findControlChannel, prunePermissionsOnBoot } from './identity.mjs'
import { createSessionChannelGate, pruneSessionChannelAliases } from './channel-binding.mjs'
import { createTopicSync } from './topic.mjs'
import { createStatusMessages, recoverCodexTurnStartedAt } from './status.mjs'
import {
  claimCodexCommentary, codexCommentaryDisposition, commentaryFromAppServerMessage, releaseCodexCommentary,
} from './codex-commentary.mjs'
import { codexTerminalFailure, codexTerminalFailureDecision } from './codex-terminal.mjs'
import {
  ArtifactUploadError, artifactDeliveryInstruction, createArtifactGrantStore, fulfillArtifactUpload,
  slackArtifactUploadOptions,
} from './artifacts.mjs'
import {
  codexProjectUsage, codexSessionUsage, codexTokenSnapshot, formatCodexWorkingStatus,
  formatPiWorkingStatus, formatTokens, normalizePiUsage, piUsageRows, usageCost, usageDate, usageRows,
} from './usage.mjs'
import {
  beginTransition, commitTransition, defaultSwitchTarget, deleteLineage, enqueueTransitionItem, ensureLineage, lineageFor,
  rebindLineageSession, recoveryDecision, rollbackTransition, setTransitionPhase, transitionForSession, transitionForTarget,
  standbyForSession,
} from './lineage.mjs'
import {
  deleteHandoffs, handoffPrompt, readHandoff, targetBootstrapPrompt, validateBootstrapReply, writeHandoff,
} from './handoffs.mjs'
import {
  normalizeManagedPolicy, parseManagedRunCommand, sanitizeManagedSnapshot, sanitizeRoutingSnapshot,
} from '../pi/managed-core.mjs'
import {
  CLAUDE_FAILURE_DEDUPE_MS, claudePollerDecision, prepareClaudeTerminalDelivery,
} from './claude-terminal.mjs'
import {
  nextStructuredQuestion, questionBlocks, questionFormFromPane, questionFormMatches, questionFormsFromHook,
} from './claude-question.mjs'
import {
  buildInstructionDocuments, buildInstructionPatch, deterministicWrapperPatch, fingerprintsMatch,
  inspectInstructions, instructionDocumentsPrompt, instructionProgressText, instructionProposalTimeout,
  parseInstructionDocuments,
  readInstructionProposal, sanitizedAuxiliaryEnv, validateInstructionPatch, validateInstructionResult,
  writeInstructionProposal,
} from './instructions.mjs'
import { createAutomationLifecycle, shouldFenceAutomationHook, waitForProviderInput } from './automation.mjs'
import { handleAutomationHttp } from './automation-http.mjs'
import { inviteAndResolveCollaborator, inviteAndWhitelistCollaborator } from './collaborators.mjs'
import { createTerminalControl } from './terminal-control.mjs'
import { handleTerminalHttp } from './terminal-http.mjs'
import { handleTeamHttp } from './team-http.mjs'
import { validTeamCallerBinding } from './team-auth.mjs'
import { isNestedProviderClaim } from './process-claims.mjs'
import {
  removeTeamFiles as deleteTeamFiles, removeTeamTaskFiles as deleteTeamTaskFiles,
  stageTeamFiles as stagePrivateTeamFiles, teamSourceFileMetadata,
} from './team-files.mjs'
import {
  TeamError, activeTeamForChannel, addTeamWorker, appendTeamTaskReply, assertCoordinatorDispatch, assertTeamTaskRetry,
  beginCollaboratorTeamTurn, beginOwnerTeamTurn, claimTeamTask, clearTeamTurn, closeTeam,
  completeTeamTask, consumeCoordinatorDispatch, coordinatorPromptContext, createTeam, createTeamTask,
  delegatedTaskPrompt, failTeamTask, markTeamTaskRunning, normalizeTeamAlias, publicTeamTask,
  removeTeamWorker, resolveTeamPeer, setTeamWorkerFiles, taskMarker, tasksForChannel, teamById,
  teamContext, teamTask, teamTaskDeliverySettled, teamTaskForRequest, withoutDelegatedTaskPrompt,
} from './teams.mjs'
import {
  claimContinuation, clearContinuationWaiting, coalesceContinuations, deferContinuation,
  noteContinuationWaiting, observeIdleCodexCoordinator, queueContinuation, setContinuationMode,
  settleContinuation, shouldWakeForTeamReply,
} from './team-continuation.mjs'
import { createExecutionNodeRouter, createLocalExecutionNode } from './execution-nodes.mjs'
import { LOCAL_NODE_ID, localSessionByChannel, localSessionByPid, nodeIdForSession } from './nodes.mjs'
import { createDirectSlackRuntime } from './slack-runtime.mjs'
import { createSocketModeCoordinator } from './coordinator.mjs'
import { ensureCoordinatorId } from './node-auth.mjs'
import { createNodeInvitationStore } from './node-enrollment.mjs'
import { handleNodeHttp } from './node-http.mjs'
import { createNodeManagement, NodeManagementError } from './node-management.mjs'
import { createNodeRegistry } from './node-registry.mjs'
import { readNodeListenerConfiguration } from './node-runtime.mjs'
import { createCoordinatorNodeTransport, listenForNodeConnections } from './node-transport.mjs'
import {
  bulkUpdateBlockReason, planBulkSessionUpdate, runBulkSessionUpdate,
} from './session-update.mjs'
import {
  applyHooklessCodexClaim, codexAppServerProcessPid, hooklessAuthoritativeCodexSessions,
  tmuxCodexProcessPid, waitForCodexResumeClaim,
} from './codex-resume.mjs'
import { waitForClaudeResumeClaim } from './claude-resume.mjs'
import {
  AUTOMATION_TMUX_LAUNCH_ATTEMPTS,
  AUTOMATION_TMUX_POLL_INTERVAL_MS,
  detachAutomationState,
  terminateAutomationTmux,
  validateAutomationStopTarget,
} from './automation-stop.mjs'

loadEnv()
let USER = process.env.SLACK_USER_ID // unset on fresh installs until /sab-claim
const TEAM = process.env.SLACK_TEAM_ID
const slackRuntime = createDirectSlackRuntime({
  botToken: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
})
const { web } = slackRuntime
const syncTopic = createTopicSync(web)
const artifactGrants = createArtifactGrantStore()
const state = loadState()
if (!state.perms) state.perms = {} // open permission prompts, survive daemon restarts
if (!state.whitelist) state.whitelist = {} // channel → { userId: name }: collaborators allowed to post
if (!state.channelTmux) state.channelTmux = {} // channel → tmux name last seen owning it (rebinding aid)
const executionNodes = createExecutionNodeRouter({ nodes: [createLocalExecutionNode({
  spawnSession, pidAlive, tmuxAlive, tmuxClientPids, openTmuxTerminal, closeTmuxTerminal,
})] })
const BOOT_TS = Date.now()

// Remote-node infrastructure is opt-in. Merely upgrading preserves the exact
// all-in-one runtime: no node listener, key, invitation, or state migration is
// created until an administrator uses `sab node` or configures a listener.
let nodeServices = null
let nodeListener = null
let nodeListenerConfiguration = null
function configuredNodeListener() {
  if (!nodeListenerConfiguration) nodeListenerConfiguration = readNodeListenerConfiguration(process.env)
  return nodeListenerConfiguration
}
function nodeListenerStatus() {
  const configuration = configuredNodeListener()
  return configuration.enabled
    ? { enabled: true, listening: Boolean(nodeListener), publicUrl: configuration.publicUrl }
    : { enabled: false, listening: false, publicUrl: null }
}
async function resolveNodeOperator(userId) {
  let response
  try { response = await web.users.info({ user: userId }) }
  catch (error) { throw Object.assign(new Error(error?.data?.error || 'users_info_failed'), { code: error?.data?.error || 'users_info_failed' }) }
  const user = response?.user
  if (!user || user.deleted || user.is_bot || user.is_app_user) {
    throw Object.assign(new Error('Slack user is deleted, a bot, or unavailable'), { code: 'operator_unavailable' })
  }
  return { id: user.id, name: user.profile?.display_name || user.real_name || user.name || user.id }
}
function getNodeServices() {
  if (nodeServices) return nodeServices
  if (!USER) throw new NodeManagementError('bridge_unclaimed', 'claim the bridge before managing execution nodes', 409)
  const coordinatorId = ensureCoordinatorId(state, { persist: () => saveStateNow(state) })
  let transport = null
  const registry = createNodeRegistry({
    state,
    adminUserId: USER,
    localName: os.hostname(),
    persist: () => saveStateNow(state),
    isConnected: nodeId => Boolean(transport?.connections().some(connection => connection.nodeId === nodeId)),
  })
  const invitations = createNodeInvitationStore({ state, persist: () => saveStateNow(state) })
  transport = createCoordinatorNodeTransport({
    coordinatorId,
    registry,
    invitations,
    onEnvelope: async envelope => log('ignored unsupported remote node envelope', envelope.nodeId, envelope.kind, envelope.id),
    log,
  })
  const management = createNodeManagement({
    coordinatorId,
    adminUserId: USER,
    registry,
    invitations,
    transport,
    resolveOperator: resolveNodeOperator,
    listenerStatus: nodeListenerStatus,
  })
  nodeServices = Object.freeze({ coordinatorId, invitations, management, registry, transport })
  return nodeServices
}
function getNodeManagement() {
  return getNodeServices().management
}
async function startConfiguredNodeListener() {
  const configuration = configuredNodeListener()
  if (!configuration.enabled) return
  const services = getNodeServices()
  nodeListener = await listenForNodeConnections({
    transport: services.transport,
    host: configuration.host,
    port: configuration.port,
    tls: configuration.tls,
  })
  log('execution node listener ready', configuration.publicUrl)
}

// A Codex permission request is a held HTTP response and cannot survive a daemon
// restart. Claude requests use MCP and remain recoverable only if their PID is
// still alive. Prune dead entries so status/pollers never wait on stale prompts.
const prunedPermissions = prunePermissionsOnBoot(state.perms, pidAlive)
const prunedChannelAliases = pruneSessionChannelAliases(state)
if (prunedPermissions || prunedChannelAliases) saveState(state)
if (prunedChannelAliases) log('pruned stale session channel aliases', prunedChannelAliases)

// Safety net: a single Slack API error (e.g. posting to an archived channel from
// a timer) must never crash the long-running daemon.
process.on('unhandledRejection', e => log('unhandledRejection:', e?.data?.error || e?.stack || String(e)))
process.on('uncaughtException', e => log('uncaughtException:', e?.stack || String(e)))

// pid → { res } live SSE connections from channel servers
const streams = new Map()
const piControlWaiters = new Map() // request id → bounded settings/status command resolver
const pendingSpawnChannels = new Map() // tmux → Slack channel that requested a not-yet-registered Pi spawn

// sid → texts injected from Slack, awaiting their UserPromptSubmit echo (dedup)
const injectedRecently = new Map()
function rememberInjected(sid, text) {
  const a = injectedRecently.get(sid) || []
  a.push({ text: text.trim(), at: Date.now() })
  injectedRecently.set(sid, a.slice(-10))
}
function consumeInjected(sid, prompt) {
  const a = injectedRecently.get(sid) || []
  const p = prompt.trim()
  const i = a.findIndex(x => x.text === p && Date.now() - x.at < 120000)
  if (i >= 0) { a.splice(i, 1); return true }
  return false
}
// ---- Claude Code binary: version, update, model list ------------------------
const restarting = new Set() // session ids intentionally restarting (suppress the "ended" notice)
const updatingSessions = new Set() // sessions whose provider binary/relaunch maintenance is in progress
const completedSessionStartTmux = new Map() // sid → tmux; dedupe native/synthetic start races
let bulkUpdateRunning = false
function claudeBin() {
  const local = path.join(process.env.HOME, '.local', 'bin', 'claude') // native-install symlink
  return fs.existsSync(local) ? local : 'claude'
}
async function claudeVersion() {
  try { return (await execFile(claudeBin(), ['--version'])).stdout.trim().split(/\s+/)[0] } catch { return '?' }
}
function codexBin() {
  const homebrew = '/opt/homebrew/bin/codex'
  return fs.existsSync(homebrew) ? homebrew : 'codex'
}
async function codexVersion() {
  try {
    const out = (await execFile(codexBin(), ['--version'])).stdout.trim()
    return out.match(/\b\d+\.\d+\.\d+\b/)?.[0] || out || '?'
  } catch { return '?' }
}
function piBin() {
  const homebrew = '/opt/homebrew/bin/pi'
  return fs.existsSync(homebrew) ? homebrew : 'pi'
}
async function piVersion() {
  try { return (await execFile(piBin(), ['--version'])).stdout.trim() || '?' } catch { return '?' }
}
const agentVersion = provider => provider === 'codex' ? codexVersion() : provider === 'pi' ? piVersion() : claudeVersion()
let modelCache = { key: null, list: [] }
async function getModels() {
  const bin = claudeBin()
  let key = bin; try { key = fs.realpathSync(bin) } catch {}
  if (modelCache.key === key) return modelCache.list
  const list = await availableModels(bin)
  if (list.length) modelCache = { key, list } // keyed by version path; refreshes after an update
  return list
}
let codexModelCache = null
async function getCodexModels() {
  if (codexModelCache) return codexModelCache
  try {
    const { stdout } = await execFile(codexBin(), ['debug', 'models', '--bundled'], {
      timeout: 15000, maxBuffer: 32 << 20,
    })
    const parsed = JSON.parse(stdout)
    codexModelCache = (parsed.models || []).filter(m => m.visibility !== 'hide').map(m => ({
      alias: m.slug, id: m.slug, name: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map(e => e.effort),
    }))
    return codexModelCache
  } catch (e) {
    log('codex model catalog unavailable', String(e?.message || e))
    return []
  }
}
const PERM_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---- session/channel helpers -----------------------------------------------
function sessionByPid(pid) {
  return localSessionByPid(state, pid)
}
function sessionByChannel(ch) {
  return localSessionByChannel(state, ch)
}
const switchingSids = new Set() // suppress lifecycle noise from a leg intentionally being replaced
const internalTurns = new Map() // sid → private handoff/proposal turn resolver
const targetValidationWaiters = new Map() // transition id → private target readiness resolver

function activeTransition(channel) {
  return lineageFor(state, channel)?.transition || null
}

function queueDuringTransition(channel, item) {
  const transition = activeTransition(channel)
  const position = enqueueTransitionItem(transition, item)
  saveStateNow(state)
  return position
}
// ---- collaborators: a per-channel whitelist of Slack users allowed to post ---
const nameCache = new Map()
async function resolveUserName(userId) {
  if (nameCache.has(userId)) return nameCache.get(userId)
  let name = userId
  try {
    const u = (await web.users.info({ user: userId })).user || {}
    name = u.profile?.display_name || u.real_name || u.name || userId
  } catch (e) { log('users.info failed', userId, e?.data?.error || String(e)) }
  nameCache.set(userId, name)
  return name
}
const inviteSlackCollaborator = (channel, userId) => inviteAndResolveCollaborator({
  channel,
  userId,
  invite: (target, user) => web.conversations.invite({ channel: target, users: user }),
  resolveUserName,
})
const collaborators = ch => state.whitelist[ch] || {}
const whitelistedName = (ch, userId) => collaborators(ch)[userId] || null
async function postSlackMessage(channel, payload, { waitForBump = true } = {}) {
  const result = await enqueue(channel, () => web.chat.postMessage({ channel, ...payload }))
  const reanchor = bumpStatusForChannel(channel, result?.ts)
  if (waitForBump) await reanchor
  else reanchor.catch(error => log('deferred status bump error', String(error?.message || error)))
  return result
}
function post(channel, text) {
  return postSlackMessage(channel, { text, unfurl_links: false })
}
const MAX_INLINE = 6000 // longer responses upload as a file instead of many messages
async function postMd(channel, md) {
  if (md.length > MAX_INLINE) {
    let activityTs = null
    let posted = false
    try {
      await enqueue(channel, () => web.files.uploadV2({
        channel_id: channel,
        content: md,
        filename: 'response.md',
        title: 'response.md',
        initial_comment: `📄 Long response (${md.length.toLocaleString()} chars) — attached:`,
      }))
      posted = true
    } catch (e) {
      log('file upload failed, falling back to inline', String(e))
      for (const m of mdToMessages(md)) {
        const result = await enqueue(channel, () => web.chat.postMessage({ channel, ...m, unfurl_links: false }))
        activityTs = result?.ts || activityTs
        posted = true
      }
    }
    if (posted) await bumpStatusForChannel(channel, activityTs)
    return
  }
  let activityTs = null
  for (const m of mdToMessages(md)) {
    const result = await enqueue(channel, () => web.chat.postMessage({ channel, ...m, unfurl_links: false }))
    activityTs = result?.ts || activityTs
  }
  if (activityTs) await bumpStatusForChannel(channel, activityTs)
}

// Every accepted Slack prompt receives a short-lived, one-use upload capability.
// The agent sees how to invoke it, but never gets to choose the destination:
// the daemon binds the opaque grant to this session, channel, provider, sender,
// and workspace. Unused grants expire in memory and are pruned on later use.
function artifactDeliveryContext(session, request) {
  if (!request?.userId || !session?.channel || !session?.cwd) return ''
  try {
    const { token } = artifactGrants.issue({
      sessionId: session.id,
      channelId: session.channel,
      provider: providerOf(session),
      userId: request.userId,
      messageTs: request.messageTs,
      // Stay in an existing Slack thread, but do not force ordinary channel
      // messages into newly-created threads.
      threadTs: request.threadTs,
      workspaceRoot: session.cwd,
    })
    return artifactDeliveryInstruction(token)
  } catch (error) {
    log('artifact grant unavailable', session.id.slice(0, 8), error?.code || String(error))
    return ''
  }
}

function withArtifactDelivery(session, text, request) {
  return text + artifactDeliveryContext(session, request)
}

function beginSlackTeamTurn(session, sender, request) {
  if (!session?.channel || !activeTeamForChannel(state, session.channel)) {
    clearTeamTurn(session)
    return ''
  }
  if (sender) {
    beginCollaboratorTeamTurn(session, request)
    saveStateNow(state)
    return ''
  }
  beginOwnerTeamTurn(session, request)
  saveStateNow(state)
  return coordinatorPromptContext(state, session.channel)
}

function ownerPromptPrivateContext(session, request) {
  return artifactDeliveryContext(session, request) + beginSlackTeamTurn(session, null, request)
}

const ensureSessionChannel = createSessionChannelGate()
async function createSessionChannel(session) {
  // A binding can be lost (state edited out from under the daemon, a botched
  // migration, a manual repair). Before minting a duplicate channel for a
  // terminal that already has one, reclaim it — a terminal maps to one channel.
  const prior = session.tmux && Object.entries(state.channelTmux).find(([, t]) => t === session.tmux)?.[0]
  if (prior && !sessionByChannel(prior)) {
    try {
      const info = await web.conversations.info({ channel: prior })
      if (!info.channel?.is_archived) {
        session.channel = prior
        state.channels[prior] = session.id
        saveState(state)
        log('reclaimed channel', prior, 'for', session.id.slice(0, 8), 'via terminal', session.tmux)
        await post(prior, '🔄 *Reconnected* — this channel is bound to the session again.')
        return prior
      }
    } catch (e) { log('channel reclaim check failed', e?.data?.error || String(e)) }
  }
  const { repo, branch, worktree } = await gitInfo(session.cwd)
  const name = channelName(repo, branch, worktree)
  let created
  try {
    created = await web.conversations.create({ name, is_private: true })
  } catch (e) {
    if (e?.data?.error === 'name_taken') created = await web.conversations.create({ name: name + '-' + Math.floor(Math.random() * 99), is_private: true })
    else throw e
  }
  const ch = created.channel.id
  session.channel = ch
  session.worktree = worktree
  state.channels[ch] = session.id
  saveState(state)
  try { await web.conversations.invite({ channel: ch, users: USER }) } catch {}
  await updateTopic(session)
  const provider = providerOf(session)
  await post(ch, `🟢 *Session started*\n\`${session.cwd}\`\nBranch: \`${branch || '—'}\` · Session \`${session.id.slice(0, 8)}\`` +
    (provider === 'codex' ? ` · Provider: *${providerLabel(provider)}*` : ''))
  return ch
}
const ensureChannel = session => ensureSessionChannel(session, () => createSessionChannel(session))

// Reactive channel topic: folder · branch · model · effort. The synchronizer
// hydrates Slack's existing value after daemon boot, so an unchanged restart
// does not emit a noisy conversations.setTopic event in every channel.
const lastTopicAt = new Map() // channel → last rebuild time
async function updateTopic(session) {
  if (!session.channel) return
  const meta = sessionMeta.get(session.id) || {}
  const branch = await gitBranch(session.cwd)
  // Fall back to persisted values — the in-memory meta is empty right after a
  // daemon restart, and pushing a degraded topic would wipe model/effort from
  // the channel (and the window title) until the session next reports in.
  const prettify = m => m ? String(m).replace(/^claude-/, '').replace(/-(\d)/g, ' $1').replace(/^\w/, c => c.toUpperCase()) : m
  const model = meta.model || session.model || prettify(readModel(session))
  const effort = meta.effort || session.effort
  const topic = [
    session.cwd,
    branch || 'no-branch',
    session.worktree ? 'wt:' + session.worktree : '',
    model, effort,
  ].filter(Boolean).join(' · ')
  if (session.tmux) tmuxTitle(session.tmux, topic) // window title mirrors the channel topic
  const startedAt = (Date.now() / 1000).toFixed(6)
  try {
    const changed = await syncTopic(session.channel, topic)
    if (changed) await bumpStatus(session, { afterTs: startedAt })
  }
  catch (e) { log('setTopic error', e?.data?.error || String(e)) }
}

// ---- status line (edit in place, re-anchor after newer channel activity) ----
// Slack message timestamps are immutable: an edit cannot move a status below a
// new message or topic notice. Status mutations are serialized per session; a
// bump posts the current text at the bottom, then removes the superseded copy.
const liveStatuses = createStatusMessages(web, {
  log,
  postMessage: (channel, text) => enqueue(channel, () => web.chat.postMessage({ channel, text })),
})
const setStatus = (session, text) => liveStatuses.set(session, text)
const clearStatus = session => liveStatuses.clear(session)
const bumpStatus = (session, options) => liveStatuses.bump(session, options)
async function bumpStatusForChannel(channel, afterTs = null) {
  const session = sessionByChannel(channel)
  return session ? bumpStatus(session, { afterTs }) : false
}

// ---- live status poller -----------------------------------------------------
// While a turn runs, mirror the terminal's spinner line (verb + elapsed + tokens)
// into the edit-in-place status message. Reads rendered pane output, not internals.
const pollers = new Map() // sid → { timer, last }
const claudeTerminalFailures = new Map() // sid → { key, at }; bounded duplicate suppression
function rememberClaudeTerminalFailure(sid, failure) {
  claudeTerminalFailures.set(sid, failure)
  const timer = setTimeout(() => {
    const current = claudeTerminalFailures.get(sid)
    if (current?.key === failure.key && current?.at === failure.at) claudeTerminalFailures.delete(sid)
  }, CLAUDE_FAILURE_DEDUPE_MS)
  timer.unref?.()
}
function extractSpinner(pane) {
  const lines = pane.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    // e.g. "✶ Newspapering… (8s · ↓ 487 tokens · thought for 1s)"
    const m = lines[i].match(/([A-Za-z][A-Za-z ]*…\s*\(.*?\))/)
    if (m) return '⚙️ ' + m[1].replace(/\s+/g, ' ').trim()
  }
  return null
}
// ---- interactive question forms → Slack --------------------------------------
// Structured AskUserQuestion hook input is authoritative for visible question
// text, labels, descriptions, and previews. Pane parsing remains a bounded
// fallback for restart recovery and Claude versions without structured input;
// tmux remains the answer transport in both cases.
const qforms = new Map() // sid → { ts, form, options, source, sequence, index, ... }
async function relayQuestionForm(session, form, context = {}) {
  const prev = qforms.get(session.id)
  if (prev && prev.hash === form.hash) return // unchanged screen
  if (form.planPath && prev?.planFor !== form.hash) {
    try {
      const pf = form.planPath.replace(/^~/, process.env.HOME)
      const md = fs.readFileSync(pf, 'utf8')
      await postMd(session.channel, `📋 *Claude's plan* (\`${path.basename(pf)}\`):\n\n${md}`)
    } catch (e) { log('plan relay failed', String(e?.message || e)) }
  }
  const blocks = questionBlocks(session.id, form)
  if (!blocks.length) return
  let ts = prev?.ts
  try {
    if (ts) await web.chat.update({ channel: session.channel, ts, text: '❓ Claude asks a question', blocks })
    else ts = (await postSlackMessage(session.channel, { text: '❓ Claude asks a question', blocks }, { waitForBump: false })).ts
  } catch (e) { log('qform relay error', e?.data?.error || String(e)); return }
  qforms.set(session.id, {
    ts,
    hash: form.hash,
    form,
    options: form.options,
    source: context.source || form.source || 'pane',
    sequence: context.sequence || null,
    index: Number.isInteger(context.index) ? context.index : 0,
    at: Date.now(),
    planFor: form.planPath ? form.hash : prev?.planFor,
  })
  log('qform relayed', session.id.slice(0, 8), JSON.stringify(form.question.slice(0, 60)))
}
async function answerQuestionForm(session, n, label) {
  const q = qforms.get(session.id)
  await execFile('tmux', ['send-keys', '-t', session.tmux, String(n)]) // digit selects + advances
  if (q) {
    if (q.form?.multiSelect) {
      q.at = Date.now()
      log('qform option toggled', session.id.slice(0, 8), n, JSON.stringify(label.slice(0, 50)))
      return
    }
    q.hash = 'answered:' + Date.now() // next screen (if any) updates the same message
    q.answeredAt = Date.now()
    try { await web.chat.update({ channel: session.channel, ts: q.ts, text: `✅ ${label}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `❓ → ✅ *${escapeText(label)}*` } }] }) } catch {}
    const next = nextStructuredQuestion(q)
    if (next) {
      await sleep(350)
      await relayQuestionForm(session, next.form, {
        source: 'structured', sequence: q.sequence, index: next.index,
      })
    }
  }
  log('qform answered', session.id.slice(0, 8), n, JSON.stringify(label.slice(0, 50)))
}
async function clearQuestionForm(session) {
  const q = providerOf(session) === 'claude' ? qforms.get(session.id) : null
  if (!q) return
  qforms.delete(session.id)
  try { await web.chat.update({ channel: session.channel, ts: q.ts, text: '✅ Question answered', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '❓ → ✅ _answered — the turn continues_' } }] }) } catch {}
}

function startPoller(session) {
  if (pollers.has(session.id)) return
  const p = { timer: null, last: '', stopped: false, sawSpinner: false, idle: 0 }
  p.timer = setInterval(async () => {
    if (p.stopped || !session.tmux || !(session.pid && pidAlive(session.pid))) return
    const pane = await tmuxCapture(session.tmux)
    const line = extractSpinner(pane)
    if (p.stopped) return // Stop fired during the capture — don't re-post
    const paneForm = line ? null : questionFormFromPane(pane)
    const openForm = qforms.get(session.id)
    let form = paneForm
    let formContext = {}
    let holdAnsweredForm = false
    if (!line && openForm?.source === 'structured') {
      if (!openForm.answeredAt) {
        if (!paneForm || questionFormMatches(openForm.form, paneForm)) {
          form = openForm.form
          formContext = { source: 'structured', sequence: openForm.sequence, index: openForm.index }
        } else if (Array.isArray(openForm.sequence)) {
          const nextIndex = openForm.sequence.findIndex((candidate, index) =>
            index > openForm.index && questionFormMatches(candidate, paneForm))
          if (nextIndex >= 0) {
            form = openForm.sequence[nextIndex]
            formContext = { source: 'structured', sequence: openForm.sequence, index: nextIndex }
          }
        }
      } else if (Date.now() - openForm.answeredAt < 4000 &&
          (!paneForm || questionFormMatches(openForm.form, paneForm))) {
        // The selected screen can remain painted briefly after tmux receives
        // the digit. Do not replace the semantic form with that stale pane.
        form = null
        holdAnsweredForm = true
      }
    }
    // Login expiry and provider overload can finish before the 3-second poller
    // ever observes a spinner, and Claude emits no Stop for either. Inspect only
    // NEW transcript records so stale errors in terminal scrollback cannot end a
    // later healthy turn.
    const newAssistantText = line ? '' : peekNewAssistantText(session)
    const decision = claudePollerDecision({
      spinner: Boolean(line), newAssistantText, hasForm: Boolean(form) || holdAnsweredForm,
      sawSpinner: p.sawSpinner, idleTicks: p.idle,
      pendingPermission: hasPendingPerm(session),
    })
    p.idle = decision.idleTicks
    if (decision.action === 'working') {
      p.sawSpinner = true
      if (qforms.has(session.id)) await clearQuestionForm(session) // answered (Slack or terminal) — turn resumed
      if (line !== p.last) { p.last = line; await setStatus(session, line) }
      return
    }
    if (decision.action === 'form') {
      if (form) await relayQuestionForm(session, form, formContext)
      return // waiting on the user, not finished
    }
    if (decision.action === 'failure') {
      p.stopped = true
      log('poller failure finalize (Stop hook missing)', session.id.slice(0, 8), decision.failure.key)
      await finalizeTurn(session, { terminalFailure: decision.failure })
      return
    }
    if (decision.action === 'finalize') {
      // The spinner vanished for ~12s after a turn was running: the turn ended.
      // Normally the Stop hook finalizes; if it never arrives (a missed hook, or a
      // long/compacted turn), do it here so the response is never silently lost.
      p.stopped = true
      log('poller finalize (Stop hook missing)', session.id.slice(0, 8))
      await finalizeTurn(session)
    }
  }, 3000)
  pollers.set(session.id, p)
}

// Codex does not expose Claude's whimsical spinner metadata through hooks.
// Build a stable equivalent from hook timing plus ccusage's maintained Codex
// adapter. The expensive transcript scan is bounded to once every 12 seconds;
// the Slack timer continues to update every 3 seconds in the same message.
const codexPollers = new Map() // sid → { timer, baseline, current, ... }
const CODEX_USAGE_REFRESH_MS = 12000

async function codexUsageForSession(session) {
  const report = await ccusageJson('codex', 'session', ['--offline', '--no-cost'])
  return codexTokenSnapshot(codexSessionUsage(report, session.id))
}

function startCodexPoller(session) {
  if (codexPollers.has(session.id)) return
  const p = {
    timer: null,
    stopped: false,
    running: false,
    last: '',
    nextUsageAt: 0,
    baseline: codexTokenSnapshot(session.codexUsageBaseline),
    current: null,
    failureKey: null,
    failureConfirmations: 0,
    turnStartedAt: session.codexTurnStartedAt,
  }
  const tick = async () => {
    if (p.stopped || p.running || !(session.pid && pidAlive(session.pid))) return
    p.running = true
    try {
      const now = Date.now()
      const pane = session.tmux ? await tmuxCapture(session.tmux) : ''
      if (p.stopped) return
      const failureDecision = codexTerminalFailureDecision({
        pane,
        ready: targetStartupState('codex', pane) === 'ready',
        previousKey: p.failureKey,
        confirmations: p.failureConfirmations,
      })
      p.failureKey = failureDecision.key
      p.failureConfirmations = failureDecision.confirmations
      if (failureDecision.action === 'failure') {
        p.stopped = true
        log('Codex terminal failure finalize (Stop hook missing)', session.id.slice(0, 8), failureDecision.failure.key)
        await finalizeCodexTerminalFailure(session, failureDecision.failure, p.turnStartedAt)
        return
      }
      if (now >= p.nextUsageAt) {
        p.nextUsageAt = now + CODEX_USAGE_REFRESH_MS
        try {
          p.current = await codexUsageForSession(session)
          if (p.stopped) return
          if (!p.baseline) {
            // A brand-new session has no ccusage row yet. Zero is the correct
            // baseline there, so its first completed model call still appears
            // as first-turn usage instead of being swallowed as initialization.
            p.baseline = p.current || codexTokenSnapshot({})
            session.codexUsageBaseline = p.baseline
            saveState(state)
          }
        } catch (e) { log('Codex live usage unavailable', String(e?.message || e)) }
      }
      if (p.stopped) return
      const text = formatCodexWorkingStatus({
        startedAt: session.codexTurnStartedAt,
        baseline: p.baseline,
        current: p.current,
        now,
      })
      if (text !== p.last) { p.last = text; await setStatus(session, text) }
    } finally { p.running = false }
  }
  p.timer = setInterval(() => tick().catch(e => log('Codex status poller error', String(e))), 3000)
  codexPollers.set(session.id, p)
  tick().catch(e => log('Codex status poller error', String(e)))
}

function beginCodexTurn(session) {
  stopPoller(session)
  session.codexTurnStartedAt = Date.now()
  delete session.codexUsageBaseline
  saveState(state)
  startCodexPoller(session)
}

const piPollers = new Map()
function startPiPoller(session) {
  if (piPollers.has(session.id)) return
  const p = { timer: null, stopped: false, last: '' }
  const tick = async () => {
    if (p.stopped || !(session.pid && pidAlive(session.pid))) return
    const text = formatPiWorkingStatus({
      startedAt: session.managed?.status === 'active' ? session.managed.startedAt
        : session.piRouting?.status === 'routing' ? session.piRouting.startedAt
          : session.piTurnStartedAt,
      usage: normalizePiUsage(session.piTurnUsage, session.piContextUsage),
      managed: session.managed?.status === 'active' ? session.managed : null,
      routing: session.piRouting?.status === 'routing' ? session.piRouting : null,
    })
    if (text !== p.last) { p.last = text; await setStatus(session, text) }
  }
  p.timer = setInterval(() => tick().catch(error => log('Pi status poller error', String(error))), 3000)
  piPollers.set(session.id, p)
  tick().catch(error => log('Pi status poller error', String(error)))
}

function beginPiTurn(session) {
  stopPoller(session)
  session.piTurnStartedAt = Date.now()
  session.piTurnUsage = null
  saveState(state)
  startPiPoller(session)
}

function stopPoller(session) {
  const p = pollers.get(session.id)
  if (p) { p.stopped = true; clearInterval(p.timer); pollers.delete(session.id) }
  const codex = codexPollers.get(session.id)
  if (codex) { codex.stopped = true; clearInterval(codex.timer); codexPollers.delete(session.id) }
  const pi = piPollers.get(session.id)
  if (pi) { pi.stopped = true; clearInterval(pi.timer); piPollers.delete(session.id) }
  if (session.codexTurnStartedAt || session.codexUsageBaseline) {
    delete session.codexTurnStartedAt
    delete session.codexUsageBaseline
    saveState(state)
  }
  if (session.piTurnStartedAt) {
    delete session.piTurnStartedAt
    saveState(state)
  }
}
const hasPendingPerm = session => Object.values(state.perms).some(p => p.channel === session.channel)
// Mirror a turn's final assistant text and clear its live status. Called by the
// Stop hook and, as a fallback, by the poller when a turn ends without a Stop.
// Idempotent: readNewAssistantText advances the read offset, so a second caller
// (whichever of Stop / poller runs later) reads nothing and posts nothing.
async function finalizeTurn(session, { terminalFailure = null } = {}) {
  stopPoller(session)
  await clearStatus(session)
  await clearQuestionForm(session)
  if (session.transcript) await waitTranscriptSettle(session.transcript)
  const rawText = readNewAssistantText(session)
  const delivery = prepareClaudeTerminalDelivery(
    rawText || terminalFailure?.text || '',
    claudeTerminalFailures.get(session.id),
  )
  if (delivery.failure) rememberClaudeTerminalFailure(session.id, delivery.failure)
  else if (delivery.text) claudeTerminalFailures.delete(session.id) // a successful answer resets suppression
  if (delivery.text && !delivery.suppress) await postMd(session.channel, delivery.text)
  else if (delivery.suppress) log('suppressed duplicate Claude terminal failure', session.id.slice(0, 8), delivery.failure?.key)
  const taskFailure = terminalFailure
    ? String(terminalFailure.text || 'The worker turn failed in the terminal.').slice(0, 2000)
    : delivery.failure?.text || null
  await finishTeamTaskForSession(session, delivery.text, taskFailure)
  clearTeamInputReservation(session)
  saveState(state)
  // Plan-approval (and similar) dialogs render AFTER the Stop hook, when no
  // poller is watching — check once, shortly after, and hand off to a poller.
  setTimeout(async () => {
    try {
      if (!(session.pid && pidAlive(session.pid) && session.tmux && (await tmuxAlive(session.tmux)))) return
      const form = questionFormFromPane(await tmuxCapture(session.tmux))
      if (form) { await relayQuestionForm(session, form); startPoller(session) }
    } catch (e) { log('post-stop form check failed', String(e?.message || e)) }
  }, 5000)
}

// Codex exposes the stable final assistant text directly on Stop. Its JSONL
// transcript is explicitly not a stable hook interface, so never parse it.
async function finalizeCodexTurn(session, body) {
  stopPoller(session)
  await clearStatus(session)
  const turnId = body.turn_id || null
  if (turnId && session.lastMirroredTurn === turnId) return
  const text = String(body.last_assistant_message || '').trim()
  if (text && session.channel) await postMd(session.channel, text)
  await finishTeamTaskForSession(session, text)
  clearTeamInputReservation(session)
  if (turnId) session.lastMirroredTurn = turnId
  saveState(state)
}

async function finalizeCodexTerminalFailure(session, failure, expectedStartedAt) {
  // Claim only the turn observed by this poller. A newer UserPromptSubmit may
  // already have replaced it while tmux capture or Slack I/O was in flight.
  if (!expectedStartedAt || session.codexTurnStartedAt !== expectedStartedAt) return false
  stopPoller(session)
  await clearStatus(session)
  const text = String(failure?.text || 'Codex could not start this turn.').slice(0, 2000)
  if (session.channel) await postMd(session.channel, `⚠️ *Codex turn failed:* ${text}`)
  await finishTeamTaskForSession(session, '', text)
  clearTeamInputReservation(session)
  saveState(state)
  return true
}

async function finalizePiTurn(session, body) {
  stopPoller(session)
  await clearStatus(session)
  const turnId = body.turn_id || null
  if (turnId && session.lastMirroredTurn === turnId) return
  const text = String(body.last_assistant_message || '').trim()
  if (text && session.channel) await postMd(session.channel, text)
  await finishTeamTaskForSession(session, text)
  clearTeamInputReservation(session)
  recordPiUsage(session, body)
  if (turnId) session.lastMirroredTurn = turnId
  saveState(state)
}

function recordPiUsage(session, body) {
  const usage = normalizePiUsage(body.usage, body.context_usage)
  if (usage) {
    session.piUsage = usage
    state.piUsage ||= []
    state.piUsage.push({
      at: Date.now(), sessionId: session.id, cwd: session.cwd,
      model: session.model || 'unknown', ...usage,
    })
    if (state.piUsage.length > 10000) state.piUsage.splice(0, state.piUsage.length - 10000)
  }
}

// Recover live status after a daemon restart. The poller and each status
// message's ts live only in memory, so a restart mid-turn freezes the status —
// the daemon can neither update it nor, on Stop, clear it. On boot we re-adopt:
// if a live session still shows a spinner, find its frozen status message and
// resume the poller on it; if the turn already ended, delete the stale message.
async function findStatusContext(channel) {
  if (!channel) return { statusMessage: null, latestPromptTs: null }
  try {
    const r = await web.conversations.history({ channel, limit: 15 })
    // Slack returns the emoji as its :gear: shortcode in `text`, not the literal ⚙️.
    const messages = r.messages || []
    const statusMessage = messages.find(m => typeof m.text === 'string' && /^(:gear:|⚙️)/.test(m.text)) || null
    const latestPrompt = messages.find(m => !m.subtype && m.user &&
      (m.user === USER || whitelistedName(channel, m.user)))
    return { statusMessage, latestPromptTs: latestPrompt?.ts || null }
  } catch (e) {
    log('findStatusContext error', e?.data?.error || String(e))
    return { statusMessage: null, latestPromptTs: null }
  }
}
async function readoptStatus() {
  for (const s of Object.values(state.sessions)) {
    if (!(s.pid && pidAlive(s.pid) && s.tmux && (await tmuxAlive(s.tmux)))) {
      const abandonedInput = clearTeamInputReservation(s)
      if (abandonedInput && !s.teamActiveTaskId && s.channel) {
        await post(s.channel,
          '⚠️ The bridge restarted before a queued input reached this dormant provider. It was not retried; please resend it.').catch(() => {})
      }
      continue
    }
    if (providerOf(s) === 'pi') {
      const { statusMessage } = await findStatusContext(s.channel)
      const ts = statusMessage?.ts || null
      if (s.piTurnStartedAt) {
        if (ts) liveStatuses.adopt(s.id, ts)
        startPiPoller(s)
        log('re-adopted live Pi turn', s.id.slice(0, 8), ts ? '(resumed status)' : '(fresh status)')
      } else if (ts) {
        try { await web.chat.delete({ channel: s.channel, ts }) } catch {}
      }
      if (!s.piTurnStartedAt) clearTeamInputReservation(s)
      continue
    }
    if (providerOf(s) === 'codex') {
      const context = await findStatusContext(s.channel)
      const ts = context.statusMessage?.ts || null
      const pane = await tmuxCapture(s.tmux)
      const terminalFailure = targetStartupState('codex', pane) === 'ready'
        ? codexTerminalFailure(pane)
        : null
      if (terminalFailure && (s.codexTurnStartedAt || ts)) {
        if (!s.codexTurnStartedAt) {
          s.codexTurnStartedAt = recoverCodexTurnStartedAt({
            statusMessage: context.statusMessage,
            latestPromptTs: context.latestPromptTs,
          })
        }
        if (ts) liveStatuses.adopt(s.id, ts)
        await finalizeCodexTerminalFailure(s, terminalFailure, s.codexTurnStartedAt)
        log('recovered Codex terminal failure', s.id.slice(0, 8), terminalFailure.key)
        continue
      }
      const recovery = codexStatusRecoveryDecision(s, pane)
      if (recovery === 'resume') {
        if (!s.codexTurnStartedAt) {
          s.codexTurnStartedAt = recoverCodexTurnStartedAt({
            persistedStartedAt: s.codexTurnStartedAt,
            statusMessage: context.statusMessage,
            latestPromptTs: context.latestPromptTs,
          })
          saveState(state)
          log('reconstructed live Codex turn start', s.id.slice(0, 8), new Date(s.codexTurnStartedAt).toISOString())
        }
        if (ts) liveStatuses.adopt(s.id, ts)
        startCodexPoller(s)
        if (s.teamActiveTaskId) teamTurnProof.add(s.id)
        log('re-adopted live Codex turn', s.id.slice(0, 8), ts ? '(resumed status)' : '(fresh status)')
      } else {
        const hadTurnState = !!s.codexTurnStartedAt
        if (ts) liveStatuses.adopt(s.id, ts)
        stopPoller(s)
        await clearStatus(s)
        clearTeamInputReservation(s)
        if (ts || hadTurnState) log('cleared stale Codex turn status', s.id.slice(0, 8))
      }
      continue
    }
    // The pane grammar below remains Claude-specific. Codex re-adoption above
    // uses only persisted hook state and ccusage, not terminal or JSONL parsing.
    const pane = await tmuxCapture(s.tmux)
    const spinning = !!extractSpinner(pane)
    const waitingForm = !spinning && !!questionFormFromPane(pane)
    const { statusMessage } = await findStatusContext(s.channel)
    const ts = statusMessage?.ts || null
    if (waitingForm) {
      startPoller(s) // poller relays the form and manages the answer
      if (s.teamActiveTaskId) teamTurnProof.add(s.id)
      log('re-adopted session waiting at a question form', s.id.slice(0, 8))
    } else if (spinning) {
      if (ts) liveStatuses.adopt(s.id, ts) // resume editing the existing (frozen) message
      startPoller(s)
      if (s.teamActiveTaskId) teamTurnProof.add(s.id)
      log('re-adopted live turn', s.id.slice(0, 8), ts ? '(resumed status)' : '(fresh status)')
    } else {
      // Idle: nothing to mirror. Re-anchor the read offset to EOF so a stale or
      // lost offset from before the restart doesn't strand mirroring behind, and
      // clear any status left frozen by the restart.
      try { const sz = fs.statSync(s.transcript).size; if (Number.isFinite(sz) && sz !== s.offset) { s.offset = sz; log('re-anchored idle session', s.id.slice(0, 8), 'offset→EOF') } } catch {}
      if (ts) { try { await web.chat.delete({ channel: s.channel, ts }) } catch {} }
      clearTeamInputReservation(s)
    }
  }
  saveState(state)
}

// System-injected prompts (task notifications, reminders, local-command echoes)
// arrive via UserPromptSubmit but aren't genuine typing — don't mirror them.
function isSystemPrompt(p) {
  return /SYSTEM NOTIFICATION|task-notification|<system-reminder>|<command-name>|<local-command|Caveat: The messages below/i.test(p)
}

// ---- transcript mirroring ---------------------------------------------------
// The Stop hook can fire a beat before Claude flushes its final assistant text
// to the transcript. onHook runs AFTER the hook returns "ok" (TUI never waits),
// so we can settle-wait on the file size before reading.
async function waitTranscriptSettle(file, maxMs = 4000) {
  let last = -1, stable = 0
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    let size = 0
    try { size = fs.statSync(file).size } catch {}
    if (size === last) { if (++stable >= 2) return }
    else { stable = 0; last = size }
    await sleep(150)
  }
}

// Reads assistant text written since session.offset. Only COMPLETE lines are
// parsed, so a record being flushed is never cut in half. Poller failure
// detection peeks without advancing; final delivery advances atomically.
function assistantTextSinceOffset(session, advance = false) {
  if (providerOf(session) !== 'claude') return ''
  const f = session.transcript
  if (!f || !fs.existsSync(f)) return ''
  const size = fs.statSync(f).size
  const from = session.offset || 0
  if (size <= from) return ''
  const fd = fs.openSync(f, 'r')
  const buf = Buffer.alloc(size - from)
  fs.readSync(fd, buf, 0, buf.length, from)
  fs.closeSync(fd)
  const str = buf.toString('utf8')
  const lastNl = str.lastIndexOf('\n')
  if (lastNl < 0) return '' // no complete line yet; wait for more
  if (advance) session.offset = from + Buffer.byteLength(str.slice(0, lastNl + 1), 'utf8')
  const out = []
  for (const line of str.slice(0, lastNl).split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type !== 'assistant' || !rec.message?.content) continue
    for (const c of rec.message.content) {
      if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim())
    }
  }
  return out.join('\n\n')
}

const peekNewAssistantText = session => assistantTextSinceOffset(session, false)
const readNewAssistantText = session => assistantTextSinceOffset(session, true)

async function privateAssistantText(session, body = {}) {
  stopPoller(session)
  await clearStatus(session)
  await clearQuestionForm(session)
  if (providerOf(session) === 'codex' || providerOf(session) === 'pi') {
    const turnId = body.turn_id || null
    if (providerOf(session) === 'pi') recordPiUsage(session, body)
    if (turnId) session.lastMirroredTurn = turnId
    return String(body.last_assistant_message || '').trim()
  }
  if (session.transcript) await waitTranscriptSettle(session.transcript)
  return readNewAssistantText(session).trim()
}

async function completePrivateTurn(session, body, targetClaim = null) {
  const direct = internalTurns.get(session.id)
  const target = targetClaim && targetValidationWaiters.get(targetClaim.transition.id)
  const waiter = direct || target
  if (!waiter) return false
  const text = await privateAssistantText(session, body)
  if (direct) internalTurns.delete(session.id)
  else targetValidationWaiters.delete(targetClaim.transition.id)
  clearTimeout(waiter.timer)
  waiter.resolve(text)
  saveState(state)
  return true
}

function failPrivateTurn(session, error, targetClaim = null) {
  const direct = internalTurns.get(session.id)
  const target = targetClaim && targetValidationWaiters.get(targetClaim.transition.id)
  const waiter = direct || target
  if (!waiter) return false
  if (direct) internalTurns.delete(session.id)
  else targetValidationWaiters.delete(targetClaim.transition.id)
  clearTimeout(waiter.timer)
  waiter.reject(error instanceof Error ? error : new Error(String(error)))
  return true
}

// ---- hook handling ----------------------------------------------------------
// A session's tmux claim is only trusted if the claiming claude process really
// lives inside that tmux (its pid descends from one of the session's panes).
// Inherited CCS_TMUX env leaks made new sessions claim ANOTHER session's tmux,
// so their Slack messages were pasted into the wrong terminal. Cached per
// pid+name — one validation per session lifetime in practice.
const tmuxClaimCache = new Map()
async function validTmuxClaim(pid, tname) {
  if (!tname) return false
  const key = pid + ':' + tname
  if (tmuxClaimCache.has(key)) return tmuxClaimCache.get(key)
  let ok = false
  try {
    const panePids = (await execFile('tmux', ['list-panes', '-t', tname, '-F', '#{pane_pid}']))
      .stdout.split('\n').filter(Boolean).map(Number)
    let p = Number(pid)
    for (let i = 0; i < 12 && p > 1 && !ok; i++) {
      if (panePids.includes(p)) ok = true
      else p = Number((await execFile('ps', ['-o', 'ppid=', '-p', String(p)])).stdout.trim()) || 0
    }
  } catch { ok = false } // tmux session doesn't exist → claim invalid
  tmuxClaimCache.set(key, ok)
  if (!ok) log('rejected tmux claim', tname, 'by pid', pid)
  return ok
}

const providerRootClaimCache = new Map()
async function validProviderRootClaim(pid, tname, provider) {
  const key = `${pid}:${tname}:${provider}`
  if (providerRootClaimCache.has(key)) return providerRootClaimCache.get(key)
  if (!(await validTmuxClaim(pid, tname))) return false
  let panePids = []
  const processes = []
  try {
    panePids = (await execFile('tmux', ['list-panes', '-t', tname, '-F', '#{pane_pid}']))
      .stdout.split('\n').filter(Boolean).map(Number)
    let current = Number(pid)
    for (let hop = 0; hop < 16 && current > 1; hop++) {
      const [parentResult, commResult] = await Promise.all([
        execFile('ps', ['-o', 'ppid=', '-p', String(current)]),
        execFile('ps', ['-o', 'comm=', '-p', String(current)]),
      ])
      const parent = Number(parentResult.stdout.trim()) || 0
      processes.push({ pid: current, ppid: parent, comm: commResult.stdout.trim() })
      if (!parent || panePids.includes(current) || panePids.includes(parent)) break
      current = parent
    }
  } catch {
    providerRootClaimCache.set(key, false)
    return false
  }
  const valid = !isNestedProviderClaim(processes, pid, panePids, provider)
  providerRootClaimCache.set(key, valid)
  if (!valid) log('rejected nested provider claim', provider, pid, tname)
  return valid
}

async function reportCodexModelMismatch(session) {
  if (!session?.channel || providerOf(session) !== 'codex') return
  const actualEffort = sessionMeta.get(session.id)?.effort || session.effort
  const modelMismatch = session.requestedModel && session.model && session.requestedModel !== session.model
  const effortMismatch = session.requestedEffort && actualEffort && session.requestedEffort !== actualEffort
  if (modelMismatch || effortMismatch) {
    const mismatch = `${session.requestedModel || session.model}->${session.model || 'unknown'} / ${session.requestedEffort || actualEffort || 'unknown'}->${actualEffort || 'unknown'}`
    if (session.modelMismatch === mismatch) return
    session.modelMismatch = mismatch
    saveStateNow(state)
    await updateTopic(session)
    await post(session.channel, `⚠️ Codex started with *${session.model || 'unknown'}* / *${actualEffort || 'unknown'}* although ` +
      `*${session.requestedModel || 'unknown'}* / *${session.requestedEffort || 'unknown'}* was requested. ` +
      'Work is not considered compliant; update/restart this exact session when the requested settings are available.')
  } else if (session.modelMismatch) {
    delete session.modelMismatch
    saveStateNow(state)
  }
}

async function completeAuthoritativeSessionStart(session, provider, source) {
  const sid = session.id
  const tmux = session.tmux || ''
  if (completedSessionStartTmux.get(sid) === tmux) return false
  completedSessionStartTmux.set(sid, tmux)
  try {
    pendingSpawnChannels.delete(tmux)
    const ch = await ensureChannel(session)
    await updateTopic(session) // existing channels also need fresh SessionStart metadata
    if (source === 'resume') await post(ch, '▶️ *Resumed*')
    else if (source === 'clear') await post(ch, '🧹 *Context cleared* — same channel, fresh session')
    if (provider === 'codex') await reportCodexModelMismatch(session)
    automationLifecycle.correlateSessionStart(session)

    // Flush messages queued during resurrection. The completion claim above is
    // synchronous, so a native SessionStart racing a process-tree fallback can
    // never paste these messages twice.
    const queued = pendingBySid.get(sid) || []
    if (queued.length && tmux) {
      pendingBySid.set(sid, [])
      setTimeout(async () => {
        for (const m of queued) {
          rememberInjected(sid, queuedPromptText(m))
          if (provider === 'pi') {
            if (!injectQueuedPiPrompt(session.pid, m)) log('Pi flush stream unavailable', sid.slice(0, 8))
          } else await tmuxPaste(tmux, m).catch(e => log('flush paste failed', String(e)))
          await sleep(500)
        }
      }, 2000)
    }
    return true
  } catch (error) {
    if (completedSessionStartTmux.get(sid) === tmux) completedSessionStartTmux.delete(sid)
    throw error
  }
}

async function onHook(body, ppid, tmux, flags, account, requestedProvider = 'claude') {
  const provider = normalizeProvider(requestedProvider)
  if (!provider) return
  const ev = body.hook_event_name
  const sid = body.session_id
  if (!sid) return
  const pid = await resolveAgentPid(ppid, provider)
  if (!pid) return
  const requestedTmux = tmux
  if (requestedTmux && abandonedResumeTmux.has(requestedTmux)) {
    log('ignored hook from abandoned resume', ev, String(sid || '').slice(0, 8), requestedTmux)
    return
  }
  if (tmux && !(await validProviderRootClaim(pid, tmux, provider))) return
  const automationHook = automationLifecycle.findForHook(provider, sid, requestedTmux)
  if (shouldFenceAutomationHook(automationHook, requestedTmux)) {
    log('ignored hook from stopped automation', ev, String(sid).slice(0, 8), automationHook.externalKey)
    return
  }
  const targetClaim = transitionForTarget(state, provider, tmux)
  if (targetClaim?.transition.target.sid && targetClaim.transition.target.sid !== sid) {
    log('rejected switch target session mismatch', String(sid).slice(0, 8), 'expected', targetClaim.transition.target.sid.slice(0, 8))
    return
  }

  let session = state.sessions[sid] || sessionByPid(pid)
  if (!session && provider === 'pi' && ev !== 'SessionStart') {
    log('ignored pre-start Pi event', ev, String(sid).slice(0, 8))
    return
  }
  if (session && isSupersededHook(ev, session.pid, pid)) {
    log('ignored hook from superseded pid', ev, pid, 'current', session.pid, String(sid).slice(0, 8))
    return
  }
  if (session && providerOf(session) !== provider) {
    log('rejected cross-provider session collision', String(sid).slice(0, 8), provider)
    return
  }
  if (session && provider === 'pi' && restarting.has(sid) && ev !== 'SessionStart') {
    log('ignored trailing Pi event during restart', ev, String(sid).slice(0, 8))
    return
  }
  if (!session) {
    // Claude Code 2.1.220+ spawns internal background workers — a transient
    // per-user daemon, warm "spare" sessions, and background agents — which
    // inherit CCS_BRIDGE and the global hooks from their parent session. They
    // are not user terminals: registering them creates ghost channels. Gate NEW
    // registrations on the resolved process's command line.
    if (provider === 'claude') {
      let cmdline = ''
      try { cmdline = (await execFile('ps', ['-o', 'command=', '-p', String(pid)])).stdout } catch {}
      if (/--agent |bg-pty-host|bg-spare|daemon run|--session-id/.test(cmdline)) {
        log('ignoring internal claude worker', sid.slice(0, 8), 'pid', pid)
        return
      }
    }
    // Adopt at the transcript's current end. A session the daemon has never seen
    // may carry a long pre-bridge history (e.g. resuming an old session into a
    // new channel); an offset of 0 would replay ALL of it into Slack on the
    // first turn. Anchoring to EOF mirrors only from adoption onward. Brand-new
    // sessions have an empty/absent transcript, so this stays 0 for them.
    let tail = 0
    if (provider === 'claude') { try { tail = fs.statSync(body.transcript_path).size } catch {} }
    session = { id: sid, pid, cwd: body.cwd, tmux, transcript: body.transcript_path, offset: tail, channel: null, statusTs: null }
    if (provider !== 'claude') session.provider = provider
    state.sessions[sid] = session
  }
  // Keep identity fresh (handles /clear: same pid, new sid). This path REBRANDS an
  // existing session record, so it must not be reachable by a stray hook: a payload
  // whose pid merely resolves to some live claude could otherwise steal that
  // session's channel and orphan it. Require the payload's own transcript to belong
  // to the new id, and require the same terminal.
  if (session.id !== sid) {
    const priorSid = session.id
    const transcriptMatches = provider !== 'claude' || !body.transcript_path || path.basename(body.transcript_path, '.jsonl') === sid
    const sameTerminal = !tmux || !session.tmux || tmux === session.tmux
    if (!transcriptMatches || !sameTerminal) {
      log('rejected identity takeover of', session.id.slice(0, 8), 'by', String(sid).slice(0, 8),
        `(transcript=${transcriptMatches}, sameTerminal=${sameTerminal})`)
      return
    }
    if (session.teamActiveTaskId) {
      await failTeamTaskForSession(session,
        'The worker native session identity changed before the delegated task completed.')
    }
    delete state.sessions[session.id]
    if (session.channel) state.channels[session.channel] = sid
    rebindLineageSession(state, priorSid, sid, provider)
    if (internalTurns.has(priorSid)) {
      internalTurns.set(sid, internalTurns.get(priorSid)); internalTurns.delete(priorSid)
    }
    session.id = sid
    session.offset = 0
    state.sessions[sid] = session
  }
  session.pid = pid
  session.tmux = tmux || session.tmux
  if (session.channel && session.tmux) state.channelTmux[session.channel] = session.tmux
  // Heal stored claims too (a poisoned name may have been recorded before the guard).
  if (session.tmux && !tmux && !(await validTmuxClaim(pid, session.tmux))) session.tmux = null
  session.cwd = body.cwd || session.cwd
  session.transcript = body.transcript_path || session.transcript
  if (provider === 'codex' && body.model && (ev === 'SessionStart' || !restarting.has(sid))) {
    session.model = body.model
    sessionMeta.set(session.id, { ...(sessionMeta.get(session.id) || {}), model: body.model })
  }
  const previousManagedId = session.managed?.id || null
  if (provider === 'pi') {
    if (body.model) session.model = body.model
    if (body.model_name) session.modelName = body.model_name
    if (Array.isArray(body.model_input)) session.modelInput = body.model_input
    if (body.effort) session.effort = body.effort
    if (body.context_usage) session.piContextUsage = body.context_usage
    if (body.usage) session.piTurnUsage = body.usage
    if (body.managed !== undefined) session.managed = sanitizeManagedSnapshot(body.managed)
    if (body.managed_policy !== undefined) session.managedPolicy = normalizeManagedPolicy(body.managed_policy)
    if (body.routing !== undefined) session.piRouting = sanitizeRoutingSnapshot(body.routing)
    sessionMeta.set(session.id, {
      ...(sessionMeta.get(session.id) || {}),
      model: session.modelName || session.model,
      effort: session.effort,
      ctxPct: body.context_usage?.percent,
    })
  }
  // During a bridge-initiated restart, the old process may emit trailing hooks
  // after the desired settings were persisted. Never let one roll them back;
  // the replacement SessionStart is allowed to confirm its actual launch values.
  const acceptSettings = acceptHookSettings(ev, restarting.has(sid))
  if (acceptSettings && flags != null && flags !== '') {
    session.launchFlags = provider === 'codex' ? codexFlagsWithoutInitialPrompt(flags, sid) : flags
    if (provider === 'codex') {
      // Requested settings are operator intent and immutable once captured.
      // A provider hook may report a capacity fallback or stale replacement
      // flags; never let that overwrite the settings used to launch the leg.
      if (!session.requestedModel) session.requestedModel = codexModelFromArgs(session.launchFlags) || session.requestedModel
      if (!session.requestedEffort) session.requestedEffort = resolveCodexEffort({ launchFlags: session.launchFlags, cwd: session.cwd }) || session.requestedEffort
    }
  }
  if (provider === 'codex' && ev === 'SessionStart') {
    const effort = resolveCodexEffort({ launchFlags: session.launchFlags, cwd: session.cwd })
    if (effort) session.effort = effort
  }
  const acct = provider === 'claude' ? safeAccount(account) : null
  if (acceptSettings && acct && session.account !== acct) session.account = acct // which subscription pays for this session
  if (targetClaim) {
    targetClaim.transition.target.sid = sid
    targetClaim.transition.target.startedAt = targetClaim.transition.target.startedAt || Date.now()
    targetClaim.lineage.legs[provider] = sid
    saveStateNow(state)
  } else saveState(state)

  // An idle Codex resume may be adopted without SessionStart. Its first later
  // hook is therefore also a valid point to surface an actual/requested model
  // mismatch, using the same durable dedupe as the normal startup path.
  if (provider === 'codex' && body.model && session.channel && !targetClaim && ev !== 'SessionStart') {
    await reportCodexModelMismatch(session).catch(error =>
      log('Codex model mismatch notice failed', session.id.slice(0, 8), String(error?.message || error)))
  }

  if (provider === 'pi' && ev === 'ControlResult') {
    const waiter = piControlWaiters.get(body.request_id)
    if (waiter) {
      piControlWaiters.delete(body.request_id)
      clearTimeout(waiter.timer)
      waiter.resolve(body)
    }
    return
  }
  if (provider === 'pi' && ev === 'InputError') {
    const reason = String(body.error || 'Pi could not accept that input.').slice(0, 500)
    clearTeamInputReservation(session)
    if (session.teamActiveTaskId) {
      discardQueuedTeamTaskPrompt(session, session.teamActiveTaskId)
      await failTeamTaskForSession(session, `Pi rejected the delegated input: ${reason}`)
    } else saveStateNow(state)
    if (session.channel) await post(session.channel, `⚠️ ${reason}`)
    return
  }
  if (provider === 'pi' && ev === 'ManagedCheckpoint') {
    recordPiUsage(session, body)
    session.piTurnUsage = null
    saveState(state)
    return
  }
  if (provider === 'pi' && ev === 'ManagedChildUsage') {
    recordPiUsage(session, body)
    session.piTurnUsage = null
    saveState(state)
    return
  }
  if (provider === 'pi' && ev === 'ManagedRouting') {
    session.piTurnStartedAt = session.piRouting?.startedAt || Date.now()
    session.piTurnUsage = null
    startPiPoller(session)
    saveState(state)
    return
  }
  if (provider === 'pi' && ev === 'ManagedRoute') {
    if (body.usage) recordPiUsage(session, body)
    session.piTurnUsage = null
    stopPoller(session)
    await clearStatus(session)
    if (session.channel && body.route === 'managed') {
      await post(session.channel, `🧭 *Promoted to a managed Pi run* — ${String(body.reason || 'this task benefits from planning, validation, and review').slice(0, 1000)}`)
    }
    saveState(state)
    return
  }
  if (provider === 'pi' && ev === 'ManagedPolicy') {
    saveState(state)
    return
  }
  if (provider === 'pi' && ['ManagedStatus', 'ManagedPlan', 'ManagedReview'].includes(ev)) {
    const managed = session.managed
    if (managed?.status === 'active') {
      if (managed.id !== previousManagedId) session.piTurnUsage = null
      session.piTurnStartedAt ||= managed.startedAt || Date.now()
      startPiPoller(session)
    } else {
      stopPoller(session)
      await clearStatus(session)
    }
    if (session.channel && ev === 'ManagedPlan' && body.plan && session.lastManagedPlanId !== managed?.id) {
      const plan = body.plan
      const steps = Array.isArray(plan.steps)
        ? plan.steps.slice(0, 24).map((step, index) => `${Number(step.id) || index + 1}. ${String(step.text || '').slice(0, 1000)}`).join('\n')
        : ''
      const risks = Array.isArray(plan.risks) && plan.risks.length
        ? `\n\n*Risks*\n${plan.risks.slice(0, 12).map(risk => `• ${String(risk).slice(0, 1000)}`).join('\n')}`
        : ''
      await postMd(session.channel,
        `📋 *Managed Pi plan*${plan.summary ? ` — ${String(plan.summary).slice(0, 1500)}` : ''}\n\n${steps}${risks}\n\n` +
        (body.auto ? '_Executing automatically. Use `/sab-run pause` to pause._' : '_Waiting for `/sab-run approve`._'))
      session.lastManagedPlanId = managed?.id || null
    }
    if (session.channel && ev === 'ManagedReview' && body.review?.verdict === 'fix') {
      const findings = Array.isArray(body.review.findings)
        ? body.review.findings.slice(0, 20).map(item => `• ${String(item).slice(0, 1500)}`).join('\n')
        : ''
      await postMd(session.channel, `🔎 *Managed review requested fixes*\n${findings || String(body.review.summary || 'Review found changes to make.').slice(0, 3000)}`)
    }
    if (session.channel && ev === 'ManagedReview' && body.review?.verdict === 'pass') {
      await post(session.channel, '✅ Independent managed review passed — preparing the final response…')
    }
    if (body.notice && managed?.status !== 'complete') {
      stopPoller(session)
      await clearStatus(session)
      if (session.channel) await post(session.channel, `⚠️ ${String(body.notice).slice(0, 3000)}`)
    }
    saveState(state)
    return
  }
  if (provider === 'pi' && (ev === 'Status' || ev === 'Settings')) {
    if (ev === 'Status' && session.teamActiveTaskId) teamTurnProof.add(session.id)
    if (session.channel && ev === 'Settings') await updateTopic(session)
    return
  }
  if (provider === 'pi' && ev === 'AgentStart') {
    if (session.teamActiveTaskId) teamTurnProof.add(session.id)
    if (!targetClaim && !internalTurns.has(session.id) && session.channel) beginPiTurn(session)
    return
  }

  const standby = !targetClaim && standbyForSession(state, sid)
  if (standby) {
    // A preserved native leg is deliberately dormant. A trailing hook from the
    // process just switched away from—or a manual attempt to start that leg—
    // must not create a second channel or race the active provider for input.
    stopPoller(session)
    await clearStatus(session)
    if (ev === 'SessionStart') {
      if (session.tmux) await tmuxKill(session.tmux)
      if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
      await post(standby.channel, `⚠️ Blocked a second live ${providerLabel(provider)} leg. Use ${slackCommand(standby.lineage.activeProvider, 'switch')} in this channel to activate it safely.`).catch(() => {})
    }
    session.pid = null
    saveStateNow(state)
    return
  }

  if (ev === 'SessionStart') {
    restarting.delete(sid) // a resumed /sab-update session is up; re-enable the "ended" notice
    updatingSessions.delete(sid)
    resurrectInFlight.delete(sid) // the wake completed; future resurrects are legitimate
    if (session.tmux) clearKillOnClose(session.tmux)
    if (session.tmux) tmuxTitle(session.tmux, session.cwd || 'sab') // initial title; updateTopic enriches it (folder · branch · model · effort)
    // A switch target is provisional until its private handoff-readiness turn
    // succeeds. Never create/rebind a Slack channel or mirror startup noise yet.
    if (targetClaim) return
    await completeAuthoritativeSessionStart(session, provider, body.source)
    return
  }
  if (ev === 'UserPromptSubmit') {
    const p = (body.prompt || '').trim()
    const automationEcho = automationLifecycle.consumeInitialPromptEcho(sid, p)
    if (targetClaim || internalTurns.has(session.id)) {
      consumeInjected(sid, p)
      return
    }
    const teamTaskId = taskMarker(p)
    if (p && !(teamTaskId && session.teamActiveTaskId === teamTaskId)) reserveTeamInput(session, 'provider')
    const ch = session.channel || (await ensureChannel(session))
    const injected = consumeInjected(sid, p)
    if (teamTaskId && session.teamActiveTaskId === teamTaskId) {
      try {
        const task = markTeamTaskRunning(state, teamTaskId)
        teamTurnProof.add(session.id)
        saveStateNow(state)
        await updateTeamTaskAudit(task)
      }
      catch (error) { log('team task prompt acknowledgement rejected', teamTaskId, String(error?.message || error)) }
    } else if (teamTaskId && session.teamActiveTaskId) {
      await failTeamTaskForSession(session, 'The provider acknowledged a different delegated task identity.')
    } else if (session.teamActiveTaskId && p && !automationEcho && !injected) {
      await failTeamTaskForSession(session, 'A local terminal prompt replaced the delegated worker turn.')
    } else if (p && !automationEcho && !injected) {
      // Local terminal input and uncorrelated provider prompts do not inherit a
      // prior Slack owner's lateral team authority.
      clearTeamTurn(session)
      saveStateNow(state)
    }
    // Mirror only genuine typing: skip Slack-injected prompts (already shown) and
    // system-injected content (task notifications, reminders, local-command echoes).
    if (p && !automationEcho && !injected && !p.includes('source="slack-bridge"') && !isSystemPrompt(p)) {
      await post(ch, `💬 *You (terminal):*\n${p}`)
    }
    if (provider === 'claude') startPoller(session) // Claude TUI-specific spinner/form relay
    else if (provider === 'codex') beginCodexTurn(session)
    return
  }
  if (ev === 'PreToolUse') {
    // Stream out any prose Claude wrote before this tool call, so the channel
    // shows the turn unfolding. Clearing the status lets the poller repost the
    // live spinner below the new prose on its next tick.
    if (provider !== 'claude') return
    if (targetClaim || internalTurns.has(session.id)) return
    const text = readNewAssistantText(session)
    if (text) { await clearStatus(session); await postMd(session.channel, text) }
    const structuredForms = questionFormsFromHook(body)
    if (structuredForms.length) {
      await clearStatus(session)
      await relayQuestionForm(session, structuredForms[0], {
        source: 'structured', sequence: structuredForms, index: 0,
      })
      startPoller(session)
    }
    return
  }
  if (ev === 'Stop') {
    log('stop hook', session.id.slice(0, 8))
    if (await completePrivateTurn(session, body, targetClaim)) return
    if (provider === 'codex') await finalizeCodexTurn(session, body)
    else if (provider === 'pi') await finalizePiTurn(session, body)
    else await finalizeTurn(session)
    return
  }
  if (ev === 'SessionEnd') {
    stopPoller(session)
    await clearStatus(session)
    await failTeamTaskForSession(session, 'The worker session ended before completing its delegated task.')
    clearTeamInputReservation(session)
    teamTurnProof.delete(session.id)
    const failedPrivate = failPrivateTurn(session, new Error('agent session ended during a private bridge turn'), targetClaim)
    const switching = transitionForSession(state, sid)
    if (session.channel && !restarting.has(sid) && !switchingSids.has(sid) && !switching) {
      await post(session.channel, '💤 *Session ended* — write here to resume it')
    }
    clearPermissionsForPid(session.pid, 'session ended')
    session.pid = null
    if (switching?.transition.source.sid === sid && !failedPrivate && !switchingSids.has(sid) &&
        ['preflight', 'aligning'].includes(switching.transition.phase)) {
      rollbackTransition(state, switching.channel, 'source session ended before provider handoff')
      saveStateNow(state)
      await post(switching.channel, '↩️ Provider switch cancelled because the source session ended before handoff capture. The channel remains on the source leg; write here to resume it.')
      await flushTransitionQueue(switching.channel)
      return
    }
    saveState(state)
    return
  }
}

// ---- permission relay -------------------------------------------------------
const codexPermissionWaiters = new Map() // short request id → held hook response
const piPermissionWaiters = new Map() // short request id → held extension response
function clearPermissionsForPid(pid, reason = 'session ended') {
  if (!pid) return 0
  let cleared = 0
  for (const [rid, request] of Object.entries(state.perms)) {
    if (Number(request.pid) !== Number(pid)) continue
    delete state.perms[rid]
    const waiter = codexPermissionWaiters.get(rid) || piPermissionWaiters.get(rid)
    if (waiter) {
      codexPermissionWaiters.delete(rid)
      piPermissionWaiters.delete(rid)
      clearTimeout(waiter.timer)
      if (!waiter.res.writableEnded) waiter.res.end(waiter.provider === 'pi'
        ? JSON.stringify(waiter.kind === 'trust' ? { trusted: 'no', remember: false } : { behavior: 'deny', reason })
        : '{}')
    }
    web.chat.update({
      channel: request.channel, ts: request.ts,
      text: `⌛ Permission request closed (${reason})`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⌛ *Permission request closed* — ${reason}` } }],
    }).catch(() => {})
    cleared++
  }
  if (cleared) saveState(state)
  return cleared
}
function permissionId() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz'
  let id = ''
  do {
    id = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  } while (state.perms[id])
  return id
}
async function postPermissionPrompt(channel, p) {
  const preview = String(p.input_preview || '').slice(0, 1200)
  const agent = p.provider === 'codex' ? 'Codex' : p.provider === 'pi' ? 'Pi' : 'Claude'
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `🔐 *${agent} wants to use \`${escapeText(p.tool_name || 'a tool')}\`*\n${escapeText(String(p.description || '').slice(0, 600))}` } },
  ]
  if (preview) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + preview + '```' } })
  blocks.push(
    {
      type: 'actions', block_id: `perm_${p.request_id}`, elements: [
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✅ Approve' }, action_id: 'perm_allow', value: `allow:${p.request_id}` },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: '⛔ Deny' }, action_id: 'perm_deny', value: `deny:${p.request_id}` },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `or reply \`yes ${p.request_id}\` / \`no ${p.request_id}\`` }] },
  )
  // Return the interactive timestamp before the rate-limited status repost so
  // the permission is registered by the time its buttons become clickable.
  const r = await postSlackMessage(channel, { text: `🔐 Permission needed: ${p.tool_name}`, blocks }, { waitForBump: false })
  return r.ts
}

// Apply a verdict from a button tap or a text reply. Idempotent: unknown/expired ids are ignored.
async function applyVerdict(rid, behavior, channel, ts) {
  const req = state.perms[rid]
  if (!req) return false
  delete state.perms[rid]
  saveState(state)
  const waiter = codexPermissionWaiters.get(rid)
  const piWaiter = piPermissionWaiters.get(rid)
  if (waiter || piWaiter) {
    const held = waiter || piWaiter
    codexPermissionWaiters.delete(rid)
    piPermissionWaiters.delete(rid)
    clearTimeout(held.timer)
    if (!held.res.writableEnded) held.res.end(JSON.stringify(piWaiter
      ? held.kind === 'trust'
        ? { trusted: behavior === 'allow' ? 'yes' : 'no', remember: false }
        : { behavior }
      : codexPermissionDecision(behavior)))
  } else {
    const s = streams.get(req.pid)
    if (s) s.res.write(`data: ${JSON.stringify({ type: 'permission_verdict', request_id: rid, behavior })}\n\n`)
  }
  log('verdict', behavior, rid, '→ session pid', req.pid)
  const decided = behavior === 'allow' ? '✅ *Approved*' : '⛔ *Denied*'
  try {
    await web.chat.update({ channel: channel || req.channel, ts: ts || req.ts, text: `${decided} ${req.tool}`, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${decided} \`${escapeText(req.tool)}\`` } }] })
  } catch {}
  return true
}

// ---- injection & resurrection ----------------------------------------------
function injectToSession(pid, text, files = [], privateContext = '', route = null) {
  const s = streams.get(pid)
  if (s) {
    const payload = s.provider === 'pi'
      ? {
          type: 'prompt', text,
          ...(files.length ? { files } : {}),
          ...(privateContext ? { privateContext } : {}),
          ...(route ? { route } : {}),
        }
      : { type: 'message', text }
    s.res.write(`data: ${JSON.stringify(payload)}\n\n`)
    return true
  }
  return false
}

function piPromptQueueItem(text, { files = [], privateContext = '', route = null } = {}) {
  return {
    text: String(text || ''), files: Array.isArray(files) ? files : [],
    privateContext: String(privateContext || ''), route,
  }
}

function queuedPromptText(value) {
  return typeof value === 'string' ? value : `${String(value?.text || '')}${String(value?.privateContext || '')}`
}

function injectQueuedPiPrompt(pid, value) {
  if (typeof value === 'string') return injectToSession(pid, value)
  return injectToSession(pid, value?.text, value?.files, value?.privateContext, value?.route)
}

function sendPiControl(session, action, value = null, timeoutMs = 15000) {
  if (providerOf(session) !== 'pi') return Promise.reject(new Error('not a Pi session'))
  const stream = streams.get(session.pid)
  if (!stream || stream.provider !== 'pi') return Promise.reject(new Error('Pi control stream is not connected'))
  const requestId = crypto.randomUUID()
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      piControlWaiters.delete(requestId)
      reject(new Error(`Pi ${action} command timed out`))
    }, timeoutMs)
    piControlWaiters.set(requestId, { resolve, reject, timer })
  })
  stream.res.write(`data: ${JSON.stringify({ type: 'control', action, value, requestId })}\n\n`)
  return result
}

// Rebuild the launch args for a resume: replay the original flags (so
// --dangerously-skip-permissions, --chrome, etc. are preserved), minus any
// resume/continue flags, then add --resume <id>. Sessions launched before flag
// capture fall back to the operator's usual flags (default: --dsp).
function resumeArgs(session, initialPrompt = null) {
  const withMeta = session.effort ? session : { ...session, effort: sessionMeta.get(session.id)?.effort }
  return resumeArgsFor(withMeta, {
    defaultClaudeFlags: process.env.CCS_RESUME_FLAGS || '--dangerously-skip-permissions',
    defaultCodexFlags: process.env.CCS_CODEX_RESUME_FLAGS || CODEX_DANGEROUS_FLAG,
    defaultPiFlags: process.env.CCS_PI_RESUME_FLAGS || '',
    initialPrompt,
  })
}

// /model and /effort now pop a "Change …? Yes / No" confirmation (changing either
// invalidates the prompt cache). Send the command, then confirm the highlighted
// default ("Yes") when the dialog appears; if it never appears, this is a no-op.
async function sendMenuCommand(tmux, cmd) {
  await tmuxSendCommand(tmux, cmd)
  for (let i = 0; i < 5; i++) {
    await sleep(400)
    if (/Yes, switch to|Change (effort|model) level/i.test(await tmuxCapture(tmux))) {
      await execFile('tmux', ['send-keys', '-t', tmux, 'Enter']) // confirm "Yes"
      return
    }
  }
}

// --resume is scoped to the launch dir's project slug (~/.claude/projects/<slug>/),
// so we must launch from the directory whose slug holds this session's transcript.
// The recorded cwd can drift — claude cd's into a subdir and the statusline moves
// session.cwd there — which makes --resume look under the wrong slug and fail. Find
// the dir that actually holds the transcript and re-anchor to it.
function resumeCwd(session) {
  if (providerOf(session) !== 'claude') return session.cwd
  if (session.transcript && fs.existsSync(session.transcript)) return session.cwd
  const base = path.join(process.env.HOME, '.claude', 'projects')
  try {
    for (const d of fs.readdirSync(base)) {
      const t = path.join(base, d, session.id + '.jsonl')
      if (fs.existsSync(t)) { session.transcript = t; return '/' + d.replace(/^-/, '').replace(/-/g, '/') }
    }
  } catch {}
  return session.cwd
}

// sid → ts of a resurrect currently materializing. Guards against stacked spawns:
// messages that arrive while claude is still starting used to trigger fresh spawns
// (and fresh "Waking…" posts) every time. Cleared by SessionStart, or after 90s.
const resurrectInFlight = new Map()
const abandonedResumeTmux = new Set()

function abandonResumeTmux(tmuxName) {
  abandonedResumeTmux.add(tmuxName)
  const timer = setTimeout(() => abandonedResumeTmux.delete(tmuxName), 2 * 60 * 1000)
  timer.unref?.()
}

function claudeStartupStatusPath(tmuxName) {
  const dir = path.join(CONFIG_DIR, 'runtime')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  const file = path.join(dir, `resume-${tmuxName}.exit`)
  try { fs.unlinkSync(file) } catch {}
  fs.writeFileSync(`${file}.armed`, '', { mode: 0o600 })
  return file
}

function readClaudeStartupExit(file) {
  try {
    const value = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : null
  } catch { return null }
}

function removeClaudeStartupStatus(file) {
  if (!file) return
  try { fs.unlinkSync(file) } catch {}
  try { fs.unlinkSync(`${file}.armed`) } catch {}
}

async function completeClaudeResumeReadiness(session, tmuxName, startupStatusPath) {
  const nodeId = nodeIdForSession(session)
  return waitForClaudeResumeClaim(session, {
    expectedTmux: tmuxName,
    tmuxAlive: name => executionNodes.tmuxAlive(nodeId, name),
    pidAlive,
    validTmuxClaim,
    readExitCode: () => readClaudeStartupExit(startupStatusPath),
  })
}

async function resurrect(session, text) {
  const inflight = resurrectInFlight.get(session.id)
  if (inflight && Date.now() - inflight < 90000) return // already waking; message is queued
  resurrectInFlight.set(session.id, Date.now())
  let up = false
  let initialPrompt = null
  let lastResumeError = null
  let lastTmuxName = null
  try {
    const anchored = resumeCwd(session)
    if (anchored !== session.cwd) { log('resume cwd re-anchored', session.id.slice(0, 8), session.cwd, '→', anchored); session.cwd = anchored; saveState(state) }
    const provider = providerOf(session)
    // Claude Code scopes --resume to the cwd's project, so the folder must exist at
    // its original path. If it's gone (e.g. a deleted worktree), recreate it empty —
    // the transcript in ~/.claude/projects survives, so the conversation resumes.
    if (!fs.existsSync(session.cwd)) {
      try {
        fs.mkdirSync(session.cwd, { recursive: true })
        await post(session.channel, `⚠️ Folder \`${session.cwd}\` was gone — recreated it empty and resuming there. The conversation is intact; files from the original folder are not.`)
      } catch (e) {
        const manual = provider === 'codex' ? `codex resume ${session.id}`
          : provider === 'pi' ? `pi --session ${session.id}`
            : `claude --resume ${session.id}`
        return post(session.channel, `❌ Can't resume — folder \`${session.cwd}\` is gone and couldn't be recreated (${e?.code || e}). The transcript is preserved; resume manually with \`${manual}\` from a valid directory.`)
      }
    }
    await post(session.channel, '⏳ *Waking this session up on the Mac…*')
    // Codex does not necessarily emit SessionStart while a resumed TUI is idle.
    // Waiting for that hook before pasting the wake message therefore deadlocks:
    // local typing starts the first turn, then the hook finally flushes Slack's
    // queue. Codex resume accepts an optional PROMPT, so consume exactly the
    // first queued message into argv; it starts the turn and unlocks SessionStart.
    // Later messages stay queued and are flushed by the existing hook path.
    if (provider === 'codex') {
      const queued = pendingBySid.get(session.id) || []
      initialPrompt = queued.shift() ?? text ?? null
      pendingBySid.set(session.id, queued)
      if (initialPrompt) {
        rememberInjected(session.id, initialPrompt) // suppress the hook echo; Slack already shows it
        log('codex resume bootstrapped queued prompt', session.id.slice(0, 8))
      }
    }
    const args = resumeArgs(session, initialPrompt)
    // Start headlessly and verify that the tmux-owned provider materializes.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tmuxName = `sab-res-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
      lastTmuxName = tmuxName
      const startupStatusPath = provider === 'claude' ? claudeStartupStatusPath(tmuxName) : null
      session.tmux = tmuxName
      saveState(state)
      const nodeId = nodeIdForSession(session)
      try {
        await executionNodes.spawn(nodeId, {
          cwd: session.cwd,
          args,
          title: `sab ${path.basename(session.cwd)} (resumed)`,
          tmuxName,
          autoConsent: provider === 'claude',
          account: provider === 'claude' ? session.account : null, // Claude-only subscription binding
          provider,
          startupStatusPath,
        })
      } catch (error) {
        lastResumeError = error
        removeClaudeStartupStatus(startupStatusPath)
        log(`${providerLabel(provider)} resume spawn failed`, session.id.slice(0, 8), tmuxName,
          String(error?.message || error))
        continue
      }
      if (provider === 'claude') {
        try {
          await completeClaudeResumeReadiness(session, tmuxName, startupStatusPath)
          up = true
          removeClaudeStartupStatus(startupStatusPath)
          return
        } catch (error) {
          lastResumeError = error
          up = false
          log('Claude resume readiness failed', session.id.slice(0, 8), tmuxName,
            String(error?.message || error))
          abandonResumeTmux(tmuxName)
          await tmuxKill(tmuxName).catch(() => {})
          removeClaudeStartupStatus(startupStatusPath)
          if (session.tmux === tmuxName) session.pid = null
          continue
        }
      }
      for (let i = 0; i < 24 && !up; i++) { await sleep(500); up = await executionNodes.tmuxAlive(nodeId, tmuxName) }
      if (up) {
        if (provider === 'codex') {
          try {
            await completeCodexResumeReadiness(session, 'session resurrection')
          } catch (error) {
            log('Codex resume readiness failed', session.id.slice(0, 8), tmuxName, String(error?.message || error))
            up = false
            await tmuxKill(tmuxName).catch(() => {})
            continue
          }
        }
        return // SessionStart or the exact-tmux fallback completed the wake
      }
      log('spawn did not materialize', { attempt, tmuxName })
      await execFile('pkill', ['-f', tmuxName]).catch(() => {}) // kill the failed young instance
    }
    if (session.tmux === lastTmuxName) {
      session.tmux = null
      session.pid = null
    }
    if (session.channel && state.channels?.[session.channel] === session.id &&
        state.channelTmux?.[session.channel] === lastTmuxName) {
      delete state.channelTmux[session.channel]
    }
    clearTeamInputReservation(session)
    saveStateNow(state)
    const detail = String(lastResumeError?.message || 'the provider exited before establishing its lifecycle identity').slice(0, 500)
    await post(session.channel,
      `⚠️ *The provider process did not initialize* — ${detail}. I cleaned up and retried without luck. ` +
      'The message remains queued; send another message after correcting or updating the provider to retry.')
  } finally {
    if (!up) {
      resurrectInFlight.delete(session.id)
      if (initialPrompt) {
        const queued = pendingBySid.get(session.id) || []
        pendingBySid.set(session.id, [initialPrompt, ...queued])
      }
    }
  }
}
const pendingBySid = new Map()

async function adoptHooklessCodexResume(session, claim, reason) {
  if (session.tmux !== claim.tmux || !(await tmuxAlive(claim.tmux))) {
    throw new Error('replacement Codex tmux changed before adoption')
  }
  if (!(claim.pid && pidAlive(claim.pid) && await validTmuxClaim(claim.pid, claim.tmux))) {
    throw new Error('replacement Codex process failed final ancestry validation')
  }
  if (session.pid && pidAlive(session.pid)) return false // native SessionStart won the race

  // This is the same durable identity mutation performed by onHook after a
  // native SessionStart, but sourced from a verified descendant of the exact
  // replacement tmux. Codex resume can remain idle without emitting that hook.
  if (!applyHooklessCodexClaim(state, session, claim)) return false
  restarting.delete(session.id)
  updatingSessions.delete(session.id)
  resurrectInFlight.delete(session.id)
  clearKillOnClose(claim.tmux)
  tmuxTitle(claim.tmux, session.cwd || 'sab')
  saveStateNow(state)
  log('adopted hookless Codex resume', session.id.slice(0, 8), 'pid', claim.pid, 'tmux', claim.tmux, reason)
  await completeAuthoritativeSessionStart(session, 'codex', 'resume')
  return true
}

async function completeCodexResumeReadiness(session, reason) {
  const claim = await waitForCodexResumeClaim(session, {
    tmuxAlive,
    pidAlive,
    findCodexPid: tmux => tmuxCodexProcessPid(tmux, { execFile }),
    validTmuxClaim,
    sleep,
  })
  if (claim.source === 'process-tree') await adoptHooklessCodexResume(session, claim, reason)
  return claim
}

async function recoverHooklessCodexResumes() {
  for (const session of hooklessAuthoritativeCodexSessions(state)) {
    try {
      if (!(await tmuxAlive(session.tmux))) continue
      const pid = await tmuxCodexProcessPid(session.tmux, { execFile })
      if (!(pid && pidAlive(pid) && await validTmuxClaim(pid, session.tmux))) continue
      await adoptHooklessCodexResume(session, { source: 'process-tree', pid, tmux: session.tmux }, 'daemon boot')
    } catch (error) {
      log('hookless Codex boot recovery failed', session.id.slice(0, 8), String(error?.message || error))
    }
  }
}

function waitForPrivateTurn(map, key, timeoutMs = 5 * 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      map.delete(key)
      reject(new Error('private bridge turn timed out'))
    }, timeoutMs)
    map.set(key, { resolve, reject, timer })
  })
}

async function capturePrivateTurn(session, prompt) {
  if (!session?.tmux || !(await tmuxAlive(session.tmux))) throw new Error('source terminal is unavailable')
  const result = waitForPrivateTurn(internalTurns, session.id)
  rememberInjected(session.id, prompt)
  try {
    if (providerOf(session) === 'pi') {
      if (!injectToSession(session.pid, prompt, [], '', 'native')) throw new Error('Pi control stream is unavailable')
    } else await tmuxPaste(session.tmux, prompt)
  }
  catch (error) {
    const waiter = internalTurns.get(session.id)
    if (waiter) { clearTimeout(waiter.timer); internalTurns.delete(session.id); waiter.reject(error) }
  }
  return result
}

async function captureTargetValidation(transition, prompt) {
  if (!transition?.target?.tmux || !(await tmuxAlive(transition.target.tmux))) throw new Error('target tmux session is unavailable')
  const result = waitForPrivateTurn(targetValidationWaiters, transition.id)
  result.catch(() => {}) // cancellation below is handled through this function
  if (transition.target.sid) rememberInjected(transition.target.sid, prompt)
  try {
    await submitTargetValidation(transition.target.provider, {
      waitForClaim: () => waitForTargetSessionClaim(transition, { sleepFn: sleep }),
      inject: async () => {
        if (transition.target.provider !== 'pi') return tmuxPaste(transition.target.tmux, prompt)
        const target = state.sessions[transition.target.sid]
        rememberInjected(transition.target.sid, prompt)
        if (!target || !injectToSession(target.pid, prompt, [], '', 'native')) throw new Error('Pi target control stream is unavailable')
      },
    })
  }
  catch (error) {
    const waiter = targetValidationWaiters.get(transition.id)
    if (waiter) { clearTimeout(waiter.timer); targetValidationWaiters.delete(transition.id); waiter.reject(error) }
    throw error
  }
  return result
}

async function waitForTargetInputReady(channel, transition, timeoutMs = 5 * 60000) {
  const startedAt = Date.now()
  let trustNoticeSent = false
  let startupNoticeSent = false
  while (Date.now() - startedAt < timeoutMs) {
    if (!transition?.target?.tmux || !(await tmuxAlive(transition.target.tmux))) {
      throw new Error(`${providerLabel(transition.target.provider)} target tmux session ended during startup`)
    }
    if (transition.target.provider === 'pi' && transition.target.sid) {
      const target = state.sessions[transition.target.sid]
      if (target?.pid && streams.get(target.pid)?.provider === 'pi') return
    }
    const pane = await tmuxCapture(transition.target.tmux)
    const startup = targetStartupState(transition.target.provider, pane)
    if (startup === 'ready') return
    if (startup === 'update') {
      throw new Error('Codex opened its interactive update chooser despite SAB startup suppression. Run `codex update` on the Mac, then retry the provider switch.')
    }
    if (startup === 'trust' && !trustNoticeSent) {
      trustNoticeSent = true
      try {
        await openTmuxTerminal(transition.target.tmux)
        await post(channel, `🔐 ${providerLabel(transition.target.provider)} needs a local trust decision, so I opened its terminal. Approve it there; the bridge will continue automatically.`)
      } catch (error) {
        await post(channel, `🔐 ${providerLabel(transition.target.provider)} needs a local trust decision, but its terminal could not be opened: ${String(error?.message || error).slice(0, 300)}`)
      }
    } else if (!startupNoticeSent && Date.now() - startedAt >= 15000) {
      startupNoticeSent = true
      await post(channel, `⏳ Waiting for the ${providerLabel(transition.target.provider)} input surface before private validation…`)
    }
    await sleep(500)
  }
  throw new Error(`${providerLabel(transition.target.provider)} target did not become ready for private validation`)
}

function auxiliaryEnv() {
  return sanitizedAuxiliaryEnv(process.env)
}

function runWithInput(bin, args, { cwd, input, timeout = 180000, maxBuffer = 2 << 20 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: auxiliaryEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', size = 0, settled = false, timer = null
    const finish = (error, value) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (error) reject(error); else resolve(value)
    }
    const collect = target => chunk => {
      size += chunk.length
      if (size > maxBuffer) { child.kill(); finish(new Error('instruction proposal output exceeded its limit')); return }
      if (target === 'out') stdout += chunk
      else stderr += chunk
    }
    child.stdout.on('data', collect('out'))
    child.stderr.on('data', collect('err'))
    child.stdin.on('error', error => finish(error))
    child.on('error', error => finish(error))
    child.on('close', code => code === 0
      ? finish(null, stdout.trim())
      : finish(new Error((stderr || stdout || `agent exited ${code}`).trim().slice(0, 1000))))
    timer = setTimeout(() => {
      child.kill()
      finish(new Error(`instruction proposal agent timed out after ${Math.round(timeout / 1000)} seconds`))
    }, timeout)
    child.stdin.end(input)
  })
}

async function generateInstructionProposal(preflight, provider) {
  if (preflight.kind === 'agents_only' && !preflight.oversize) return deterministicWrapperPatch(preflight)
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const neutralCwd = fs.mkdtempSync(path.join(CONFIG_DIR, 'instruction-agent-'))
  try {
    fs.chmodSync(neutralCwd, 0o700)
    const prompt = instructionDocumentsPrompt(preflight)
    const timeout = instructionProposalTimeout(process.env)
    const output = provider === 'codex'
      ? await runWithInput(codexBin(), ['exec', '--sandbox', 'read-only', '--ephemeral', '--color', 'never', '--skip-git-repo-check', '-'], {
        cwd: neutralCwd, input: prompt, timeout,
      })
      : provider === 'pi'
        ? await runWithInput(piBin(), ['--print', '--no-tools', '--no-session', '--no-context-files'], {
          cwd: neutralCwd, input: prompt, timeout,
        })
        : await runWithInput(claudeBin(), [
          '--print', '--permission-mode', 'plan', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit',
          '--no-session-persistence',
        ], { cwd: neutralCwd, input: prompt, timeout })
    const documents = buildInstructionDocuments(parseInstructionDocuments(output))
    return await buildInstructionPatch(preflight, documents, { tempRoot: CONFIG_DIR })
  } finally {
    fs.rmSync(neutralCwd, { recursive: true, force: true })
  }
}

async function validateInstructionPatchResult(preflight, patch) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  const temp = fs.mkdtempSync(path.join(CONFIG_DIR, 'instruction-check-'))
  try {
    await execFile('git', ['init', '--quiet', temp])
    for (const file of [preflight.agents, preflight.claude]) {
      if (file?.exists && file.content != null) fs.writeFileSync(path.join(temp, file.name), file.content, { mode: 0o600 })
    }
    const patchFile = path.join(temp, 'proposal.patch')
    fs.writeFileSync(patchFile, patch, { mode: 0o600 })
    await execFile('git', ['-C', temp, 'apply', '--whitespace=nowarn', patchFile])
    return validateInstructionResult(temp)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function switchBlockReason(session, channel, { allowCurrentTransition = false } = {}) {
  if (!allowCurrentTransition && activeTransition(channel)) return 'A provider switch is already in progress in this channel.'
  if (!(session?.pid && pidAlive(session.pid) && session.tmux)) return 'Wake the session first; provider switching requires an active, idle source.'
  if (pollers.has(session.id) || codexPollers.has(session.id) || piPollers.has(session.id)) return 'Wait for the current agent turn to finish before switching providers.'
  if (qforms.has(session.id)) return 'Answer or dismiss the open question before switching providers.'
  if (hasPendingPerm(session)) return 'Resolve the open permission request before switching providers.'
  if (internalTurns.has(session.id)) return 'The bridge is already running a private maintenance turn.'
  return null
}

function instructionSummary(preflight) {
  if (preflight.kind === 'aligned') return '✅ `AGENTS.md` is canonical and `CLAUDE.md` already references it.'
  if (preflight.kind === 'none') return 'ℹ️ No root `AGENTS.md` or `CLAUDE.md`; nothing to align.'
  if (preflight.kind === 'non_git') return '⚠️ Non-Git folder; automatic instruction alignment is disabled.'
  if (preflight.reason) return `⚠️ ${preflight.reason}. You may switch without changing instructions.`
  if (preflight.oversize) return `📝 \`AGENTS.md\` exceeds Codex's ${32 * 1024}-byte project budget; the bridge can propose a compact reconciliation.`
  if (preflight.kind === 'agents_only') return '📝 `CLAUDE.md` is missing; the bridge can add a thin wrapper pointing to `AGENTS.md`.'
  if (preflight.kind === 'claude_only') return '📝 Only `CLAUDE.md` exists; the bridge can propose a canonical `AGENTS.md` plus a thin Claude wrapper.'
  return '📝 `AGENTS.md` and `CLAUDE.md` diverge; the bridge can propose a reviewed reconciliation.'
}

function scheduleSwitchPreviewExpiry(channel, transitionId, expectedUpdatedAt) {
  setTimeout(async () => {
    const lineage = lineageFor(state, channel)
    const transition = lineage?.transition
    if (!transition || transition.id !== transitionId || transition.phase !== 'preflight' || transition.updatedAt !== expectedUpdatedAt) return
    rollbackTransition(state, channel, 'provider switch preview expired')
    saveStateNow(state)
    await post(channel, '⌛ Provider-switch preview expired; the source remains active.').catch(() => {})
    await flushTransitionQueue(channel)
  }, 30 * 60000)
}

async function beginProviderSwitch(channel, source, { replaceMissing = false, targetProvider = null } = {}) {
  const blocker = switchBlockReason(source, channel)
  if (blocker) return post(channel, `⚠️ ${blocker}`)
  if (!(await tmuxAlive(source.tmux))) return post(channel, '⚠️ The source terminal is gone. Write a message to resume it, then retry the switch.')
  const lineage = ensureLineage(state, channel, source)
  targetProvider ||= defaultSwitchTarget(providerOf(source))
  if (!PROVIDERS.includes(targetProvider) || targetProvider === providerOf(source)) {
    return post(channel, `❌ Choose a different target provider: ${PROVIDERS.filter(name => name !== providerOf(source)).join(' · ')}`)
  }
  const savedTargetSid = lineage.legs[targetProvider]
  if (savedTargetSid && !state.sessions[savedTargetSid] && !replaceMissing) {
    return post(channel, `⚠️ The saved ${providerLabel(targetProvider)} leg \`${savedTargetSid.slice(0, 8)}\` is missing from bridge state. Run \`${slackCommand(providerOf(source), 'switch')} ${targetProvider} new\` to explicitly replace it with a new native leg.`)
  }
  if (savedTargetSid && !state.sessions[savedTargetSid] && replaceMissing) {
    lineage.legs[targetProvider] = null
    saveStateNow(state)
  }
  const targetSession = lineage.legs[targetProvider] ? state.sessions[lineage.legs[targetProvider]] : null
  if (targetSession?.pid && pidAlive(targetSession.pid)) {
    return post(channel, `⚠️ The standby ${providerLabel(targetProvider)} leg is unexpectedly live. End it before switching.`)
  }
  const launch = switchTargetLaunch(targetProvider, targetSession, process.env)
  const transition = beginTransition(state, channel, source, {
    targetFlags: launch.effectiveFlags, targetKind: launch.kind, targetProvider,
  })
  transition.target.args = launch.args
  const preflight = inspectInstructions(source.cwd)
  transition.instructions = {
    kind: preflight.kind, root: preflight.root, rootBytes: preflight.rootBytes || 0,
    reason: preflight.reason || null, fingerprints: preflight.fingerprints || null,
  }
  saveStateNow(state)
  const settings = targetSession
    ? `resume native leg \`${targetSession.id.slice(0, 8)}\` · model \`${targetSession.model || readModel(targetSession) || 'default'}\` · effort \`${targetSession.effort || 'default'}\``
    : 'create a new native leg'
  const flags = launch.effectiveFlags.length ? launch.effectiveFlags.join(' ') : '(none)'
  const text = `🔀 *Switch ${providerLabel(providerOf(source))} → ${providerLabel(targetProvider)}?*\n` +
    `Target: ${settings}\nLaunch flags: \`${flags}\`\n${instructionSummary(preflight)}\n` +
    '_The current provider remains active until a private handoff is safely captured._'
  scheduleSwitchPreviewExpiry(channel, transition.id, transition.updatedAt)
  try {
    return await postSlackMessage(channel, {
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...switchActionBlocks(transition, preflight)],
    })
  } catch (error) {
    if (activeTransition(channel)?.id === transition.id) {
      rollbackTransition(state, channel, 'provider switch preview delivery failed')
      saveStateNow(state)
    }
    throw error
  }
}

function transitionPreflight(transition) {
  const current = inspectInstructions(transition.instructions?.root || state.sessions[transition.source.sid]?.cwd)
  return current
}

async function proposeInstructionAlignment(channel, lineage, transition) {
  setTransitionPhase(lineage, 'aligning')
  saveStateNow(state)
  await post(channel, '🧭 Preparing a read-only instruction reconciliation proposal…')
  const preflight = transitionPreflight(transition)
  if (!preflight.safeToPropose || !fingerprintsMatch({ root: preflight.root, fingerprints: transition.instructions.fingerprints })) {
    throw new Error(preflight.reason || 'instruction files changed since the switch preview')
  }
  const progressStartedAt = Date.now()
  const progress = setInterval(() => {
    const current = activeTransition(channel)
    if (!current || current.id !== transition.id || current.phase !== 'aligning') return
    post(channel, instructionProgressText(Date.now() - progressStartedAt)).catch(() => {})
  }, 60000)
  progress.unref?.()
  let patch
  try {
    patch = await generateInstructionProposal(preflight, transition.source.provider)
  } finally {
    clearInterval(progress)
  }
  const checked = validateInstructionPatch(patch, preflight)
  await validateInstructionPatchResult(preflight, checked.patch)
  transition.instructions.proposal = writeInstructionProposal(CONFIG_DIR, channel, transition.id, checked.patch)
  transition.instructions.proposal.touched = checked.touched
  transition.instructions.proposedAt = Date.now()
  setTransitionPhase(lineage, 'preflight')
  saveStateNow(state)
  scheduleSwitchPreviewExpiry(channel, transition.id, transition.updatedAt)
  const shown = checked.patch.length > 2600 ? checked.patch.slice(0, 2600) + '\n… (full proposal attached below)' : checked.patch
  const text = `📝 *Instruction reconciliation proposal*\n\`\`\`diff\n${shown}\`\`\`\n_Apply leaves these changes uncommitted for normal review._`
  await postSlackMessage(channel, {
    text: 'Instruction reconciliation proposal ready.',
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2950) } },
      ...switchActionBlocks(transition, preflight, 'proposal'),
    ],
  })
  if (checked.patch.length > 2600) await postMd(channel, `*Full instruction proposal*\n\n\`\`\`diff\n${checked.patch}\`\`\``)
}

async function applyInstructionProposal(transition) {
  const before = { root: transition.instructions.root, fingerprints: transition.instructions.fingerprints }
  if (!fingerprintsMatch(before)) throw new Error('instruction files changed after the proposal; refusing to apply a stale patch')
  const patch = readInstructionProposal(transition.instructions.proposal)
  const preflight = inspectInstructions(transition.instructions.root)
  validateInstructionPatch(patch, preflight)
  await validateInstructionPatchResult(preflight, patch)
  await execFile('git', ['-C', preflight.root, 'apply', '--check', '--whitespace=nowarn', transition.instructions.proposal.path])
  await execFile('git', ['-C', preflight.root, 'apply', '--whitespace=nowarn', transition.instructions.proposal.path])
  validateInstructionResult(preflight.root)
  transition.instructions.appliedAt = Date.now()
}

async function flushTransitionQueue(channel) {
  const lineage = lineageFor(state, channel)
  while (lineage?.pendingDelivery?.length) {
    const item = lineage.pendingDelivery[0]
    try {
      if (item.kind === 'attachments') await handleAttachments(channel, item.caption, item.files, null, item.request)
      else await handleSlackMessage(channel, item.text, null, item.request)
    } catch (error) {
      log('queued switch delivery failed', channel, String(error))
      break
    }
    lineage.pendingDelivery.shift()
    saveStateNow(state)
  }
}

async function rollbackProviderSwitch(channel, lineage, transition, error) {
  try { setTransitionPhase(lineage, 'rolling_back', { error: String(error?.message || error).slice(0, 500) }); saveStateNow(state) } catch {}
  const waiter = targetValidationWaiters.get(transition.id)
  if (waiter) { clearTimeout(waiter.timer); targetValidationWaiters.delete(transition.id); waiter.reject(new Error('provider switch rolled back')) }
  if (transition.target.tmux) await tmuxKill(transition.target.tmux)
  const target = transition.target.sid ? state.sessions[transition.target.sid] : null
  if (target) {
    stopPoller(target); clearPermissionsForPid(target.pid, 'provider switch rolled back')
    if (target.pid && pidAlive(target.pid)) { try { process.kill(target.pid) } catch {} }
    target.pid = null; target.channel = null
  }
  const source = rollbackTransition(state, channel, error?.message || error)
  switchingSids.delete(transition.source.sid)
  saveStateNow(state)
  await post(channel, `↩️ *Provider switch rolled back* — ${String(error?.message || error).slice(0, 300)}. The ${providerLabel(transition.source.provider)} leg remains authoritative.`)
  if (lineage.pendingDelivery?.length) await flushTransitionQueue(channel)
  else if (source && !(source.pid && pidAlive(source.pid))) await resurrect(source)
}

async function runProviderSwitch(channel, lineage, transition, { applyProposal = false } = {}) {
  try {
    const source = state.sessions[transition.source.sid]
    let blocker = switchBlockReason(source, channel, { allowCurrentTransition: true })
    if (!blocker) { await sleep(500); blocker = switchBlockReason(source, channel, { allowCurrentTransition: true }) }
    if (blocker) throw new Error(blocker)
    if (applyProposal) {
      await applyInstructionProposal(transition)
      await post(channel, '✅ Instruction proposal applied as uncommitted repository changes.')
    }
    setTransitionPhase(lineage, 'handoff')
    saveStateNow(state)
    await post(channel, `🧳 Capturing a private ${providerLabel(transition.source.provider)} handoff…`)
    if (!source || !(source.pid && pidAlive(source.pid))) throw new Error('source session ended before handoff capture')
    const handoffText = await capturePrivateTurn(source, handoffPrompt({
      sourceProvider: transition.source.provider,
      targetProvider: transition.target.provider,
      latestUserIntent: `Switch this Slack session to ${providerLabel(transition.target.provider)} and continue the current task.`,
    }))
    const handoff = writeHandoff(CONFIG_DIR, channel, lineage.generation + 1, handoffText)
    setTransitionPhase(lineage, 'handoff_ready', { handoff })
    saveStateNow(state)

    switchingSids.add(source.id)
    stopPoller(source); await clearStatus(source); await clearQuestionForm(source)
    clearPermissionsForPid(source.pid, 'switching provider')
    if (source.tmux) await tmuxKill(source.tmux)
    if (source.pid && pidAlive(source.pid)) { try { process.kill(source.pid) } catch {} }
    source.pid = null

    const tmuxName = `sab-switch-${transition.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 18)}`
    transition.target.tmux = tmuxName
    const existingTarget = transition.target.sid ? state.sessions[transition.target.sid] : null
    if (existingTarget) existingTarget.tmux = tmuxName
    setTransitionPhase(lineage, 'target_starting')
    saveStateNow(state)
    await post(channel, `🚀 Starting the ${providerLabel(transition.target.provider)} leg for private validation…`)
    const nodeId = nodeIdForSession(source)
    await executionNodes.spawn(nodeId, {
      cwd: source.cwd,
      args: transition.target.args,
      title: `sab ${path.basename(source.cwd)} (${providerCommand(transition.target.provider)})`,
      tmuxName,
      autoConsent: transition.target.provider === 'claude',
      account: transition.target.provider === 'claude' ? existingTarget?.account : null,
      provider: transition.target.provider,
    })
    let up = false
    for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await executionNodes.tmuxAlive(nodeId, tmuxName) }
    if (!up) throw new Error('target provider did not initialize')
    await waitForTargetInputReady(channel, transition)
    setTransitionPhase(lineage, 'target_validating')
    saveStateNow(state)
    const content = readHandoff(handoff)
    const reply = await captureTargetValidation(transition, targetBootstrapPrompt({
      sourceProvider: transition.source.provider,
      targetProvider: transition.target.provider,
      handoff: content,
      handoffPath: handoff.path,
    }))
    validateBootstrapReply(reply)
    const target = transition.target.sid ? state.sessions[transition.target.sid] : null
    if (!target || providerOf(target) !== transition.target.provider || !(target.pid && pidAlive(target.pid))) {
      throw new Error('target did not establish a valid native session')
    }
    setTransitionPhase(lineage, 'committing')
    saveStateNow(state)
    commitTransition(state, channel, target)
    if (target.tmux) state.channelTmux[channel] = target.tmux
    artifactGrants.revoke({ sessionId: source.id, channelId: channel, provider: providerOf(source) })
    saveStateNow(state)
    switchingSids.delete(source.id)
    await updateTopic(target)
    await post(channel, `✅ *Switched to ${providerLabel(providerOf(target))}* — native session \`${target.id.slice(0, 8)}\` is now active. The ${providerLabel(providerOf(source))} leg is preserved as standby.`)
    await flushTransitionQueue(channel)
  } catch (error) {
    log('provider switch failed', transition.id, String(error?.stack || error))
    await rollbackProviderSwitch(channel, lineage, transition, error)
  }
}

async function handleProviderSwitchAction(channel, transitionId, action) {
  const lineage = lineageFor(state, channel)
  const transition = lineage?.transition
  if (!transition || transition.id !== transitionId) return post(channel, '⌛ This provider-switch action is stale.')
  if (transition.phase !== 'preflight') return post(channel, `⏳ This switch is already in its \`${transition.phase}\` phase.`)
  if (action === 'cancel') {
    rollbackTransition(state, channel, 'cancelled by owner')
    saveStateNow(state)
    await post(channel, '✋ Provider switch cancelled; nothing was stopped or changed.')
    return flushTransitionQueue(channel)
  }
  if (action === 'align') {
    try { return await proposeInstructionAlignment(channel, lineage, transition) }
    catch (error) {
      rollbackTransition(state, channel, error?.message || error)
      saveStateNow(state)
      await post(channel, `❌ Instruction proposal failed safely: ${String(error?.message || error).slice(0, 400)}. No files were changed.`)
      return flushTransitionQueue(channel)
    }
  }
  if (action === 'apply' && !transition.instructions?.proposal) return post(channel, '⚠️ No instruction proposal is available to apply.')
  if (!['apply', 'continue'].includes(action)) return
  await runProviderSwitch(channel, lineage, transition, { applyProposal: action === 'apply' })
}

async function recoverProviderSwitches() {
  for (const [channel, lineage] of Object.entries(state.lineages || {})) {
    const transition = lineage.transition
    if (!transition) continue
    const alive = transition.target.tmux ? await tmuxAlive(transition.target.tmux) : false
    const decision = recoveryDecision(transition, { targetTmuxAlive: alive })
    if (decision.killTargetTmux) await tmuxKill(decision.targetTmux)
    const target = transition.target.sid ? state.sessions[transition.target.sid] : null
    if (target) { target.pid = null; target.channel = null }
    const source = rollbackTransition(state, channel, 'daemon restarted during provider switch')
    saveStateNow(state)
    await post(channel, `↩️ Recovered an interrupted provider switch. ${providerLabel(transition.source.provider)} remains authoritative; the provisional target was discarded.`).catch(() => {})
    if (lineage.pendingDelivery?.length) await flushTransitionQueue(channel)
    else if (source && !(source.pid && pidAlive(source.pid)) && ['target_starting', 'target_validating', 'committing', 'rolling_back'].includes(transition.phase)) {
      await resurrect(source).catch(error => log('switch recovery resume failed', String(error)))
    }
  }
  for (const [channel, lineage] of Object.entries(state.lineages || {})) {
    if (lineage.pendingDelivery?.length) await flushTransitionQueue(channel)
  }
}

async function updateProviderCli(provider) {
  const before = await agentVersion(provider)
  let note = ''
  try {
    const bin = provider === 'codex' ? codexBin() : provider === 'pi' ? piBin() : claudeBin()
    const updateArgs = provider === 'pi' ? ['update', 'self'] : ['update']
    const { stdout, stderr } = await execFile(bin, updateArgs, { timeout: 180000 })
    note = (stdout + '\n' + stderr).split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
  } catch (e) { note = `error: ${e?.stderr?.trim() || e?.message || e}` }
  if (provider === 'codex') codexModelCache = null
  else if (provider === 'claude') modelCache = { key: null, list: [] }
  const after = await agentVersion(provider)
  const ver = before !== after ? `updated \`${before}\` → \`${after}\``
    : /error|fail/i.test(note) ? `⚠️ update check failed — staying on \`${after}\` (${note.slice(0, 120)})`
    : `already on the latest (\`${after}\`)`
  return { provider, before, after, note, summary: ver, failed: /error|fail/i.test(note) }
}

function scheduleUpdateGuardCleanup(session) {
  const timer = setTimeout(() => {
    restarting.delete(session.id)
    updatingSessions.delete(session.id)
  }, 60000)
  timer.unref?.()
}

async function stopSessionForUpdate(session, message) {
  // Reserve synchronously after the caller's final liveness/busy check. Any
  // prompt arriving while the Slack notice or process stop is in flight is then
  // queued for this exact native session instead of racing a second wake.
  restarting.add(session.id)
  updatingSessions.add(session.id)
  if (message) await post(session.channel, message).catch(error => log('update notice failed', session.id.slice(0, 8), String(error)))
  const oldPid = session.pid
  if (session.tmux) await tmuxKill(session.tmux)
  if (oldPid && pidAlive(oldPid)) { try { process.kill(oldPid) } catch {} }
  stopPoller(session)
  await clearStatus(session)
  clearPermissionsForPid(oldPid, 'session restarting')
  session.pid = null
  saveStateNow(state)
  await sleep(1500) // let the old process fully exit before the binary is swapped
}

async function resumeUpdatedSession(session, update, updateError = null) {
  const label = providerLabel(providerOf(session))
  const summary = update?.summary || `⚠️ update check failed (${String(updateError || 'unknown error').slice(0, 120)})`
  await post(session.channel, `📦 ${label} ${summary}. Resuming the conversation…`).catch(error =>
    log('update result notice failed', session.id.slice(0, 8), String(error)))
  await resurrect(session)
  if (!session.tmux || !(await tmuxAlive(session.tmux))) throw new Error('replacement tmux session did not become active')
  scheduleUpdateGuardCleanup(session) // SessionStart normally clears this first
}

// /sab-update: stop this session's agent, update the CLI if a newer build exists,
// then resume the same conversation with identical launch flags.
async function updateAndRestart(session) {
  if (bulkUpdateRunning) return post(session.channel, '⏳ A bridge-wide session update is already running. This session will be included if it is idle.')
  if (updatingSessions.has(session.id)) return post(session.channel, '⏳ This session is already updating.')
  const provider = providerOf(session)
  const label = providerLabel(provider)
  try {
    await stopSessionForUpdate(session,
      `🔄 *Restarting ${path.basename(session.cwd)}* — stopping ${label}, checking for updates, then resuming with the same flags.`)
    const update = await updateProviderCli(provider)
    await resumeUpdatedSession(session, update)
  } catch (error) {
    restarting.delete(session.id)
    updatingSessions.delete(session.id)
    throw error
  }
}

function bulkUpdateContext() {
  return {
    busySessionIds: new Set([...pollers.keys(), ...codexPollers.keys(), ...piPollers.keys()]),
    questionSessionIds: new Set(qforms.keys()),
    pendingPermissionChannels: new Set(Object.values(state.perms || {}).map(permission => permission.channel).filter(Boolean)),
    transitionChannels: new Set(Object.keys(state.lineages || {}).filter(channel => activeTransition(channel))),
    internalSessionIds: new Set(internalTurns.keys()),
    restartingSessionIds: new Set([...restarting, ...updatingSessions]),
    wakingSessionIds: new Set(resurrectInFlight.keys()),
  }
}

async function revalidateBulkUpdateSession(session) {
  if (!session.channel || state.channels[session.channel] !== session.id || state.sessions[session.id] !== session) {
    return 'no longer the authoritative channel session'
  }
  if (!(session.pid && pidAlive(session.pid))) return 'provider process is no longer active'
  if (!session.tmux || !(await tmuxAlive(session.tmux))) return 'tmux session is no longer active'
  return bulkUpdateBlockReason(session, { ...bulkUpdateContext(), automations: state.automations })
}

function bulkUpdateReport({ providers, results, initiallySkipped }) {
  const resumed = results.filter(item => item.status === 'resumed')
  const skipped = [...initiallySkipped, ...results.filter(item => item.status === 'skipped')]
  const failed = results.filter(item => item.status === 'failed')
  const lines = [
    `🧰 *Session update sweep finished* — ${resumed.length} resumed · ${skipped.length} skipped · ${failed.length} failed.`,
  ]
  if (providers.length) {
    lines.push('', '*Provider updates*')
    for (const item of providers) {
      const summary = item.update?.summary || `⚠️ failed: ${String(item.error || 'unknown error').slice(0, 300)}`
      lines.push(`• ${providerLabel(item.provider)} — ${summary}`)
    }
  }
  if (resumed.length) {
    lines.push('', '*Resumed*')
    for (const item of resumed) lines.push(`• ${providerLabel(item.provider)} · \`${path.basename(item.session.cwd)}\` · \`${item.session.id.slice(0, 8)}\``)
  }
  if (skipped.length) {
    lines.push('', '*Skipped safely*')
    for (const item of skipped) lines.push(`• ${providerLabel(providerOf(item.session))} · \`${path.basename(item.session.cwd)}\` · ${item.reason}`)
  }
  if (failed.length) {
    lines.push('', '*Action required*')
    for (const item of failed) lines.push(`• ${providerLabel(item.provider)} · \`${path.basename(item.session.cwd)}\` · ${item.phase}: ${item.error.slice(0, 500)}`)
  }
  return lines.join('\n')
}

async function updateAllSessions(channel) {
  if (bulkUpdateRunning) return post(channel, '⏳ A bridge-wide session update is already running. Wait for its final report before retrying.')
  bulkUpdateRunning = true
  try {
    const plan = planBulkSessionUpdate(state, { pidAlive, ...bulkUpdateContext() })
    const eligible = []
    const initiallySkipped = [...plan.skipped]
    for (const session of plan.eligible) {
      if (await tmuxAlive(session.tmux)) eligible.push(session)
      else initiallySkipped.push({ session, reason: 'tmux session is not active' })
    }
    if (!eligible.length) {
      return postMd(channel, bulkUpdateReport({ providers: [], results: [], initiallySkipped }))
    }

    const providerCount = new Set(eligible.map(providerOf)).size
    await post(channel,
      `🧰 *Updating ${eligible.length} idle active session${eligible.length === 1 ? '' : 's'}* across ${providerCount} provider${providerCount === 1 ? '' : 's'}. ` +
      `${initiallySkipped.length} session${initiallySkipped.length === 1 ? ' was' : 's were'} skipped safely; each result will be listed when the sweep finishes.`)

    const result = await runBulkSessionUpdate(eligible, {
      revalidateSession: revalidateBulkUpdateSession,
      stopSession: session => stopSessionForUpdate(session,
        `🔄 *Scheduled maintenance* — updating ${providerLabel(providerOf(session))}, then resuming this conversation with the same flags.`),
      updateProvider: updateProviderCli,
      resumeSession: (session, { update, updateError }) => resumeUpdatedSession(session, update, updateError),
    })
    for (const item of result.results.filter(entry => entry.status === 'failed')) {
      restarting.delete(item.session.id)
      updatingSessions.delete(item.session.id)
      await post(item.session.channel,
        `❌ *Session update failed during ${item.phase}* — ${item.error.slice(0, 800)}. The conversation is preserved; write here to retry waking it.`).catch(() => {})
    }
    return postMd(channel, bulkUpdateReport({ ...result, initiallySkipped }))
  } finally {
    bulkUpdateRunning = false
  }
}

async function handleSlackMessage(channel, text, sender, request) {
  const trimmed = text.trim()

  // The owner may resolve a held permission even while a provider transition
  // is active (a safe-mode handoff/validation turn can itself need approval).
  const permissionReply = !sender && PERM_REPLY_RE.exec(trimmed)
  if (permissionReply) {
    const ok = await applyVerdict(permissionReply[2].toLowerCase(), /^y/i.test(permissionReply[1]) ? 'allow' : 'deny', channel)
    if (!ok) await post(channel, '⚠️ No open permission request with that code (it may have been answered or expired).')
    return
  }

  if (activeTransition(channel)) {
    if (sender) return post(channel, `🔀 Provider switch in progress — <@${sender.id}>’s message was not delivered. Only owner messages are queued during the transition.`)
    let position
    try { position = queueDuringTransition(channel, { kind: 'message', text: trimmed, request }) }
    catch { return post(channel, '⚠️ The provider-switch queue is full. Wait for the transition to finish, then resend this message.') }
    return post(channel, `⏸️ Provider switch in progress — queued your message (${position}).`)
  }

  const managedSession = sessionByChannel(channel)
  if (managedSession?.teamActiveTaskId) {
    return post(channel, `🕸️ Delegated team task \`${managedSession.teamActiveTaskId}\` currently owns this worker turn. Wait for its final response or use \`/sab-stop\` before sending unrelated work.`)
  }
  if (providerOf(managedSession) === 'pi' && (
    ['active', 'paused'].includes(managedSession?.managed?.status) || managedSession?.piRouting?.status === 'routing'
  )) {
    if (!sender && !(managedSession.pid && pidAlive(managedSession.pid))) {
      await resurrect(managedSession)
      return
    }
    return post(channel, managedSession?.piRouting?.status === 'routing'
      ? '🧭 Pi is already assessing another prompt. Wait for its routing decision or use `/sab-stop`.'
      : '🧭 A managed Pi run owns this session. Use `/sab-run status`, `/sab-run pause`, `/sab-run continue`, or `/sab-run cancel`; ordinary prompts resume after it completes or is cancelled.')
  }

  // Collaborators may only send prompts into a LIVE session: no permission
  // verdicts, no commands, and no resurrection (that would spawn a terminal on
  // the host). The prompt is attributed so the transcript shows who sent it.
  if (sender) {
    const session = sessionByChannel(channel)
    if (!session) { log('collab msg in unmapped channel, ignored', channel); return }
    if (!(session.pid && pidAlive(session.pid))) {
      return post(channel, `💤 Session is dormant — <@${sender.id}>’s message wasn’t delivered. Only the owner can resume it.`)
    }
    const attributed = `[Slack collaborator ${sender.name}]\n${trimmed}`
    beginSlackTeamTurn(session, sender, request)
    reserveTeamInput(session, 'slack')
    try {
      if (providerOf(session) === 'pi') {
        await injectText(session, attributed, {
          privateContext: artifactDeliveryContext(session, request), route: 'native',
        })
      } else await injectText(session, withArtifactDelivery(session, attributed, request))
    } catch (error) {
      clearTeamInputReservation(session)
      saveStateNow(state)
      throw error
    }
    return
  }

  // The ./ commands were retired in favour of native namespaced slash commands; nudge.
  const dot = /^\.\/(\w+)/.exec(trimmed)
  if (dot && RETIRED_CMDS.has(dot[1])) {
    const provider = providerOf(sessionByChannel(channel))
    return post(channel, `\`./\` commands are retired — use \`${slackCommand(provider, dot[1])}\` instead (type \`/sab-\` for the list).`)
  }

  const session = sessionByChannel(channel)
  if (!session) {
    if (channel === state.control) return post(channel, 'This is the control channel. Use `/sab-new <claude|codex|pi>` to start a session, or `/sab-status` to list them all.')
    log('inbound (unmapped channel, ignored)', channel)
    return
  }
  // An open question form eats pasted text, so route replies through it instead:
  // a bare number picks that option; anything else goes via "Type something" /
  // "Chat about this" when the form offers one.
  const q = qforms.get(session.id)
  if (q && Date.now() - q.at < 30 * 60000 && session.tmux && (await tmuxAlive(session.tmux))) {
    if (/^\d{1,2}$/.test(trimmed)) {
      const o = q.options.find(x => String(x.n) === trimmed)
      if (o) return answerQuestionForm(session, o.n, o.label)
    }
    const free = q.options.find(o => /type something/i.test(o.label)) || q.options.find(o => /chat about this/i.test(o.label)) || q.options.find(o => /tell claude what to change/i.test(o.label))
    if (free) {
      await answerQuestionForm(session, free.n, `${free.label} → “${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}”`)
      await sleep(700)
      return tmuxPaste(session.tmux, trimmed)
    }
    return post(channel, '❓ A question form is open — tap a button above or reply with just its number.')
  }
  reserveTeamInput(session, 'slack')
  try {
    if (providerOf(session) === 'pi') {
      await injectText(session, trimmed, { privateContext: ownerPromptPrivateContext(session, request) })
    } else await injectText(session, trimmed + ownerPromptPrivateContext(session, request))
  } catch (error) {
    clearTeamInputReservation(session)
    saveStateNow(state)
    throw error
  }
}
const RETIRED_CMDS = new Set(['model', 'effort', 'new', 'status', 'health', 'kill', 'cleanup', 'stop', 'help'])

// Deliver text into a session: prefer a tmux paste (full text shows in the TUI),
// fall back to a channel event, and resurrect the session if it's gone.
async function injectText(session, text, options = {}) {
  const provider = providerOf(session)
  if (updatingSessions.has(session.id)) {
    const queued = pendingBySid.get(session.id) || []
    const item = provider === 'pi'
      ? piPromptQueueItem(text, options)
      : `${String(text || '')}${String(options.privateContext || '')}`
    pendingBySid.set(session.id, [...queued, item])
    await post(session.channel, '⏸️ Provider maintenance is in progress — queued this message for the resumed session.')
    return
  }
  const alive = session.pid && pidAlive(session.pid)
  if (provider === 'pi') {
    const queuedPrompt = piPromptQueueItem(text, options)
    const combined = queuedPromptText(queuedPrompt)
    if (alive && injectQueuedPiPrompt(session.pid, queuedPrompt)) {
      rememberInjected(session.id, combined)
      log('inject (Pi extension) → session', session.id.slice(0, 8), JSON.stringify(String(text).slice(0, 50)))
      return
    }
    log('queue Pi prompt', session.id.slice(0, 8), 'pid', session.pid, 'cwd', session.cwd)
    const queued = pendingBySid.get(session.id) || []
    pendingBySid.set(session.id, [...queued, queuedPrompt])
    if (!alive) await resurrect(session, text)
    return
  }
  const delivered = `${String(text || '')}${String(options.privateContext || '')}`
  if (alive && session.tmux && (await tmuxAlive(session.tmux))) {
    rememberInjected(session.id, delivered)
    try {
      await tmuxPaste(session.tmux, delivered)
      log('inject (tmux) → session', session.id.slice(0, 8), JSON.stringify(delivered.slice(0, 50)))
      return
    } catch (e) {
      log('tmux paste failed, falling back to channel event', String(e))
    }
  }
  if (alive && injectToSession(session.pid, delivered)) {
    log('inject (channel) → session', session.id.slice(0, 8), JSON.stringify(delivered.slice(0, 50)))
    return
  }
  log('resurrect', session.id.slice(0, 8), 'pid', session.pid, 'cwd', session.cwd)
  const q = pendingBySid.get(session.id) || []
  pendingBySid.set(session.id, [...q, delivered])
  if (!alive) await resurrect(session, delivered)
}

// Fetch a Slack file with the bot token. Slack redirects url_private to its file
// origin on the same domain, so fetch keeps the Authorization header. Right after
// upload Slack briefly serves an HTML login page instead of the bytes, so retry
// with backoff until the real content shows up.
async function downloadSlackFile(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } })
      const ct = res.headers.get('content-type') || ''
      if (res.ok && !ct.includes('text/html')) return Buffer.from(await res.arrayBuffer())
    } catch (e) { log('download attempt failed', String(e)) }
    await sleep(800 * (i + 1))
  }
  return null
}

// Download files shared in a channel and inject them as local paths Claude can read.
async function handleAttachments(channel, caption, files, sender, request) {
  if (activeTransition(channel)) {
    if (sender) return post(channel, `🔀 Provider switch in progress — <@${sender.id}>’s attachment was not delivered.`)
    let position
    const queuedFiles = files.map(file => ({
      id: file.id, name: file.name, mimetype: file.mimetype, size: file.size,
      url_private: file.url_private, url_private_download: file.url_private_download,
    }))
    try { position = queueDuringTransition(channel, { kind: 'attachments', caption, files: queuedFiles, request }) }
    catch { return post(channel, '⚠️ The provider-switch queue is full. Wait for the transition to finish, then resend this attachment.') }
    return post(channel, `⏸️ Provider switch in progress — queued your attachment (${position}).`)
  }
  const session = sessionByChannel(channel)
  if (!session) { log('attachment in unmapped channel, ignored', channel); return }
  if (session.teamActiveTaskId) {
    return post(channel, `🕸️ Delegated team task \`${session.teamActiveTaskId}\` currently owns this worker turn. Wait for it to finish before sending unrelated attachments.`)
  }
  if (providerOf(session) === 'pi' && (
    ['active', 'paused'].includes(session.managed?.status) || session.piRouting?.status === 'routing'
  )) {
    return post(channel, session.piRouting?.status === 'routing'
      ? '🧭 Pi is already assessing another prompt. Wait for its routing decision or use `/sab-stop`.'
      : '🧭 A managed Pi run owns this session. Cancel it before sending another attachment.')
  }
  if (sender && !(session.pid && pidAlive(session.pid))) {
    return post(channel, `💤 Session is dormant — <@${sender.id}>’s attachment wasn’t delivered. Only the owner can resume it.`)
  }
  reserveTeamInput(session, 'slack-attachment')
  let injected = false
  try {
  const dir = path.join(CONFIG_DIR, 'attachments')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  const saved = []
  for (const f of files) {
    const dl = f.url_private_download || f.url_private
    if (!dl) continue
    const buf = await downloadSlackFile(dl)
    if (!buf) {
      log('attachment download failed', f.name)
      await post(channel, `⚠️ Couldn’t download \`${f.name || f.id}\` from Slack — try resending it.`)
      continue
    }
    const safe = String(f.name || f.id).replace(/[^\w.\-]+/g, '_')
    const p = path.join(dir, `${Date.now().toString(36)}-${safe}`)
    fs.writeFileSync(p, buf, { mode: 0o600 })
    saved.push({ path: p, mimetype: f.mimetype || 'application/octet-stream' })
    log('attachment saved', p, buf.length + 'b')
  }
  if (!saved.length) return
  const list = saved.map(file => `  • ${file.path}`).join('\n')
  const body = caption?.trim()
    ? `${caption.trim()}\n\n(I attached ${saved.length} file(s) from Slack — read them if relevant:\n${list}\n)`
    : `I attached ${saved.length} file(s) from Slack. Please read them:\n${list}`
  const attributed = sender ? `[Slack collaborator ${sender.name}]\n${body}` : body
  const teamPrivateContext = beginSlackTeamTurn(session, sender, request)
  if (providerOf(session) === 'pi') {
    await injectText(session, attributed, {
      files: saved, privateContext: artifactDeliveryContext(session, request) + teamPrivateContext,
      route: sender ? 'native' : null,
    })
    injected = true
    return
  }
  const delivered = withArtifactDelivery(session, attributed, request) + teamPrivateContext
  await injectText(session, delivered)
  injected = true
  } finally {
    if (!injected) {
      clearTeamInputReservation(session)
      saveStateNow(state)
    }
  }
}

// ---- bridge-owned session teams -------------------------------------------
// Agents never receive Slack credentials or choose raw Slack destinations.
// The local CLI proves its exact provider process/tmux; durable channel-level
// membership then resolves the only peers it may address. Worker results are
// returned through the task journal/CLI rather than pasted into a coordinator
// that may still be in the middle of its own turn.
const TEAM_RECONCILE_MS = 3000
const TEAM_RESTART_PROOF_GRACE_MS = 15_000
const teamDaemonStartedAt = Date.now()
let teamReconciler = null
let teamReconcileRunning = false
const teamTaskFileDeliveries = new Map()
const teamReplyDeliveries = new Map()
const teamCompletionDeliveries = new Map()
const teamTurnProof = new Set()
const teamContinuationTimers = new Map()
const teamCoordinatorIdleProof = new Map()

function recordTeamWorkerProof(session, task) {
  teamTurnProof.add(session.id)
  if (providerOf(session) !== 'codex' || session.codexTurnStartedAt) return false
  const claimedAt = Date.parse(task.dispatchClaimedAt || task.startedAt || '')
  session.codexTurnStartedAt = Number.isFinite(claimedAt) ? claimedAt : Date.now()
  delete session.codexUsageBaseline
  return true
}

function reserveTeamInput(session, source) {
  if (!session || session.teamInputReservation) return false
  session.teamInputReservation = { source, acceptedAt: new Date().toISOString() }
  saveStateNow(state)
  return true
}

function clearTeamInputReservation(session) {
  if (!session || !Object.hasOwn(session, 'teamInputReservation')) return false
  delete session.teamInputReservation
  return true
}

function discardQueuedTeamTaskPrompt(session, taskId) {
  if (!session?.id || !taskId) return false
  const queued = pendingBySid.get(session.id) || []
  const retained = withoutDelegatedTaskPrompt(queued, taskId)
  if (retained.length === queued.length) return false
  if (retained.length) pendingBySid.set(session.id, retained)
  else pendingBySid.delete(session.id)
  log('discarded failed queued team prompt', taskId, session.id.slice(0, 8))
  return true
}

function scheduleTeamContinuation(teamId, delay = 0) {
  if (teamContinuationTimers.has(teamId)) return
  const timer = setTimeout(() => {
    teamContinuationTimers.delete(teamId)
    runTeamContinuation(teamId).catch(error => log('team continuation failed', teamId, String(error?.message || error)))
  }, Math.max(0, delay))
  teamContinuationTimers.set(teamId, timer)
  timer.unref?.()
}

function teamContinuationBusyReason(session) {
  const reasons = []
  if (session.teamTurn) reasons.push('coordinator turn')
  if (session.teamInputReservation) reasons.push('input reservation')
  if (session.teamActiveTaskId) reasons.push('delegated task')
  if (session.codexTurnStartedAt || session.piTurnStartedAt || pollers.has(session.id) ||
      codexPollers.has(session.id) || piPollers.has(session.id)) reasons.push('provider turn')
  return reasons.join(', ')
}

async function reconcileIdleCodexCoordinator(team, coordinator) {
  const reset = () => teamCoordinatorIdleProof.delete(team.id)
  if (providerOf(coordinator) !== 'codex' || (!coordinator.teamTurn && !coordinator.teamInputReservation) ||
      coordinator.teamActiveTaskId ||
      pendingBySid.get(coordinator.id)?.length || qforms.has(coordinator.id) || hasPendingPerm(coordinator) ||
      activeTransition(coordinator.channel) || updatingSessions.has(coordinator.id) || restarting.has(coordinator.id) ||
      resurrectInFlight.has(coordinator.id) || switchingSids.has(coordinator.id) || internalTurns.has(coordinator.id) ||
      !(coordinator.pid && pidAlive(coordinator.pid) && coordinator.tmux && await tmuxAlive(coordinator.tmux))) {
    reset()
    return false
  }

  const expected = {
    sid: coordinator.id,
    pid: coordinator.pid,
    tmux: coordinator.tmux,
    turn: coordinator.teamTurn?.startedAt || null,
    input: coordinator.teamInputReservation?.acceptedAt || null,
    codex: coordinator.codexTurnStartedAt || null,
  }
  if (!(await validProviderRootClaim(expected.pid, expected.tmux, 'codex'))) {
    reset()
    return false
  }
  const pane = await tmuxCapture(expected.tmux)
  if (sessionByChannel(team.coordinatorChannel) !== coordinator ||
      state.channels?.[team.coordinatorChannel] !== expected.sid || coordinator.pid !== expected.pid ||
      coordinator.tmux !== expected.tmux || (coordinator.teamTurn?.startedAt || null) !== expected.turn ||
      (coordinator.teamInputReservation?.acceptedAt || null) !== expected.input ||
      (coordinator.codexTurnStartedAt || null) !== expected.codex) {
    reset()
    return false
  }

  const decision = observeIdleCodexCoordinator(coordinator, {
    ready: targetStartupState('codex', pane) === 'ready',
    previous: teamCoordinatorIdleProof.get(team.id),
  })
  if (decision.observation) teamCoordinatorIdleProof.set(team.id, decision.observation)
  else reset()
  if (decision.action !== 'release') return false

  // No awaits between the final identity check above and this mutation: a new
  // prompt/hook cannot replace the observed turn and then have its fences
  // cleared by this recovery path.
  stopPoller(coordinator)
  clearTeamTurn(coordinator)
  clearTeamInputReservation(coordinator)
  clearContinuationWaiting(team)
  reset()
  saveStateNow(state)
  log('reconciled hookless idle Codex coordinator', coordinator.id.slice(0, 8), team.id)
  await clearStatus(coordinator)
  await post(team.coordinatorChannel,
    '⚠️ Codex returned to idle without its lifecycle completion hook. SAB safely released the stale coordinator turn and is continuing from the authoritative team inbox.').catch(() => {})
  return true
}

async function runTeamContinuation(teamId) {
  const team = state.teams?.[teamId]
  if (!team || team.closedAt || team.continuation?.mode !== 'auto-until-blocked') return false
  const coalesced = coalesceContinuations(team)
  if (coalesced.changed) {
    saveStateNow(state)
    log('coalesced team continuation backlog', team.id, `${coalesced.count} events`)
  }
  const coordinator = sessionByChannel(team.coordinatorChannel)
  if (!coordinator || state.channels?.[team.coordinatorChannel] !== coordinator.id) {
    const event = team.continuation?.pending?.[0]
    if (event) {
      const claimed = claimContinuation(team)
      settleContinuation(team, claimed.id, { status: 'needs_owner', error: 'Coordinator session is not authoritative.' })
      saveStateNow(state)
      await post(team.coordinatorChannel, '⚠️ Team continuation is waiting: the coordinator session is not currently authoritative.').catch(() => {})
    }
    return false
  }
  await reconcileIdleCodexCoordinator(team, coordinator)
  // The reconciliation probe awaits process and tmux inspection. A provider
  // switch or channel rebind may win that race; never continue through the
  // coordinator object captured before those awaits.
  if (sessionByChannel(team.coordinatorChannel) !== coordinator ||
      state.channels?.[team.coordinatorChannel] !== coordinator.id) {
    teamCoordinatorIdleProof.delete(team.id)
    scheduleTeamContinuation(teamId, 1000)
    return false
  }
  if (coordinator.teamTurn || coordinator.teamInputReservation || coordinator.teamActiveTaskId ||
      coordinator.codexTurnStartedAt || coordinator.piTurnStartedAt || pollers.has(coordinator.id) ||
      codexPollers.has(coordinator.id) || piPollers.has(coordinator.id)) {
    const reason = teamContinuationBusyReason(coordinator)
    const waiting = noteContinuationWaiting(team, reason)
    if (waiting.changed) saveStateNow(state)
    if (waiting.notify) {
      await post(team.coordinatorChannel,
        `⏳ Team continuation is queued while the coordinator remains busy (${reason}). SAB will continue automatically when its current turn finishes.`).catch(() => {})
    }
    scheduleTeamContinuation(teamId, 5000)
    return false
  }
  if (clearContinuationWaiting(team)) saveStateNow(state)
  const event = claimContinuation(team)
  if (!event) return false
  saveStateNow(state)
  try {
    beginOwnerTeamTurn(coordinator, { messageTs: `team-continuation:${event.id}` }, { budget: 20 })
    saveStateNow(state)
    const eventDescription = Number(event.coalescedCount) > 1
      ? `${event.coalescedCount} queued team events (latest task ${event.taskId})`
      : `a new ${event.kind} event (task ${event.taskId})`
    await injectText(coordinator,
      `SYSTEM NOTIFICATION: Team executors produced ${eventDescription}. ` +
      'Read the authoritative team inbox and context now. Handle any blocker or dispatch the next approved, non-overlapping slice. ' +
      'Do not assume the event payload is complete.',
      { privateContext: `\n\n${coordinatorPromptContext(state, coordinator.channel)}` })
    settleContinuation(team, event.id, { status: 'succeeded' })
    saveStateNow(state)
    return true
  } catch (error) {
    deferContinuation(team, event.id)
    team.continuation.pending[0].error = String(error?.message || error).slice(0, 1000)
    saveStateNow(state)
    scheduleTeamContinuation(teamId, 15000)
    await post(team.coordinatorChannel, `⚠️ Team continuation is retrying: ${String(error?.message || error).slice(0, 400)}`).catch(() => {})
    return false
  }
}

function teamTaskStatusText(task) {
  const icon = task.status === 'completed' ? '✅'
    : task.status === 'failed' ? '❌'
      : task.status === 'cancelled' ? '🚫'
        : task.status === 'running' ? '⚙️'
          : task.status === 'dispatching' ? '📨' : '⏳'
  const detail = task.error ? ` — ${String(task.error).slice(0, 600)}` : ''
  return `${icon} *Team task* \`${task.id}\` · ${task.status}${detail}`
}

function teamAuditClientId(task, side) {
  const hex = crypto.createHash('sha256').update(`${task.id}:${side}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

function teamTaskPayloadText(task, destination) {
  const direction = destination === 'source'
    ? `➡️ Delegated to <#${task.targetChannel}> (\`${task.targetAlias}\`)`
    : `⬅️ Delegated by <#${task.sourceChannel}>`
  const files = task.files?.length
    ? `\n\n*Files*\n${task.files.map(file => `• \`${String(file.filename).replace(/`/g, "'")}\` · ${file.size} bytes`).join('\n')}`
    : ''
  return `📋 *Team task* \`${task.id}\`\n${direction}\n\n${task.text || '_File-only task._'}${files}`
}

async function ensureTeamTaskAudit(task) {
  try {
    if (!task.sourcePayloadSlackTs) {
      const payload = await postSlackMessage(task.sourceChannel, {
        text: teamTaskPayloadText(task, 'source'),
        unfurl_links: false,
        client_msg_id: teamAuditClientId(task, 'source-payload'),
      })
      task.sourcePayloadSlackTs = payload?.ts || null
      saveStateNow(state)
    }
    if (!task.sourceSlackTs) {
      const source = await postSlackMessage(task.sourceChannel, {
        text: `${teamTaskStatusText(task)}\n➡️ <#${task.targetChannel}> (\`${task.targetAlias}\`)`,
        unfurl_links: false,
        client_msg_id: teamAuditClientId(task, 'source'),
      })
      task.sourceSlackTs = source?.ts || null
      saveStateNow(state)
    }
    if (!task.targetPayloadSlackTs) {
      const payload = await postSlackMessage(task.targetChannel, {
        text: teamTaskPayloadText(task, 'target'),
        unfurl_links: false,
        client_msg_id: teamAuditClientId(task, 'target-payload'),
      })
      task.targetPayloadSlackTs = payload?.ts || null
      saveStateNow(state)
    }
    if (!task.targetSlackTs) {
      const target = await postSlackMessage(task.targetChannel, {
        text: `${teamTaskStatusText(task)}\n⬅️ <#${task.sourceChannel}>`,
        unfurl_links: false,
        client_msg_id: teamAuditClientId(task, 'target'),
      })
      task.targetSlackTs = target?.ts || null
      saveStateNow(state)
    }
  } catch (error) {
    failTeamTask(state, task.id, `Slack audit delivery failed: ${error?.data?.error || error?.message || error}`)
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    throw new TeamError('slack_audit_failed', 'Slack could not create the required visible team-task audit trail.', 502)
  }
}

async function updateTeamTaskAudit(task) {
  const textFor = channel => channel === task.sourceChannel
    ? `${teamTaskStatusText(task)}\n➡️ <#${task.targetChannel}> (\`${task.targetAlias}\`)`
    : `${teamTaskStatusText(task)}\n⬅️ <#${task.sourceChannel}>`
  let failure = null
  for (const [channel, ts] of [[task.sourceChannel, task.sourceSlackTs], [task.targetChannel, task.targetSlackTs]]) {
    if (!ts) continue
    try { await enqueue(channel, () => web.chat.update({ channel, ts, text: textFor(channel) })) }
    catch (error) {
      failure ||= error
      log('team audit update failed', task.id, channel, error?.data?.error || String(error))
    }
  }
  return !failure
}

async function performTeamCompletionDelivery(task) {
  if (!['completed', 'failed', 'cancelled'].includes(task.status)) return false
  if (task.completionDeliveryStatus === 'delivered') return true
  task.completionDeliveryStatus = 'delivering'
  task.completionDeliveryAttempts = Number(task.completionDeliveryAttempts || 0) + 1
  saveStateNow(state)
  try {
    const auditUpdated = await updateTeamTaskAudit(task)
    const auditWarning = auditUpdated ? '' : '\n\n⚠️ The result is complete, but one or more earlier task status cards could not be updated.'
    if (!task.completionSlackTs) {
      const text = task.status === 'completed'
        ? `📬 *Team result from* <#${task.targetChannel}> · \`${task.id}\`\n\n${task.result || '_Worker completed without text._'}${auditWarning}`
        : `${teamTaskStatusText(task)} from <#${task.targetChannel}>${auditWarning}`
      const message = await postSlackMessage(task.sourceChannel, {
        text,
        unfurl_links: false,
        client_msg_id: teamAuditClientId(task, 'completion'),
      })
      task.completionSlackTs = message?.ts || null
    }
    task.completionDeliveryStatus = 'delivered'
    task.completionDeliveryError = auditUpdated
      ? null
      : 'Completion was delivered, but one or more task status cards could not be updated.'
    task.completionDeliveredAt = new Date().toISOString()
    saveStateNow(state)
    return true
  } catch (error) {
    task.completionDeliveryStatus = 'pending'
    task.completionDeliveryError = String(error?.data?.error || error?.message || error).slice(0, 1000)
    saveStateNow(state)
    throw new TeamError('completion_delivery_failed', 'Slack did not accept the team completion update; SAB will retry it.', 502)
  }
}

function ensureTeamCompletionDelivery(task) {
  const existing = teamCompletionDeliveries.get(task.id)
  if (existing) return existing
  const operation = performTeamCompletionDelivery(task)
  teamCompletionDeliveries.set(task.id, operation)
  return operation.finally(() => {
    if (teamCompletionDeliveries.get(task.id) === operation) teamCompletionDeliveries.delete(task.id)
  })
}

function teamTargetBusy(session) {
  return Boolean(
    session.teamActiveTaskId || session.teamInputReservation ||
    pollers.has(session.id) || codexPollers.has(session.id) || piPollers.has(session.id) ||
    session.codexTurnStartedAt || session.piTurnStartedAt || pendingBySid.get(session.id)?.length ||
    qforms.has(session.id) || hasPendingPerm(session) || activeTransition(session.channel) ||
    updatingSessions.has(session.id) || restarting.has(session.id) || resurrectInFlight.has(session.id) || switchingSids.has(session.id) ||
    internalTurns.has(session.id) || ['active', 'paused'].includes(session.managed?.status) ||
    session.piRouting?.status === 'routing'
  )
}

function removeTeamFiles(id) {
  try { deleteTeamFiles(CONFIG_DIR, id) }
  catch (error) { log('team file cleanup failed', id, String(error?.message || error)) }
}

function removeTeamTaskFiles(task) {
  try { deleteTeamTaskFiles(CONFIG_DIR, task) }
  catch (error) { log('team task file cleanup failed', task?.id, String(error?.message || error)) }
}

function stageTeamFiles(session, requestedPaths, id) {
  return stagePrivateTeamFiles(CONFIG_DIR, session.cwd, requestedPaths, id)
}

async function uploadTeamFiles(channel, files, comment) {
  if (!files.length) return
  const options = {
    channel_id: channel,
    initial_comment: comment,
    file_uploads: files.map(file => ({ file: file.path, filename: file.filename, title: file.filename })),
  }
  if (files.length === 1) {
    delete options.file_uploads
    options.file = files[0].path
    options.filename = files[0].filename
    options.title = files[0].filename
  }
  await enqueue(channel, () => web.filesUploadV2(options))
  await bumpStatusForChannel(channel)
}

async function performTeamTaskFileDelivery(task) {
  if (!task.files?.length || task.fileDeliveryStatus === 'none' || task.fileDeliveryStatus === 'uploaded') return true
  if (task.fileDeliveryStatus === 'uploading') {
    task.fileDeliveryStatus = 'failed'
    task.fileDeliveryError = 'Slack file upload outcome became uncertain during daemon restart; SAB did not retry it to avoid duplicate delivery.'
    failTeamTask(state, task.id, task.fileDeliveryError)
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    throw new TeamError('file_relay_uncertain', task.fileDeliveryError, 409)
  }
  if (task.fileDeliveryStatus === 'failed') {
    throw new TeamError('file_relay_failed', task.fileDeliveryError || 'The team task file relay failed.', 409)
  }
  const team = state.teams?.[task.teamId]
  const member = team && !team.closedAt ? team.members?.[task.targetChannel] : null
  if (member?.role !== 'worker' || !member.files) {
    task.fileDeliveryStatus = 'failed'
    task.fileDeliveryError = 'Team file permission was revoked before this task could be delivered.'
    failTeamTask(state, task.id, task.fileDeliveryError)
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    throw new TeamError('files_not_allowed', task.fileDeliveryError, 403)
  }
  task.fileDeliveryStatus = 'uploading'
  saveStateNow(state)
  try {
    await uploadTeamFiles(task.targetChannel, task.files,
      `📎 Team task \`${task.id}\` from <#${task.sourceChannel}>`)
    task.fileDeliveryStatus = 'uploaded'
    saveStateNow(state)
    return true
  } catch (error) {
    task.fileDeliveryStatus = 'failed'
    task.fileDeliveryError = `Slack file relay failed: ${error?.data?.error || error?.message || error}`
    failTeamTask(state, task.id, task.fileDeliveryError)
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    throw new TeamError('file_relay_failed', 'Slack did not accept the team task files.', 502)
  }
}

function ensureTeamTaskFileDelivery(task) {
  const existing = teamTaskFileDeliveries.get(task.id)
  if (existing) return existing
  const operation = performTeamTaskFileDelivery(task)
  teamTaskFileDeliveries.set(task.id, operation)
  return operation.finally(() => {
    if (teamTaskFileDeliveries.get(task.id) === operation) teamTaskFileDeliveries.delete(task.id)
  })
}

async function notifyTeamReplyFileFailure(task, reply) {
  if (reply.fileDeliveryNotifiedAt) return
  const notified = await post(task.sourceChannel,
    `⚠️ Team reply file delivery for \`${task.id}\` failed safely — ${String(reply.fileDeliveryError || 'unknown failure').slice(0, 800)}`)
    .then(() => true, () => false)
  if (!notified) return
  reply.fileDeliveryNotifiedAt = new Date().toISOString()
  saveStateNow(state)
}

async function performTeamReplyDelivery(task, reply) {
  if (reply.text && !reply.textSlackTs) {
    const message = await postSlackMessage(task.sourceChannel, {
      text: `📨 *Team update from* <#${task.targetChannel}> · \`${task.id}\`\n\n${reply.text}`,
      unfurl_links: false,
      client_msg_id: teamAuditClientId(task, reply.id),
    })
    reply.textSlackTs = message?.ts || null
    saveStateNow(state)
  }
  if (!reply.files?.length || reply.fileDeliveryStatus === 'none' || reply.fileDeliveryStatus === 'uploaded') return true
  if (reply.fileDeliveryStatus === 'uploading') {
    reply.fileDeliveryStatus = 'failed'
    reply.fileDeliveryError = 'Slack file upload outcome became uncertain during daemon restart; SAB did not retry it to avoid duplicate delivery.'
    saveStateNow(state)
    await notifyTeamReplyFileFailure(task, reply)
    throw new TeamError('file_relay_uncertain', reply.fileDeliveryError, 409)
  }
  if (reply.fileDeliveryStatus === 'failed') {
    await notifyTeamReplyFileFailure(task, reply)
    throw new TeamError('file_relay_failed', reply.fileDeliveryError || 'The team reply file relay failed.', 409)
  }
  const team = state.teams?.[task.teamId]
  const member = team && !team.closedAt ? team.members?.[task.targetChannel] : null
  if (member?.role !== 'worker' || !member.files) {
    reply.fileDeliveryStatus = 'failed'
    reply.fileDeliveryError = 'Team file permission was revoked before this reply could be delivered.'
    saveStateNow(state)
    await notifyTeamReplyFileFailure(task, reply)
    throw new TeamError('files_not_allowed', reply.fileDeliveryError, 403)
  }
  reply.fileDeliveryStatus = 'uploading'
  saveStateNow(state)
  try {
    await uploadTeamFiles(task.sourceChannel, reply.files,
      `📎 Team reply for \`${task.id}\` from <#${task.targetChannel}>`)
    reply.fileDeliveryStatus = 'uploaded'
    saveStateNow(state)
    return true
  } catch (error) {
    reply.fileDeliveryStatus = 'failed'
    reply.fileDeliveryError = `Slack file relay failed: ${error?.data?.error || error?.message || error}`
    saveStateNow(state)
    await notifyTeamReplyFileFailure(task, reply)
    throw new TeamError('file_relay_failed', 'Slack did not accept the team reply files.', 502)
  }
}

function ensureTeamReplyDelivery(task, reply) {
  const existing = teamReplyDeliveries.get(reply.id)
  if (existing) return existing
  const operation = performTeamReplyDelivery(task, reply)
  teamReplyDeliveries.set(reply.id, operation)
  return operation.finally(() => {
    if (teamReplyDeliveries.get(reply.id) === operation) teamReplyDeliveries.delete(reply.id)
  })
}

async function resolveTeamCaller({ ppid, tmux, provider: providerValue }) {
  const provider = normalizeProvider(providerValue, null)
  const tname = String(tmux || '')
  if (!provider || !tname) throw new TeamError('unauthorized_session', 'The command must come from a live bridged session.', 403)
  const pid = await resolveAgentPid(ppid, provider)
  const session = sessionByPid(pid)
  const tmuxClaimed = Boolean(session) && await validProviderRootClaim(pid, tname, provider)
  const valid = validTeamCallerBinding(state, session, {
    pid, tmux: tname, provider, live: pidAlive(pid), tmuxClaimed,
  })
  if (!valid) {
    throw new TeamError('unauthorized_session', 'The command must come from its exact authoritative live session.', 403)
  }
  return session
}

function requireTeamCallerContext(session) {
  const context = teamContext(state, session.channel)
  if (!context) throw new TeamError('not_a_team_member', 'This SAB session channel is not in an active team.', 404)
  return context
}

function teamRuntimeContext(session) {
  const context = requireTeamCallerContext(session)
  const team = teamById(state, context.id)
  const peers = context.peers.map(peer => {
    const channel = Object.entries(team.members || {}).find(([, member]) => member.alias === peer.alias)?.[0]
    const target = channel ? sessionByChannel(channel) : null
    const authoritative = Boolean(target && state.channels?.[channel] === target.id && target.channel === channel)
    const live = authoritative && target.pid && pidAlive(target.pid)
    const availability = !authoritative ? 'unavailable'
      : activeTransition(channel) ? 'switching'
        : !live ? 'dormant'
          : teamTargetBusy(target) ? 'busy' : 'ready'
    return {
      ...peer,
      provider: authoritative ? providerOf(target) : null,
      availability,
    }
  })
  return { ...context, peers }
}

async function dispatchTeamTask(task) {
  if (task.status !== 'queued') return false
  if (!task.sourcePayloadSlackTs || !task.sourceSlackTs || !task.targetPayloadSlackTs || !task.targetSlackTs) {
    try { await ensureTeamTaskAudit(task) }
    catch { return false }
  }
  let team
  try { team = teamById(state, task.teamId) }
  catch (error) {
    failTeamTask(state, task.id, error.message)
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    return false
  }
  const sourceMember = team.members?.[task.sourceChannel]
  const targetMember = team.members?.[task.targetChannel]
  if (sourceMember?.role !== 'coordinator' || targetMember?.role !== 'worker') {
    failTeamTask(state, task.id, 'Team membership changed before delivery.')
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    return false
  }
  const target = sessionByChannel(task.targetChannel)
  if (!target || state.channels?.[task.targetChannel] !== target.id) {
    failTeamTask(state, task.id, 'The target channel no longer has an authoritative SAB session.')
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    return false
  }
  try { await ensureTeamTaskFileDelivery(task) }
  catch { return false }
  if (task.status !== 'queued') return false
  if (!(target.pid && pidAlive(target.pid) && target.tmux && await tmuxAlive(target.tmux))) return false
  if (teamTargetBusy(target)) return false
  const prompt = delegatedTaskPrompt(team, task, task.files)
  claimTeamTask(state, task.id, {
    targetSessionId: target.id,
    targetProvider: providerOf(target),
    targetNodeId: nodeIdForSession(target),
  })
  target.teamActiveTaskId = task.id
  clearTeamTurn(target)
  saveStateNow(state)
  await updateTeamTaskAudit(task)
  try {
    if (providerOf(target) === 'pi') await injectText(target, prompt, { route: 'native', files: task.files })
    else await injectText(target, prompt)
    log('team task injection accepted; awaiting provider marker', task.id,
      task.sourceChannel, '→', task.targetChannel, target.id.slice(0, 8))
    return true
  } catch (error) {
    delete target.teamActiveTaskId
    failTeamTask(state, task.id, `Provider injection failed: ${String(error?.message || error).slice(0, 1000)}`)
    saveStateNow(state)
    await updateTeamTaskAudit(task)
    return false
  }
}

async function reconcileTeamTasks() {
  if (teamReconcileRunning) return
  teamReconcileRunning = true
  try {
    const now = Date.now()
    const tasks = Object.values(state.teamTasks || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    for (const task of tasks) {
      const terminal = ['completed', 'failed', 'cancelled'].includes(task.status)
      // Tasks written by the first session-team implementation predate the
      // durable completion-delivery claim. Their terminal result was already
      // posted synchronously, so mark it delivered instead of duplicating it
      // during the first reconciliation after upgrade.
      if (terminal && !Object.hasOwn(task, 'completionDeliveryStatus')) {
        task.completionDeliveryStatus = 'delivered'
        task.completionDeliveryError = null
        task.completionDeliveredAt = task.completedAt || task.updatedAt || new Date(now).toISOString()
        saveStateNow(state)
      }
      for (const reply of task.replies || []) {
        if (!reply.textSlackTs || ['pending', 'uploading'].includes(reply.fileDeliveryStatus) ||
            (reply.fileDeliveryStatus === 'failed' && !reply.fileDeliveryNotifiedAt)) {
          await ensureTeamReplyDelivery(task, reply).catch(error =>
            log('team reply reconciliation failed', task.id, reply.id, String(error?.message || error)))
        }
      }
      if (terminal && task.completionDeliveryStatus !== 'delivered') {
        await ensureTeamCompletionDelivery(task).catch(error =>
          log('team completion reconciliation failed', task.id, String(error?.message || error)))
      }
      if (terminal && teamTaskDeliverySettled(task) && Date.parse(task.expiresAt || 0) <= now) {
        delete state.teamTasks[task.id]
        saveStateNow(state)
        removeTeamTaskFiles(task)
        continue
      }
      if (['queued', 'dispatching', 'running'].includes(task.status) && Date.parse(task.expiresAt || 0) <= now) {
        const target = task.targetSessionId ? state.sessions?.[task.targetSessionId] : null
        if (target?.teamActiveTaskId === task.id) delete target.teamActiveTaskId
        if (target) {
          discardQueuedTeamTaskPrompt(target, task.id)
          clearTeamTurn(target)
          clearTeamInputReservation(target)
          teamTurnProof.delete(target.id)
        }
        failTeamTask(state, task.id, 'The delegated team task exceeded its seven-day lifetime and was released safely.')
        saveStateNow(state)
        await ensureTeamCompletionDelivery(task).catch(error =>
          log('team expiry delivery deferred', task.id, String(error?.message || error)))
      } else if (task.status === 'queued') await dispatchTeamTask(task)
      else if (['dispatching', 'running'].includes(task.status)) {
        const target = state.sessions?.[task.targetSessionId]
        if (!target || target.channel !== task.targetChannel || state.channels?.[task.targetChannel] !== target.id ||
            target.teamActiveTaskId !== task.id || !(target.pid && pidAlive(target.pid))) {
          if (target?.teamActiveTaskId === task.id) {
            delete target.teamActiveTaskId
            discardQueuedTeamTaskPrompt(target, task.id)
          }
          failTeamTask(state, task.id, 'The assigned worker session ended or lost exact task/channel authority.')
          saveStateNow(state)
          await ensureTeamCompletionDelivery(task).catch(error =>
            log('team authority-loss delivery deferred', task.id, String(error?.message || error)))
        } else if (task.status === 'dispatching' && task.replies?.length) {
          // A reply already journaled by the exact authenticated worker proves
          // the delegated prompt was accepted even when Codex omitted its
          // UserPromptSubmit hook. This also heals reply/task pairs written by
          // an older daemon before this acceptance rule existed.
          const firstReplyAt = Date.parse(task.replies[0]?.createdAt || '')
          markTeamTaskRunning(state, task.id, { now: Number.isFinite(firstReplyAt) ? firstReplyAt : now })
          saveStateNow(state)
          await updateTeamTaskAudit(task).catch(error =>
            log('team reply acceptance audit deferred', task.id, String(error?.message || error)))
        } else if (task.status === 'dispatching' && Date.parse(task.dispatchClaimedAt || 0) + 5 * 60 * 1000 <= now &&
            !pollers.has(target.id) && !codexPollers.has(target.id) && !piPollers.has(target.id)) {
          if (target.teamActiveTaskId === task.id) delete target.teamActiveTaskId
          discardQueuedTeamTaskPrompt(target, task.id)
          failTeamTask(state, task.id, 'Delivery became uncertain before the provider acknowledged the delegated turn; SAB did not retry it to avoid duplicate work.')
          saveStateNow(state)
          await ensureTeamCompletionDelivery(task).catch(error =>
            log('team dispatch failure delivery deferred', task.id, String(error?.message || error)))
        } else if (task.status === 'running' && Date.parse(task.startedAt || 0) < teamDaemonStartedAt &&
            Date.now() - teamDaemonStartedAt >= TEAM_RESTART_PROOF_GRACE_MS && !teamTurnProof.has(target.id)) {
          delete target.teamActiveTaskId
          clearTeamInputReservation(target)
          failTeamTask(state, task.id,
            'The daemon restarted while this worker turn was active, but no live-turn proof returned; SAB released it without retrying or misattributing a final.')
          saveStateNow(state)
          await ensureTeamCompletionDelivery(task).catch(error =>
            log('team restart recovery delivery deferred', task.id, String(error?.message || error)))
        }
      }
    }
  } finally { teamReconcileRunning = false }
}

function startTeamReconciler() {
  if (teamReconciler) return
  teamReconciler = setInterval(() => reconcileTeamTasks().catch(error => log('team reconciliation failed', String(error))), TEAM_RECONCILE_MS)
  teamReconciler.unref?.()
  reconcileTeamTasks().then(() => {
    for (const team of Object.values(state.teams || {})) {
      if (team?.continuation?.mode === 'auto-until-blocked' && team.continuation.pending?.length) scheduleTeamContinuation(team.id)
    }
  }).catch(error => log('team reconciliation failed', String(error)))
}

async function finishTeamTaskForSession(session, result, error = null) {
  const taskId = session.teamActiveTaskId
  const finalText = String(result || '').trim()
  const revokedTurn = clearTeamTurn(session)
  if (!taskId) {
    if (revokedTurn) saveStateNow(state)
    else saveState(state)
    return false
  }
  delete session.teamActiveTaskId
  let task
  try {
    task = teamTask(state, taskId)
    if (error || !finalText) failTeamTask(state, task.id, error || 'The worker turn ended without a stable final response.')
    else completeTeamTask(state, task.id, { targetSessionId: session.id, result: finalText })
  } catch (failure) {
    log('team task completion rejected', taskId, String(failure?.message || failure))
    saveStateNow(state)
    return false
  }
  saveStateNow(state)
  const team = state.teams?.[task.teamId]
  if (team) {
    try {
      queueContinuation(team, { taskId: task.id, kind: error ? 'failed' : 'completed' })
      saveStateNow(state)
      scheduleTeamContinuation(task.teamId)
    } catch (failure) { log('team continuation queue full', task.id, String(failure?.message || failure)) }
  }
  await ensureTeamCompletionDelivery(task).catch(failure =>
    log('team completion delivery deferred', task.id, String(failure?.message || failure)))
  teamTurnProof.delete(session.id)
  setImmediate(() => reconcileTeamTasks().catch(failure => log('team follow-up dispatch failed', String(failure))))
  return true
}

async function failTeamTaskForSession(session, reason) {
  const taskId = session?.teamActiveTaskId
  const revokedTurn = clearTeamTurn(session)
  if (!taskId) {
    if (revokedTurn) saveStateNow(state)
    return false
  }
  delete session.teamActiveTaskId
  discardQueuedTeamTaskPrompt(session, taskId)
  let task
  try { task = failTeamTask(state, taskId, reason) }
  catch { saveStateNow(state); return false }
  saveStateNow(state)
  const team = state.teams?.[task.teamId]
  if (team) {
    try {
      queueContinuation(team, { taskId: task.id, kind: 'failed' })
      saveStateNow(state)
      scheduleTeamContinuation(task.teamId)
    } catch (failure) { log('team continuation queue full', task.id, String(failure?.message || failure)) }
  }
  await ensureTeamCompletionDelivery(task).catch(error =>
    log('team failure delivery deferred', task.id, String(error?.message || error)))
  teamTurnProof.delete(session.id)
  return true
}

const teamService = {
  async context(caller) {
    const session = await resolveTeamCaller(caller)
    return teamRuntimeContext(session)
  },
  async peers(caller) {
    const session = await resolveTeamCaller(caller)
    return teamRuntimeContext(session).peers
  },
  async inbox(caller, { limit, after } = {}) {
    const session = await resolveTeamCaller(caller)
    requireTeamCallerContext(session)
    return tasksForChannel(state, session.channel, { limit, after }).map(task => publicTeamTask(task, session.channel))
  },
  async task(caller, taskId) {
    const session = await resolveTeamCaller(caller)
    requireTeamCallerContext(session)
    return publicTeamTask(teamTask(state, taskId), session.channel)
  },
  async send(caller, request) {
    const session = await resolveTeamCaller(caller)
    const context = requireTeamCallerContext(session)
    if (context.role !== 'coordinator') throw new TeamError('dispatch_not_allowed', 'Only the team coordinator may create worker tasks.', 403)
    if (activeTransition(session.channel) || switchingSids.has(session.id)) throw new TeamError('source_switching', 'The coordinator is switching providers.', 409)
    const destination = resolveTeamPeer(state, context.id, request.to)
    const destinationSession = sessionByChannel(destination.channel)
    if (!destinationSession || state.channels?.[destination.channel] !== destinationSession.id ||
        destinationSession.channel !== destination.channel || nodeIdForSession(destinationSession) !== LOCAL_NODE_ID) {
      throw new TeamError('target_authority_lost', 'That worker no longer has an authoritative local SAB session.', 409)
    }
    const prior = teamTaskForRequest(state, session.channel, request.requestId)
    if (prior) {
      let retryFiles = []
      try {
        retryFiles = request.paths?.length ? teamSourceFileMetadata(session.cwd, request.paths) : []
      }
      catch (error) {
        if (error instanceof ArtifactUploadError) throw new TeamError(error.code, error.message, error.status)
        throw error
      }
      assertTeamTaskRetry(state, prior, { teamId: context.id, target: request.to, text: request.text, files: retryFiles })
      return { task: publicTeamTask(prior, session.channel), created: false }
    }
    assertCoordinatorDispatch(session)
    const taskId = `task_${crypto.randomBytes(12).toString('base64url')}`
    let files = []
    try { files = stageTeamFiles(session, request.paths || [], taskId) }
    catch (error) {
      if (error instanceof ArtifactUploadError) throw new TeamError(error.code, error.message, error.status)
      throw error
    }
    let result
    try {
      result = createTeamTask(state, {
        id: taskId,
        teamId: context.id,
        sourceChannel: session.channel,
        sourceSessionId: session.id,
        sourceProvider: providerOf(session),
        sourceNodeId: nodeIdForSession(session),
        target: request.to,
        text: request.text,
        files,
        requestId: request.requestId,
      })
    } catch (error) {
      if (files.length) removeTeamFiles(taskId)
      throw error
    }
    consumeCoordinatorDispatch(session)
    saveStateNow(state)
    for (const removed of result.pruned || []) removeTeamTaskFiles(removed)
    await ensureTeamTaskAudit(result.task)
    await dispatchTeamTask(result.task)
    return { task: publicTeamTask(result.task, session.channel), created: true }
  },
  async reply(caller, request) {
    const session = await resolveTeamCaller(caller)
    requireTeamCallerContext(session)
    const task = teamTask(state, request.taskId)
    if (task.targetChannel !== session.channel || task.targetSessionId !== session.id) {
      throw new TeamError('reply_not_allowed', 'This native worker session does not own that task.', 403)
    }
    const priorReply = task.replies.find(reply => reply.requestId === request.requestId)
    if (priorReply) {
      let retryFiles = []
      try { retryFiles = request.paths?.length ? teamSourceFileMetadata(session.cwd, request.paths) : [] }
      catch (error) {
        if (error instanceof ArtifactUploadError) throw new TeamError(error.code, error.message, error.status)
        throw error
      }
      const appended = appendTeamTaskReply(state, task.id, {
        requestId: request.requestId, fromChannel: session.channel, text: request.text, files: retryFiles,
      })
      const workerProof = appended.accepted ||
        (task.status === 'running' && session.teamActiveTaskId === task.id)
      const startCodexStatus = workerProof && recordTeamWorkerProof(session, task)
      if (appended.accepted || startCodexStatus) {
        saveStateNow(state)
        if (startCodexStatus) startCodexPoller(session)
      }
      if (appended.accepted) {
        await updateTeamTaskAudit(task).catch(error =>
          log('team reply acceptance audit deferred', task.id, String(error?.message || error)))
      }
      const team = state.teams?.[task.teamId]
      if (team && shouldWakeForTeamReply(team, appended)) {
        try {
          queueContinuation(team, { taskId: task.id, replyId: appended.reply.id, kind: 'reply' })
          saveStateNow(state)
          scheduleTeamContinuation(task.teamId)
        } catch (failure) { log('team continuation queue full', task.id, String(failure?.message || failure)) }
      }
      await ensureTeamReplyDelivery(task, appended.reply)
      return {
        reply: publicTeamTask(task, task.sourceChannel).replies.find(item => item.id === appended.reply.id),
        task: publicTeamTask(task, task.sourceChannel),
        created: false,
      }
    }
    if (session.teamActiveTaskId !== task.id) {
      throw new TeamError('reply_not_allowed', 'This live worker session no longer owns that active task.', 403)
    }
    const { member } = resolveTeamPeer(state, task.teamId, session.channel)
    const replyId = `reply_${crypto.randomBytes(12).toString('base64url')}`
    if (request.paths?.length && !member.files) throw new TeamError('files_not_allowed', 'File relay is not enabled for this worker.', 403)
    let files = []
    try { files = stageTeamFiles(session, request.paths || [], replyId) }
    catch (error) {
      if (error instanceof ArtifactUploadError) throw new TeamError(error.code, error.message, error.status)
      throw error
    }
    let appended
    try {
      appended = appendTeamTaskReply(state, task.id, {
        id: replyId, requestId: request.requestId, fromChannel: session.channel, text: request.text, files,
      })
    } catch (error) {
      if (files.length) removeTeamFiles(replyId)
      throw error
    }
    const reply = appended.reply
    if (!appended.created) {
      if (files.length) removeTeamFiles(replyId)
      await ensureTeamReplyDelivery(task, reply)
      return {
        reply: publicTeamTask(task, task.sourceChannel).replies.find(item => item.id === reply.id),
        task: publicTeamTask(task, task.sourceChannel),
        created: false,
      }
    }
    const startCodexStatus = recordTeamWorkerProof(session, task)
    saveStateNow(state)
    if (startCodexStatus) startCodexPoller(session)
    if (appended.accepted) {
      await updateTeamTaskAudit(task).catch(error =>
        log('team reply acceptance audit deferred', task.id, String(error?.message || error)))
    }
    const team = state.teams?.[task.teamId]
    if (team && shouldWakeForTeamReply(team, appended)) {
      try {
        queueContinuation(team, { taskId: task.id, replyId: reply.id, kind: 'reply' })
        saveStateNow(state)
        scheduleTeamContinuation(task.teamId)
      } catch (failure) { log('team continuation queue full', task.id, String(failure?.message || failure)) }
    }
    await ensureTeamReplyDelivery(task, reply)
    return { reply: publicTeamTask(task, task.sourceChannel).replies.at(-1), task: publicTeamTask(task, task.sourceChannel), created: true }
  },
}

const sessionMeta = new Map() // sid → { model, effort } as set via the bridge

// Read the session's model from its transcript init record (first "model" field).
function readModel(session) {
  if (providerOf(session) !== 'claude') return session.model || null
  try {
    const fd = fs.openSync(session.transcript, 'r')
    const buf = Buffer.alloc(65536)
    const n = fs.readSync(fd, buf, 0, 65536, 0)
    fs.closeSync(fd)
    const m = buf.toString('utf8', 0, n).match(/"model":"([^"]+)"/)
    if (m) return m[1]
  } catch {}
  return null
}

async function spawnNew(channel, dir, extraFlags, provider = 'claude') {
  const cwd = path.resolve(dir.replace(/^~/, process.env.HOME))
  if (!isPathWithin(process.env.HOME, cwd) || !fs.existsSync(cwd)) return post(channel, `❌ Directory not allowed or missing: \`${cwd}\``)
  provider = normalizeProvider(provider)
  if (!provider) return post(channel, '❌ Unknown session provider.')
  // `--account <name>` picks the subscription; it is bridge config, not a claude flag.
  let account = null
  const ai = extraFlags.indexOf('--account')
  if (ai >= 0) {
    account = safeAccount(extraFlags[ai + 1])
    if (!account) return post(channel, `❌ Invalid account name after \`--account\`.`)
    if (!listAccounts().includes(account)) return post(channel, `❌ Unknown account \`${account}\`.`)
    extraFlags = extraFlags.filter((_, i) => i !== ai && i !== ai + 1)
  }
  if (provider !== 'claude' && account) return post(channel, '❌ `--account` is only available for Claude Code sessions.')
  if (!extraFlags.length) extraFlags = defaultNewFlags(provider) // provider-specific operator default
  let flags
  try { flags = normalizeRemoteLaunchFlags(provider, extraFlags) }
  catch (error) { return post(channel, `❌ ${String(error?.message || error)}`) }
  const tmuxName = `sab-new-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
  if (provider === 'pi') {
    pendingSpawnChannels.set(tmuxName, channel)
    const pendingTimer = setTimeout(() => pendingSpawnChannels.delete(tmuxName), 10 * 60000)
    pendingTimer.unref?.()
  }
  await post(channel, `🚀 Spawning \`${providerCommand(provider)} ${flags.join(' ')}\` in \`${cwd}\`${account ? ` under \`${account}\`` : ''}…`)
  await executionNodes.spawn(LOCAL_NODE_ID, {
    cwd, args: flags, title: `sab ${path.basename(cwd)}`, tmuxName,
    autoConsent: provider === 'claude', account, provider,
  })
  let up = false
  for (let i = 0; i < 24 && !up; i++) { await sleep(500); up = await executionNodes.tmuxAlive(LOCAL_NODE_ID, tmuxName) }
  if (!up) {
    pendingSpawnChannels.delete(tmuxName)
    await post(channel, `⚠️ *The provider process did not initialize.* Inspect the local daemon log and retry \`${slackCommand(provider, 'new')}\`.`)
  }
}

const codeDir = () => process.env.CCS_CODE_DIR || path.join(process.env.HOME, 'Code')
async function postFolderPicker(channel, provider = 'claude') {
  const base = codeDir()
  let dirs = []
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name).sort() } catch {}
  if (!dirs.length) return post(channel, `No projects in \`${base}\`. Set CCS_CODE_DIR, or use \`/sab-new ${provider} <folder>\`.`)
  const options = dirs.slice(0, 100).map(d => ({ text: { type: 'plain_text', text: d.slice(0, 75) }, value: d.slice(0, 75) }))
  const pickerAction = `sabnew_folder_${provider}`
  await postSlackMessage(channel, {
    text: 'Pick a project to start a session in',
    blocks: [{
      type: 'section', text: { type: 'mrkdwn', text: `*Start a ${providerLabel(provider)} session* — pick a project in \`${base}\`:` },
      accessory: { type: 'static_select', action_id: pickerAction, placeholder: { type: 'plain_text', text: 'Choose a project…' }, options },
    }],
  })
}

// Interactive collaborator panel: a user-picker to add + a Remove button per
// current collaborator. Rendered under /sab-status in a session channel.
async function collabBlocks(channel) {
  const ids = Object.keys(collaborators(channel))
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: '*👥 Collaborators* — Slack users allowed to send prompts to this session (their prompts are labelled in the transcript)' },
    accessory: { type: 'users_select', action_id: 'collab_add', placeholder: { type: 'plain_text', text: 'Add a collaborator…' } },
  }]
  if (!ids.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_None yet — pick someone above to let them post here._' }] })
  } else {
    for (const uid of ids) {
      blocks.push({
        type: 'section', text: { type: 'mrkdwn', text: `• <@${uid}>` },
        accessory: { type: 'button', text: { type: 'plain_text', text: 'Remove' }, style: 'danger', value: `collab_rm:${uid}`, action_id: 'collab_rm' },
      })
    }
  }
  return blocks
}
async function refreshCollabPanel(body) {
  try {
    await web.chat.update({ channel: body.channel.id, ts: body.message.ts, text: 'Collaborators', blocks: await collabBlocks(body.channel.id) })
  } catch (e) { log('collab panel update failed', e?.data?.error || String(e)) }
}

// ---- usage reporting (ccusage) ----------------------------------------------
// Delegate provider transcript discovery and pricing to ccusage. The bridge
// consumes its public JSON schema and never parses Codex JSONL itself.
async function ccusageJson(provider, sub, extra = []) {
  const bin = path.join(BRIDGE, 'node_modules', '.bin', 'ccusage')
  const { stdout } = await execFile(bin, [provider, sub, '--json', ...extra], { timeout: 90000, maxBuffer: 32 << 20 })
  return JSON.parse(stdout)
}
const fmtTok = formatTokens
const fmtUsd = n => n == null ? '—' : '$' + n.toFixed(2)
const shortModel = m => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '')

// ---- plan rate limits (from the statusline feed) -----------------------------
let rateLimits = null // { at, buckets: { five_hour: {used_percentage, resets_at}, seven_day: {...}, ... } }
const LIMIT_LABELS = { five_hour: 'Current session (5h)', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus' }
const limitBar = pct => '▓'.repeat(Math.min(10, Math.round(pct / 10))).padEnd(10, '░') + ' ' + Math.round(pct) + '%'
function fmtReset(epoch) {
  if (!epoch) return '—'
  const d = new Date(epoch * 1000), now = new Date()
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString() ? `today ${time}`
    : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ` ${time}`
}
function limitLines() {
  if (!rateLimits || Date.now() - rateLimits.at > 15 * 60000) return null
  return Object.entries(rateLimits.buckets)
    .filter(([, v]) => v && typeof v === 'object' && 'used_percentage' in v)
    .map(([k, v]) => ({ label: LIMIT_LABELS[k] || k.replace(/_/g, ' '), pct: v.used_percentage, resets: fmtReset(v.resets_at) }))
}
function usageLimits(channel) {
  const lines = limitLines()
  if (!lines) return post(channel, 'No fresh limit data — it streams from live sessions. Write in any session channel, then retry.')
  return postMd(channel,
    `*Plan limits* — live from Claude Code\n` +
    `| Limit | Used | Resets |\n|---|---|---|\n` +
    lines.map(l => `| ${l.label} | ${limitBar(l.pct)} | ${l.resets} |`).join('\n'))
}
const limitFooter = () => {
  const lines = limitLines()
  return lines ? '\n_' + lines.map(l => `${l.label}: ${Math.round(l.pct)}% (resets ${l.resets})`).join(' · ') + '_' : ''
}

async function usageDays(channel, nArg, provider) {
  const n = Math.min(Math.max(parseInt(nArg, 10) || 7, 1), 14)
  const j = await ccusageJson(provider, 'daily')
  const days = usageRows(j, 'daily').slice(-n)
  if (!days.length) return post(channel, 'No usage data yet.')
  const sum = k => days.reduce((a, d) => a + (d[k] || 0), 0)
  const cost = rows => rows.reduce((total, row) => total + (usageCost(row) || 0), 0)
  if (provider === 'codex') {
    const rows = days.map(d => {
      const models = Object.keys(d.models || {}).map(shortModel).join(', ') || '—'
      return `| ${usageDate(d).slice(5)} | ${models} | ${fmtTok(d.inputTokens)} | ${fmtTok(d.outputTokens)} | ${fmtTok(d.reasoningOutputTokens)} | ${fmtTok(d.cacheReadTokens)} | ${fmtTok(d.totalTokens)} | ${fmtUsd(usageCost(d))} |`
    })
    return postMd(channel,
      `*Codex usage by day* — last ${days.length} day(s), all projects\n` +
      `| Day | Models | In | Out | Reason | Cache R | Total | Cost |\n|---|---|---|---|---|---|---|---|\n` +
      rows.join('\n') + '\n' +
      `| Σ | | ${fmtTok(sum('inputTokens'))} | ${fmtTok(sum('outputTokens'))} | ${fmtTok(sum('reasoningOutputTokens'))} | ${fmtTok(sum('cacheReadTokens'))} | ${fmtTok(sum('totalTokens'))} | ${fmtUsd(cost(days))} |`)
  }
  const rows = days.map(d => {
    const models = [...new Set((d.modelBreakdowns || []).map(b => shortModel(b.modelName)))].join(', ') || '—'
    return `| ${usageDate(d).slice(5)} | ${models} | ${fmtTok(d.inputTokens)} | ${fmtTok(d.outputTokens)} | ${fmtTok(d.cacheCreationTokens)} | ${fmtTok(d.cacheReadTokens)} | ${fmtTok(d.totalTokens)} | ${fmtUsd(usageCost(d))} |`
  })
  return postMd(channel,
    `*Claude Code usage by day* — last ${days.length} day(s), all projects\n` +
    `| Day | Models | In | Out | Cache W | Cache R | Total | Cost |\n|---|---|---|---|---|---|---|---|\n` +
    rows.join('\n') + '\n' +
    `| Σ | | ${fmtTok(sum('inputTokens'))} | ${fmtTok(sum('outputTokens'))} | ${fmtTok(sum('cacheCreationTokens'))} | ${fmtTok(sum('cacheReadTokens'))} | ${fmtTok(sum('totalTokens'))} | ${fmtUsd(cost(days))} |` +
    limitFooter())
}

async function usageModels(channel, provider) {
  const j = await ccusageJson(provider, 'daily')
  const agg = {}
  if (provider === 'codex') {
    for (const d of usageRows(j, 'daily')) for (const [model, b] of Object.entries(d.models || {})) {
      const a = agg[model] ??= { in: 0, out: 0, reason: 0, cr: 0, total: 0 }
      a.in += b.inputTokens || 0; a.out += b.outputTokens || 0
      a.reason += b.reasoningOutputTokens || 0; a.cr += b.cacheReadTokens || 0; a.total += b.totalTokens || 0
    }
    const rows = Object.entries(agg).sort((a, b) => b[1].total - a[1].total).map(([m, a]) =>
      `| ${shortModel(m)} | ${fmtTok(a.in)} | ${fmtTok(a.out)} | ${fmtTok(a.reason)} | ${fmtTok(a.cr)} | ${fmtTok(a.total)} |`)
    if (!rows.length) return post(channel, 'No Codex usage data yet.')
    return postMd(channel,
      `*Codex usage by model* — all time, all projects\n` +
      `| Model | In | Out | Reason | Cache R | Total |\n|---|---|---|---|---|---|\n` + rows.join('\n'))
  }
  for (const d of usageRows(j, 'daily')) for (const b of d.modelBreakdowns || []) {
    const a = agg[b.modelName] ??= { in: 0, out: 0, cw: 0, cr: 0, cost: 0 }
    a.in += b.inputTokens || 0; a.out += b.outputTokens || 0
    a.cw += b.cacheCreationTokens || 0; a.cr += b.cacheReadTokens || 0; a.cost += b.cost || 0
  }
  const rows = Object.entries(agg).sort((a, b) => b[1].cost - a[1].cost).map(([m, a]) =>
    `| ${shortModel(m)} | ${fmtTok(a.in)} | ${fmtTok(a.out)} | ${fmtTok(a.cw)} | ${fmtTok(a.cr)} | ${fmtUsd(a.cost)} |`)
  if (!rows.length) return post(channel, 'No usage data yet.')
  return postMd(channel,
    `*Claude Code usage by model* — all time, all projects\n` +
    `| Model | In | Out | Cache W | Cache R | Cost |\n|---|---|---|---|---|---|\n` + rows.join('\n'))
}

async function usageReport(channel, provider) {
  const session = channel !== state.control ? sessionByChannel(channel) : null
  if (session) {
    const j = await ccusageJson(provider, 'session')
    const all = usageRows(j, 'session')
    let rows = []
    let cur = null
    if (provider === 'codex') {
      cur = codexSessionUsage(j, session.id)
      // ccusage's Codex `directory` is the rollout-file date directory, not the
      // agent cwd. Join through bridge state instead: it already maps known
      // session ids to their trusted working directories without JSONL parsing.
      rows = codexProjectUsage(j, state.sessions, session.cwd)
      if (cur && !rows.includes(cur)) rows.push(cur)
    } else {
      const dir = path.dirname(session.transcript || '.')
      let ids = []
      try { ids = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)) } catch {}
      if (!ids.length) return post(channel, 'No transcripts found for this project yet.')
      rows = all.filter(r => ids.includes(r.sessionId || r.period))
      cur = rows.find(r => (r.sessionId || r.period) === session.id)
    }
    if (!rows.length) return post(channel, 'ccusage has no data for this project yet.')
    const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0)
    const cost = rows.reduce((a, r) => a + (usageCost(r) || 0), 0)
    const models = [...new Set(rows.flatMap(r => provider === 'codex' ? Object.keys(r.models || {}) : (r.modelsUsed || [])))].join(' · ') || '—'
    return postMd(channel,
      `*${providerLabel(provider)} usage — ${path.basename(session.cwd)}*\n` +
      `| Scope | Tokens | Cost |\n|---|---|---|\n` +
      `| This session (${session.id.slice(0, 8)}) | ${fmtTok(cur?.totalTokens)} | ${fmtUsd(usageCost(cur))} |\n` +
      `| Project, all sessions (${rows.length}) | ${fmtTok(sum('totalTokens'))} | ${fmtUsd(cost)} |\n` +
      `_Models: ${models}_` + (provider === 'claude' ? limitFooter() : ''))
  }
  // Control channel (or any unmapped channel): aggregate the selected provider.
  const j = await ccusageJson(provider, 'daily')
  const days = usageRows(j, 'daily')
  const month = new Date().toISOString().slice(0, 7)
  const monthRows = days.filter(d => usageDate(d).startsWith(month))
  const msum = k => monthRows.reduce((a, r) => a + (r[k] || 0), 0)
  const monthCost = monthRows.reduce((a, r) => a + (usageCost(r) || 0), 0)
  const t = j.totals || {}
  const rows7 = days.slice(-7).map(d => `| ${usageDate(d)} | ${fmtTok(d.totalTokens)} | ${fmtUsd(usageCost(d))} |`).join('\n')
  return postMd(channel,
    `*${providerLabel(provider)} usage — all projects*\n` +
    `| Day | Tokens | Cost |\n|---|---|---|\n${rows7}\n` +
    `| This month | ${fmtTok(msum('totalTokens'))} | ${fmtUsd(monthCost)} |\n` +
    `| All time | ${fmtTok(t.totalTokens)} | ${fmtUsd(usageCost(t))} |` +
    (provider === 'claude' ? limitFooter() : ''))
}

function piUsageSummary(rows) {
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'cost']
  return Object.fromEntries(fields.map(field => [field, rows.reduce((sum, row) => sum + Number(row?.[field] || 0), 0)]))
}

async function piUsageReport(channel, sub, nArg) {
  const all = Array.isArray(state.piUsage) ? state.piUsage : []
  const session = channel !== state.control ? sessionByChannel(channel) : null
  if (sub === 'days' || sub === 'daily') {
    const n = Math.min(Math.max(parseInt(nArg, 10) || 7, 1), 14)
    const since = Date.now() - n * 86400000
    const grouped = new Map()
    for (const row of piUsageRows(all, { since })) {
      const day = new Date(row.at).toISOString().slice(0, 10)
      const bucket = grouped.get(day) || []
      bucket.push(row); grouped.set(day, bucket)
    }
    if (!grouped.size) return post(channel, 'No Pi usage data yet.')
    const rows = [...grouped].map(([day, entries]) => {
      const total = piUsageSummary(entries)
      const models = [...new Set(entries.map(entry => entry.model))].join(', ')
      return `| ${day} | ${models} | ${fmtTok(total.inputTokens)} | ${fmtTok(total.outputTokens)} | ${fmtTok(total.cacheReadTokens)} | ${fmtTok(total.totalTokens)} | ${fmtUsd(total.cost)} |`
    })
    return postMd(channel, `*Pi usage by day*\n| Day | Models | In | Out | Cache R | Total | Cost |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}`)
  }
  if (sub === 'models') {
    const grouped = new Map()
    for (const row of all) {
      const bucket = grouped.get(row.model) || []
      bucket.push(row); grouped.set(row.model, bucket)
    }
    if (!grouped.size) return post(channel, 'No Pi usage data yet.')
    const rows = [...grouped].map(([model, entries]) => {
      const total = piUsageSummary(entries)
      return `| ${model} | ${fmtTok(total.inputTokens)} | ${fmtTok(total.outputTokens)} | ${fmtTok(total.cacheReadTokens)} | ${fmtTok(total.totalTokens)} | ${fmtUsd(total.cost)} |`
    })
    return postMd(channel, `*Pi usage by model*\n| Model | In | Out | Cache R | Total | Cost |\n|---|---|---|---|---|---|\n${rows.join('\n')}`)
  }
  const rows = session ? piUsageRows(all, { cwd: session.cwd }) : all
  const total = piUsageSummary(rows)
  if (session) {
    const currentRows = piUsageRows(all, { sessionId: session.id })
    const current = piUsageSummary(currentRows)
    const live = normalizePiUsage(session.piTurnUsage, session.piContextUsage) || session.piUsage
    const context = live?.contextWindow
      ? `${fmtTok(live.contextTokens)} / ${fmtTok(live.contextWindow)} (${Math.round(live.contextPercent || 0)}%)`
      : '—'
    return postMd(channel, `*Pi usage — ${path.basename(session.cwd)}*\n` +
      `| Scope | Tokens | Cost |\n|---|---|---|\n` +
      `| This session (${session.id.slice(0, 8)}) | ${fmtTok(current.totalTokens)} | ${fmtUsd(current.cost)} |\n` +
      `| Project, all sessions | ${fmtTok(total.totalTokens)} | ${fmtUsd(total.cost)} |\n` +
      `_Current context: ${context}_`)
  }
  return postMd(channel, `*Pi usage — all projects*\n| Turns | Tokens | Cost |\n|---|---|---|\n| ${rows.length} | ${fmtTok(total.totalTokens)} | ${fmtUsd(total.cost)} |`)
}

// ---- per-session subscriptions ----------------------------------------------
// A session can run under a named Claude account (see `sab account`), so each
// person's work bills to their own subscription. The daemon only ever handles
// NAMES — tokens live in ~/.config/ccs/accounts (0600) and are resolved inside
// the private runner at launch, never passed through argv, state, or Slack.
function listAccounts() {
  try {
    return fs.readFileSync(path.join(CONFIG_DIR, 'accounts'), 'utf8')
      .split('\n').map(l => l.split('=')[0].trim()).filter(n => safeAccount(n))
  } catch { return [] }
}
async function switchAccount(session, name) {
  const label = name ? `\`${name}\`` : "this machine's own login"
  await post(session.channel, `🔐 *Switching subscription* → ${label}. Restarting and resuming this conversation…`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session); await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null
  session.account = name || null
  saveState(state)
  await sleep(1500)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000)
}

// Launch flags a session was started with, minus the resume plumbing (which the
// daemon re-adds itself) — i.e. what the user actually chose.
function displayFlags(session) {
  return displayFlagsFor(session)
}

// Change a live session's launch flags. Claude Code reads them at startup, so
// this restarts the session and resumes the same conversation — the same dance
// as /sab-account and /sab-update.
async function setFlags(session, flags) {
  await post(session.channel, `🔧 *Setting launch flags* → \`${flags.join(' ') || '(none)'}\`. Restarting and resuming this conversation…`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session); await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null
  session.launchFlags = flags.join(' ')
  saveState(state)
  await sleep(1500)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000)
}

async function setCodexSetting(session, name, value) {
  session[name] = value
  if (name === 'model') session.requestedModel = value
  if (name === 'effort') session.requestedEffort = value
  sessionMeta.set(session.id, { ...(sessionMeta.get(session.id) || {}), [name]: value })
  const alive = session.pid && pidAlive(session.pid)
  if (!alive) {
    saveState(state)
    return post(session.channel, `✅ ${name} → \`${value}\` — it will apply on the next resume.`)
  }
  await post(session.channel, `🔧 *Setting ${name}* → \`${value}\`. Restarting Codex and resuming this conversation…`)
  restarting.add(session.id)
  if (session.tmux) await tmuxKill(session.tmux)
  if (session.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  stopPoller(session)
  await clearStatus(session)
  clearPermissionsForPid(session.pid, 'session restarting')
  session.pid = null
  saveState(state)
  await sleep(1500)
  await resurrect(session)
  setTimeout(() => restarting.delete(session.id), 60000)
}

async function setPiSetting(session, name, value) {
  const field = name === 'effort' ? 'effort' : 'model'
  if (!(session.pid && pidAlive(session.pid))) {
    session[field] = value
    saveState(state)
    return post(session.channel, `✅ ${name} → \`${value}\` — it will apply on the next resume.`)
  }
  let result
  try { result = await sendPiControl(session, name, value) }
  catch (error) { return post(session.channel, `⚠️ Pi could not change ${name}: ${String(error?.message || error).slice(0, 300)}`) }
  if (!result?.ok) return post(session.channel, `❌ Pi rejected ${name}: ${String(result?.error || 'unknown error').slice(0, 300)}`)
  if (result.model) session.model = result.model
  if (result.model_name) session.modelName = result.model_name
  if (result.effort) session.effort = result.effort
  sessionMeta.set(session.id, { ...(sessionMeta.get(session.id) || {}), model: session.modelName || session.model, effort: session.effort })
  saveState(state)
  await updateTopic(session)
  return post(session.channel, `✅ ${name} → \`${name === 'model' ? session.model : session.effort}\``)
}

// Flags a provider-specific new session gets when none are given. Configurable because the
// right default is a matter of taste and risk appetite (CCS_NEW_FLAGS).
const defaultNewFlags = (provider = 'claude') => defaultNewFlagsFor(provider)

function teamStatusMarkdown(team) {
  const rows = Object.entries(team.members || {}).map(([channel, member]) => {
    const session = sessionByChannel(channel)
    const live = Boolean(session?.pid && pidAlive(session.pid))
    const task = Object.values(state.teamTasks || {}).find(item => item.targetChannel === channel && ['queued', 'dispatching', 'running'].includes(item.status))
    return `| ${member.alias} | ${member.role} | <#${channel}> | ${live ? '🟢 live' : '💤 dormant'} | ${member.files ? 'enabled' : 'off'} | ${task ? `\`${task.id}\` · ${task.status}` : '—'} |`
  })
  return `*Session team \`${team.name}\`* · version ${team.version} · continuation: *${team.continuation?.mode || 'manual'}*\n` +
    `| Alias | Role | Channel | Session | Files | Active task |\n|---|---|---|---|---|---|\n${rows.join('\n')}`
}

async function postTeamAddPicker(channel, team) {
  return postSlackMessage(channel, {
    text: `Add a worker to ${team.name}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Add a worker to* \`${team.name}\`\nOnly an authoritative private SAB session channel will be accepted.` } },
      { type: 'actions', elements: [{
        type: 'conversations_select',
        action_id: `team_add_channel:${team.id}`,
        placeholder: { type: 'plain_text', text: 'Choose a SAB session channel' },
        filter: { include: ['private'] },
      }] },
    ],
  })
}

async function announceCancelledTeamTasks(ids) {
  for (const id of ids) {
    const task = state.teamTasks?.[id]
    if (!task) continue
    await ensureTeamCompletionDelivery(task).catch(error =>
      log('team cancellation delivery deferred', task.id, String(error?.message || error)))
  }
}

function revokeCancelledTeamTasks(ids) {
  for (const id of ids) {
    const task = state.teamTasks?.[id]
    const target = task && state.sessions?.[task.targetSessionId]
    if (target?.teamActiveTaskId === id) {
      delete target.teamActiveTaskId
      discardQueuedTeamTaskPrompt(target, id)
      clearTeamInputReservation(target)
      clearTeamTurn(target)
      teamTurnProof.delete(target.id)
    }
  }
}

async function handleTeamCommand(channel, rest) {
  const session = sessionByChannel(channel)
  if (!session) return post(channel, 'Use `/sab-team` in an authoritative SAB session channel.')
  const sub = String(rest[0] || 'status').toLowerCase()
  if (sub === 'create') {
    if (rest.length !== 2) return post(channel, 'Usage: `/sab-team create <name>`')
    if (activeTransition(channel)) return post(channel, '⏳ Wait for the provider switch to finish before creating a team.')
    try {
      const team = createTeam(state, {
        name: rest[1], coordinatorChannel: channel, createdBy: USER,
      })
      saveStateNow(state)
      await post(channel, `🕸️ *Created session team* \`${team.name}\`. This channel is its coordinator. Add workers with \`/sab-team add\`.`)
      return postMd(channel, teamStatusMarkdown(team))
    } catch (error) {
      if (error instanceof TeamError) return post(channel, `❌ ${error.message}`)
      throw error
    }
  }
  const team = activeTeamForChannel(state, channel)
  if (!team) return post(channel, 'This channel is not in an active session team. Create one with `/sab-team create <name>` from the intended coordinator channel.')
  if (sub === 'status') {
    if (rest.length !== 1) return post(channel, 'Usage: `/sab-team status`')
    return postMd(channel, teamStatusMarkdown(team))
  }
  if (team.coordinatorChannel !== channel) {
    return post(channel, `This channel is a worker in \`${team.name}\`. Team membership is managed from <#${team.coordinatorChannel}>.`)
  }
  if (sub === 'auto' || sub === 'manual') {
    if (rest.length !== 1) return post(channel, 'Usage: `/sab-team auto` or `/sab-team manual`')
    try {
      setContinuationMode(team, sub === 'auto' ? 'auto-until-blocked' : 'manual')
      saveStateNow(state)
      if (sub === 'auto') scheduleTeamContinuation(team.id)
      return post(channel, sub === 'auto'
        ? '▶️ *Automatic coordinator continuation enabled* — the team will proceed until a blocker or safety decision requires you.'
        : '⏸️ *Automatic coordinator continuation disabled* — worker results will wait for an owner turn.')
    } catch (error) { return post(channel, `❌ ${error.message}`) }
  }
  if (activeTransition(channel)) return post(channel, '⏳ Wait for the provider switch to finish before changing team membership.')
  if (sub === 'add') {
    if (rest.length !== 1) return post(channel, 'Usage: `/sab-team add`')
    return postTeamAddPicker(channel, team)
  }
  if (sub === 'permissions' && rest.length === 1) {
    const rows = Object.entries(team.members || {})
      .filter(([, member]) => member.role === 'worker')
      .map(([memberChannel, member]) => `| ${member.alias} | <#${memberChannel}> | text + status + final | ${member.files ? 'enabled' : 'off'} |`)
    return postMd(channel,
      `*Session team permissions* — coordinator → worker tasks; worker → coordinator replies only. Worker-to-worker relay is disabled.\n` +
      `| Worker | Channel | Text | Files |\n|---|---|---|---|\n${rows.join('\n') || '| _none_ | | | |'}`)
  }
  if (sub === 'files' || sub === 'permissions') {
    const alias = rest[1]
    const capability = sub === 'files' ? 'files' : String(rest[2] || '').toLowerCase()
    const setting = sub === 'files' ? rest[2] : rest[3]
    if ((sub === 'files' && rest.length !== 3) ||
        (sub === 'permissions' && (rest.length !== 4 || capability !== 'files')) ||
        !['on', 'off'].includes(String(setting).toLowerCase())) {
      return post(channel, 'Usage: `/sab-team permissions` or `/sab-team permissions <worker-alias> files <on|off>`')
    }
    try {
      const result = setTeamWorkerFiles(state, team.id, alias, String(setting).toLowerCase() === 'on')
      saveStateNow(state)
      const targetNotified = await post(result.channel,
        `${result.member.files ? '📎' : '🔒'} Team file relay is now *${result.member.files ? 'enabled' : 'off'}* for \`${result.member.alias}\`.`)
        .then(() => true, () => false)
      return post(channel,
        `${result.member.files ? '📎 Enabled' : '🔒 Disabled'} file relay for \`${result.member.alias}\` (<#${result.channel}>).` +
        (targetNotified ? '' : ' ⚠️ The setting is durable, but Slack could not post the worker notification.'))
    } catch (error) {
      if (error instanceof TeamError) return post(channel, `❌ ${error.message}`)
      throw error
    }
  }
  if (sub === 'remove') {
    if (rest.length !== 2) return post(channel, 'Usage: `/sab-team remove <worker-alias>`')
    try {
      const result = removeTeamWorker(state, team.id, rest[1])
      revokeCancelledTeamTasks(result.cancelled)
      clearTeamTurn(sessionByChannel(result.channel))
      saveStateNow(state)
      await announceCancelledTeamTasks(result.cancelled)
      const targetNotified = await post(result.channel,
        `🚫 Removed from session team \`${team.name}\`. No new cross-channel work can be sent or returned.`)
        .then(() => true, () => false)
      return post(channel, `🚫 Removed \`${result.member.alias}\` (<#${result.channel}>) from \`${team.name}\`.` +
        (targetNotified ? '' : ' ⚠️ The revocation is durable, but Slack could not post the worker notification.'))
    } catch (error) {
      if (error instanceof TeamError) return post(channel, `❌ ${error.message}`)
      throw error
    }
  }
  if (sub === 'close') {
    if (rest.length !== 1) return post(channel, 'Usage: `/sab-team close`')
    const memberChannels = Object.keys(team.members)
    const result = closeTeam(state, team.id)
    revokeCancelledTeamTasks(result.cancelled)
    for (const memberChannel of memberChannels) clearTeamTurn(sessionByChannel(memberChannel))
    saveStateNow(state)
    await announceCancelledTeamTasks(result.cancelled)
    for (const memberChannel of memberChannels) {
      await post(memberChannel, `🕸️ Session team \`${team.name}\` was closed. Existing provider sessions are unaffected.`).catch(() => {})
    }
    return
  }
  return post(channel,
    'Usage: `/sab-team create <name>`, `/sab-team add`, `/sab-team status`, `/sab-team auto|manual`, `/sab-team permissions`, `/sab-team remove <alias>`, or `/sab-team close`.')
}

const SESSION_SCOPED_COMMANDS = new Set(['status', 'usage', 'kill', 'model', 'effort', 'stop', 'update', 'restart', 'flags', 'switch', 'run', 'terminal'])
const CLAUDE_ONLY_COMMANDS = new Set(['account'])
const BRIDGE_COMMANDS = new Set(['claim', 'health', 'cleanup', 'team'])

function commandHelp(provider = null) {
  const context = provider ? ` This channel currently uses *${providerLabel(provider)}*.` : ''
  return '*Slack Agent Bridge commands* — type `/sab-` to autocomplete.' + context + '\n' +
    '`/sab-new <claude|codex|pi> [folder] [flags]` — start a headless session\n' +
    '`/sab-model [model]` · `/sab-effort [level]` · `/sab-flags [flags]` — inspect or change the active provider\n' +
    '`/sab-update [all]` · `/sab-stop` · `/sab-kill` — update one/all idle sessions, interrupt, or end\n' +
    '`/sab-switch <claude|codex|pi> [new]` — hand this channel to another provider\n' +
    '`/sab-status [provider]` · `/sab-usage [provider] …` — current session or control-channel overview\n' +
    '`/sab-terminal open|close|list|open-all|close-all` — manage optional Ghostty viewports\n' +
    '`/sab-team create|add|status|auto|manual|permissions|remove|close` — link sessions for safe agent delegation\n' +
    '`/sab-run …` — Pi managed runs · `/sab-account …` — Claude subscriptions\n' +
    '`/sab-health` · `/sab-cleanup` · `/sab-claim` — bridge-wide operations'
}

// /sab-* infers the provider from the channel's authoritative active session.
// A migration-only legacy prefix may still supply an ingress provider while an
// older Slack manifest is being replaced.
async function dispatch(name, rest, channel, ingressProvider = null, request = null) {
  const channelSession = channel !== state.control ? sessionByChannel(channel) : null
  let commandProvider = channelSession ? providerOf(channelSession) : ingressProvider
  const cmd = commandName => slackCommand(commandProvider, commandName)
  if (name === 'help') {
    return post(channel, commandHelp(commandProvider))
  }
  if (name === 'team' && ingressProvider) return post(channel, 'Use the provider-neutral `/sab-team` command.')
  if (ingressProvider && ingressProvider !== 'claude' && (CLAUDE_ONLY_COMMANDS.has(name) || BRIDGE_COMMANDS.has(name))) {
    return post(channel, `${BRIDGE_COMMANDS.has(name) ? `Use the bridge-wide \`/sab-${name}\`.` : `\`/sab-${name}\` is Claude-only.`}`)
  }
  if (name === 'team') return handleTeamCommand(channel, rest)
  if (channelSession && ingressProvider && SESSION_SCOPED_COMMANDS.has(name) && providerOf(channelSession) !== ingressProvider) {
    const actualProvider = providerOf(channelSession)
    return post(channel, `This is a ${providerLabel(actualProvider)} session. Use \`${slackCommand(actualProvider, name === 'restart' ? 'update' : name)}\` here.`)
  }
  const channelTransition = activeTransition(channel)
  if (channelTransition && SESSION_SCOPED_COMMANDS.has(name) && !['status', 'switch', 'terminal'].includes(name)) {
    return post(channel, `⏳ Provider switch is in its \`${channelTransition.phase}\` phase. Wait for commit/rollback before changing or ending either native leg.`)
  }
  if (channelSession?.teamActiveTaskId && SESSION_SCOPED_COMMANDS.has(name) &&
      !['status', 'usage', 'stop', 'kill', 'terminal'].includes(name)) {
    return post(channel, `🕸️ Team task \`${channelSession.teamActiveTaskId}\` owns this worker turn. Wait for its final response or interrupt/end it before changing provider settings.`)
  }
  if (name === 'terminal') {
    let action = String(rest[0] || (channelSession ? 'list' : 'list')).toLowerCase()
    if (action === 'show-all') action = 'open-all'
    if (action === 'list') {
      if (rest.length > 1) return post(channel, 'Usage: `/sab-terminal list|open|close|open-all|close-all`')
      const rows = await terminalControl.list()
      return postMd(channel, `| Session | Provider | Terminal | Folder |\n|---|---|---|---|\n${rows.map(row =>
        `| ${row.session} | ${providerLabel(row.provider)} | ${row.attached ? '🖥️ open' : '▫️ closed'} | ${String(row.cwd || '—').replace(/\|/g, '\\|')} |`).join('\n') || '| _none_ | | | |'}`)
    }
    const all = action === 'open-all' || action === 'close-all'
    const operation = action === 'open' || action === 'open-all' ? 'open'
      : action === 'close' || action === 'close-all' ? 'close' : null
    if (!operation || rest.length > 1) return post(channel, 'Usage: `/sab-terminal list|open|close|open-all|close-all`')
    if (!all && !channelSession) return post(channel, `Use \`/sab-terminal ${operation}\` in an active session channel, or use \`${operation}-all\`.`)
    const result = await terminalControl.act(operation, { all, channel: all ? null : channel })
    const failures = result.failures.map(item => `\`${item.session}\`: ${item.error}`).join('\n')
    return post(channel, `${operation === 'open' ? '🖥️' : '🌑'} ${result.message}${failures ? `\n${failures}` : ''}`)
  }
  if (name === 'run') {
    if (commandProvider !== 'pi') return post(channel, 'Managed runs are Pi-specific. Use `/sab-run` in an active Pi session channel.')
    if (!channelSession) return post(channel, 'Use `/sab-run` in an active Pi session channel.')
    if (!(channelSession.pid && pidAlive(channelSession.pid))) return post(channel, 'Pi is dormant — send a message to wake the session, then retry `/sab-run`.')
    const parsed = parseManagedRunCommand(rest)
    if (parsed.error) return post(channel, `❌ ${parsed.error}\nUsage: \`/sab-run [plan] <goal> [--minutes=N --turns=N --agents=N --reviews=N]\`, \`/sab-run mode [auto|always|native]\`, \`/sab-run direct <prompt>\`, or a control action.`)
    const actions = {
      start: 'managed-start', status: 'managed-status', approve: 'managed-approve',
      pause: 'managed-pause', continue: 'managed-continue', cancel: 'managed-cancel',
      policy: 'managed-policy', 'policy-status': 'managed-policy-status', direct: 'managed-direct',
    }
    if (parsed.action === 'start') {
      await post(channel, parsed.mode === 'plan'
        ? '🧭 Starting a read-only planning subagent…'
        : '🧭 Starting a managed Pi run: planner → worker → independent reviewer…')
    }
    let result
    try {
      let value = null
      if (parsed.action === 'start') {
        value = {
            goal: parsed.goal, mode: parsed.mode, budgets: parsed.budgets,
            privateContext: artifactDeliveryContext(channelSession, request),
          }
      } else if (parsed.action === 'policy') value = { policy: parsed.policy }
      else if (parsed.action === 'direct') {
        value = { goal: parsed.goal, privateContext: artifactDeliveryContext(channelSession, request) }
        rememberInjected(channelSession.id, `${value.goal}${value.privateContext}`)
      }
      result = await sendPiControl(channelSession, actions[parsed.action], value)
    } catch (error) {
      return post(channel, `⚠️ Managed Pi command failed: ${String(error?.message || error).slice(0, 500)}`)
    }
    if (!result?.ok) return post(channel, `❌ ${String(result?.error || 'Pi rejected the managed-run command.').slice(0, 1000)}`)
    const managed = result.managed
    if (parsed.action === 'status' || parsed.action === 'policy-status') {
      const policy = normalizeManagedPolicy(result.managed_policy)
      if (!managed) {
        const routing = result.routing?.status === 'routing'
          ? ` Pi is currently assessing a prompt (${String(result.routing.reason || 'pending decision').slice(0, 500)}).`
          : ''
        return post(channel, `Adaptive Pi routing is \`${policy}\`. No managed run exists in this Pi session.${routing}`)
      }
      const plan = Array.isArray(result.plan) && result.plan.length
        ? '\n' + result.plan.map(step => `${step.status === 'done' ? '✅' : '▫️'} ${Number(step.id) || '•'}. ${String(step.text || '').slice(0, 1000)}`).join('\n')
        : ''
      return postMd(channel,
        `*Managed run ${managed.id.slice(0, 8)}*\n` +
        `| Field | Value |\n|---|---|\n` +
        `| Adaptive policy | ${policy} |\n` +
        `| Status | ${managed.status} · ${managed.phase} |\n` +
        `| Goal | ${String(managed.goal || '').replace(/\|/g, '\\|')} |\n` +
        `| Progress | ${managed.completedSteps}/${managed.totalSteps} steps |\n` +
        `| Parent turns | ${managed.counters?.parentTurns || 0}/${managed.budgets?.maxParentTurns || '—'} |\n` +
        `| Subagents | ${managed.counters?.subagents || 0}/${managed.budgets?.maxSubagents || '—'} |\n` +
        `| Review cycles | ${managed.counters?.reviewCycles || 0}/${managed.budgets?.maxReviewCycles || '—'} |${plan}`)
    }
    const replies = {
      start: `✅ Managed run \`${managed?.id?.slice(0, 8) || 'started'}\` accepted. The plan will appear here before execution.`,
      policy: `✅ Adaptive Pi routing → \`${normalizeManagedPolicy(result.managed_policy)}\``,
      direct: '▶️ Sent directly to native Pi without managed routing.',
      approve: '▶️ Plan approved; managed execution started.',
      pause: '⏸️ Managed run paused. Resume with `/sab-run continue`.',
      continue: '▶️ Managed run continuing from persisted state.',
      cancel: result.routing_cancelled
        ? '🛑 Adaptive routing cancelled; the queued prompt was not delivered.'
        : '🛑 Managed run cancelled; its history remains in the native Pi session.',
    }
    return post(channel, replies[parsed.action])
  }
  if (name === 'switch') {
    if (!channelSession) return post(channel, `Use \`${cmd('switch')}\` in an active ${providerLabel(commandProvider)} session channel.`)
    if (channelSession.managed?.status === 'active' || channelSession.piRouting?.status === 'routing') {
      return post(channel, channelSession.piRouting?.status === 'routing'
        ? '⏳ This Pi session is assessing a prompt. Cancel it with `/sab-stop` before switching providers.'
        : '⏳ This Pi session has an active managed run. Pause it with `/sab-run pause` before switching providers.')
    }
    const words = rest.map(word => word.toLowerCase())
    const replaceMissing = words.includes('new')
    const requested = words.find(word => PROVIDERS.includes(word)) || null
    // Only the temporary 1.x ingress shim retains the historical bare switch
    // default. The canonical /sab-switch always requires an explicit target.
    const legacyTarget = ingressProvider ? defaultSwitchTarget(commandProvider) : null
    const targetProvider = requested || legacyTarget
    const valid = words.every(word => word === 'new' || PROVIDERS.includes(word)) &&
      words.filter(word => PROVIDERS.includes(word)).length <= 1
    if (!valid || !targetProvider || targetProvider === commandProvider) {
      const choices = PROVIDERS.filter(provider => provider !== commandProvider).join('|')
      return post(channel, `Usage: \`${cmd('switch')} <${choices}> [new]\`` +
        (legacyTarget ? ` (without a target, defaults to ${providerLabel(legacyTarget)})` : ''))
    }
    return beginProviderSwitch(channel, channelSession, { replaceMissing, targetProvider })
  }
  if (name === 'status') {
    const session = channelSession
    if (session) {
      const { branch, worktree } = await gitInfo(session.cwd)
      const gs = await gitStatusText(session.cwd)
      const alive = session.pid && pidAlive(session.pid)
      const meta = sessionMeta.get(session.id) || {}
      const changes = gs ? `${gs.split('\n').length} file(s) changed` : '✓ clean'
      const lineage = lineageFor(state, channel)
      const standbys = lineage ? PROVIDERS
        .filter(provider => provider !== lineage.activeProvider && lineage.legs?.[provider])
        .map(provider => ({ provider, session: state.sessions[lineage.legs[provider]] }))
        .filter(item => item.session) : []
      // Table cells are raw text (no markdown), so no backticks here.
      await postMd(channel,
        `*Session ${session.id.slice(0, 8)}* — ${alive ? '🟢 active' : '💤 dormant'}\n` +
        `| Field | Value |\n|---|---|\n` +
        `| Provider | ${providerLabel(providerOf(session))} |\n` +
        `| Folder | ${session.cwd} |\n` +
        `| Branch | ${branch || '—'}${worktree ? ` · wt:${worktree}` : ''} |\n` +
        `| Model | ${meta.model || readModel(session) || '—'} |\n` +
        `| Effort | ${meta.effort || session.effort || '—'} |\n` +
        (providerOf(session) === 'pi'
          ? `| Adaptive routing | ${normalizeManagedPolicy(session.managedPolicy)}${session.piRouting?.status === 'routing' ? ' · assessing prompt' : ''} |\n`
          : '') +
        (providerOf(session) === 'pi' && session.managed
          ? `| Managed run | ${session.managed.status} · ${session.managed.phase} · ${session.managed.completedSteps}/${session.managed.totalSteps} steps |\n`
          : '') +
        standbys.map(({ provider, session: standby }) => `| Standby leg | ${providerLabel(provider)} · ${standby.id.slice(0, 8)} · ${standby.pid && pidAlive(standby.pid) ? '⚠️ unexpectedly live' : 'preserved'} |\n`).join('') +
        (lineage?.transition ? `| Transition | ${lineage.transition.phase} → ${providerLabel(lineage.transition.target.provider)} |\n` : '') +
        `| Changes | ${changes} |` +
        (gs ? '\n```\n' + gs.slice(0, 1200) + '\n```' : ''))
      await postSlackMessage(channel, { text: 'Collaborators', blocks: await collabBlocks(channel) })
      return
    }
    let statusProvider = ingressProvider
    if (!statusProvider && rest.length) {
      statusProvider = normalizeProvider(rest[0], null)
      if (!statusProvider || rest.length > 1) return post(channel, 'Usage: `/sab-status [claude|codex|pi]`')
    }
    const rows = Object.values(state.sessions).filter(s => !statusProvider || providerOf(s) === statusProvider).map(s => {
      const alive = s.pid && pidAlive(s.pid)
      const provider = providerOf(s)
      const standby = !s.channel && Object.values(state.lineages || {}).some(lineage => lineage.legs?.[provider] === s.id)
      return `| ${path.basename(s.cwd)} | ${providerLabel(providerOf(s))} | ${s.id.slice(0, 8)} | ${standby ? '⏸️ standby' : alive ? '🟢 active' : '💤 dormant'} |`
    })
    return postMd(channel, `| Session | Provider | ID | State |\n|---|---|---|---|\n${rows.join('\n') || '| _none_ | | | |'}`)
  }
  if (name === 'health') {
    const sess = Object.values(state.sessions)
    const active = sess.filter(s => s.pid && pidAlive(s.pid)).length
    const codex = sess.filter(s => providerOf(s) === 'codex').length
    const pi = sess.filter(s => providerOf(s) === 'pi').length
    const claude = sess.length - codex - pi
    const up = Math.round((Date.now() - BOOT_TS) / 1000)
    const hms = up < 3600 ? `${Math.round(up / 60)}m` : `${(up / 3600).toFixed(1)}h`
    return postMd(channel,
      `| Bridge health | |\n|---|---|\n` +
      `| Uptime | ${hms} |\n` +
      `| Sessions | ${active} active, ${sess.length - active} dormant |\n` +
      `| Providers | ${claude} Claude, ${codex} Codex, ${pi} Pi |\n` +
      `| Agent streams attached | ${streams.size} |\n` +
      `| Open permission prompts | ${Object.keys(state.perms).length} |`)
  }
  if (name === 'kill') {
    const target = rest[0] && rest[0] !== 'here'
      ? Object.values(state.sessions).find(s => (!ingressProvider || providerOf(s) === ingressProvider) && s.id.startsWith(rest[0]))
      : sessionByChannel(channel)
    if (!target) return post(channel, `No matching session — use \`${cmd('kill')}\` in a session channel, or \`${cmd('kill')} <id-prefix>\`.`)
    if (providerOf(target) === 'pi' && target.pid && pidAlive(target.pid) && target.managed?.status === 'active') {
      try { await sendPiControl(target, 'managed-cancel') } catch {}
    }
    if (target.tmux) await tmuxKill(target.tmux)
    if (target.pid && pidAlive(target.pid)) { try { process.kill(target.pid) } catch {} }
    stopPoller(target)
    await clearStatus(target)
    await failTeamTaskForSession(target, 'The worker session was ended before completing its delegated task.')
    clearPermissionsForPid(target.pid, 'session ended')
    target.pid = null
    saveState(state)
    return post(channel, `🛑 Ended session \`${target.id.slice(0, 8)}\` (${path.basename(target.cwd)}). The channel stays — write here to resume.`)
  }
  if (name === 'cleanup') {
    const dormant = Object.values(state.sessions).filter(s => s.channel && s.channel !== channel && !(s.pid && pidAlive(s.pid)))
    const protectedByTeam = session => {
      try { return Boolean(activeTeamForChannel(state, session.channel)) }
      catch { return true }
    }
    const teamProtected = dormant.filter(protectedByTeam)
    const dead = dormant.filter(session => !protectedByTeam(session))
    if (!dead.length) {
      return post(channel, teamProtected.length
        ? `No dormant channels are eligible for archival. ${teamProtected.length} dormant team channel(s) were preserved; remove or close their team membership first.`
        : 'No dormant channels to archive (skipping the one you’re in).')
    }
    let n = 0
    for (const s of dead) {
      try { await web.conversations.archive({ channel: s.channel }); n++ }
      catch (e) { log('archive failed', s.channel, e?.data?.error); continue }
      deleteLineage(state, s.channel)
      deleteHandoffs(CONFIG_DIR, s.channel)
    }
    saveState(state)
    return post(channel, `🧹 Archived ${n} dormant channel(s).${teamProtected.length ? ` Preserved ${teamProtected.length} dormant team channel(s).` : ''} Note: archived channels can’t auto-resume — unarchive manually in Slack if you need one back.`)
  }
  if (name === 'model' || name === 'effort') {
    const session = sessionByChannel(channel)
    if (!session) return post(channel, `Use \`${cmd(name)}\` in a ${providerLabel(commandProvider)} session channel.`)
    const provider = providerOf(session)
    const meta = sessionMeta.get(session.id) || {}
    if (!rest.length) {
      if (name === 'model') {
        const cur = meta.model || readModel(session) || 'unknown'
        if (provider === 'pi') {
          if (session.pid && pidAlive(session.pid)) {
            try {
              const result = await sendPiControl(session, 'models')
              if (result?.ok && result.models?.length) {
                const rows = result.models.map(model =>
                  `| \`${model.id}\` | ${model.name || model.id} | ${model.reasoning ? 'yes' : 'no'} | ${(model.input || []).join(', ')} |`).join('\n')
                return postMd(channel, `*Model* — current: \`${cur}\`\nSet with \`${cmd('model')} <provider/model>\`:\n` +
                  `| Model id | Name | Thinking | Input |\n|---|---|---|---|\n${rows}`)
              }
            } catch (error) { log('Pi model catalog unavailable', String(error)) }
          }
          return post(channel, `*model*: \`${cur}\`\nSet with \`${cmd('model')} <provider/model>\`.`)
        }
        if (provider === 'codex') {
          const models = await getCodexModels()
          if (models.length) {
            const rows = models.map(m => `| \`${m.id}\` | ${m.name} | ${m.efforts.join(' · ') || '—'} |`).join('\n')
            return postMd(channel, `*Model* — current: \`${cur}\`\nSet with \`${cmd('model')} <id>\`:\n| Model id | Name | Efforts |\n|---|---|---|\n${rows}`)
          }
          return post(channel, `*model*: \`${cur}\`\nSet with \`${cmd('model')} <id>\`.`)
        }
        const models = await getModels()
        if (models.length) {
          const rows = models.map(m => `| \`${m.alias}\` | ${m.name} | \`${m.id}\` |`).join('\n')
          const hasLong = models.some(m => /-1m$/.test(m.alias))
          return postMd(channel, `*Model* — current: \`${cur}\`\nSet with \`${cmd('model')} <alias>\` (or a full id):\n| Alias | Model | Full id |\n|---|---|---|\n${rows}` +
            (hasLong ? '\n_A family alias picks the *1M-context* variant when one exists — pass the full id for the standard window._' : ''))
        }
        return post(channel, `*model*: \`${cur}\`\nSet with \`${cmd('model')} <value>\`  (sonnet · opus · haiku · fable)`)
      }
      const efforts = provider === 'codex' ? CODEX_EFFORTS.join(' · ')
        : provider === 'pi' ? PI_EFFORTS.join(' · ')
          : 'low · medium · high · max'
      return post(channel, `*effort*: \`${meta.effort || session.effort || 'unknown'}\`\nSet with \`${cmd('effort')} <value>\`  (${efforts})`)
    }
    if (provider === 'codex') {
      const val = rest.join(' ').toLowerCase()
      if (name === 'effort' && !CODEX_EFFORTS.includes(val)) {
        return post(channel, `❌ Unsupported Codex effort \`${val}\`. Use: ${CODEX_EFFORTS.join(' · ')}`)
      }
      return setCodexSetting(session, name, val)
    }
    if (provider === 'pi') {
      const val = name === 'effort' ? rest.join(' ').toLowerCase() : rest.join(' ')
      if (name === 'effort' && !PI_EFFORTS.includes(val)) {
        return post(channel, `❌ Unsupported Pi thinking level \`${val}\`. Use: ${PI_EFFORTS.join(' · ')}`)
      }
      return setPiSetting(session, name, val)
    }
    if (!(session.pid && pidAlive(session.pid))) return post(channel, 'Session not active — send a message first to wake it.')
    let val = rest.join(' ')
    if (name === 'model') {
      // A bare family alias selects the LONG-CONTEXT variant when this build has
      // one (`opus` → claude-opus-5[1m]): the bigger window is the better default
      // for bridged sessions, which run long. Claude Code's own alias resolves to
      // the standard variant, so we translate to the full id ourselves. Passing a
      // full id (e.g. `claude-opus-5`) still selects exactly that.
      const models = await getModels()
      const want = val.toLowerCase()
      const pick = models.find(m => m.alias.toLowerCase() === `${want}-1m`)
                || models.find(m => m.alias.toLowerCase() === want)
      if (pick) val = pick.id
    }
    await sendMenuCommand(session.tmux, `/${name} ${val}`)
    sessionMeta.set(session.id, { ...meta, [name]: val })
    if (name === 'effort') { session.effort = val; saveState(state) } // persist so resume restores it
    return post(channel, `✅ ${name} → \`${val}\``)
  }
  if (name === 'stop') {
    const session = sessionByChannel(channel)
    if (!session?.tmux || !(session.pid && pidAlive(session.pid))) return post(channel, 'No active session here to interrupt.')
    clearTeamTurn(session)
    saveStateNow(state)
    const activeProvider = providerOf(session)
    if (activeProvider === 'pi') {
      let result
      try { result = await sendPiControl(session, 'abort') }
      catch (error) { return post(channel, `⚠️ Pi interrupt failed: ${String(error?.message || error).slice(0, 200)}`) }
      await failTeamTaskForSession(session, 'The delegated worker turn was interrupted by the owner.')
      if (result?.managed?.routing_cancelled) return post(channel, '⎋ *Interrupted* adaptive routing; the queued prompt was not delivered.')
      if (result?.managed?.status === 'paused') return post(channel, '⎋ *Interrupted* the turn and paused its managed run. Resume with `/sab-run continue`.')
    } else if (activeProvider === 'codex') {
      const interruptedTurnStartedAt = session.codexTurnStartedAt ?? null
      try { await tmuxInterrupt(session.tmux, 'codex') }
      catch (error) { return post(channel, `⚠️ Codex interrupt could not be sent: ${String(error?.message || error).slice(0, 200)}`) }
      await failTeamTaskForSession(session, 'The delegated worker turn was interrupted by the owner.')
      const outcome = await waitForCodexInterrupt(session, { getPane: () => tmuxCapture(session.tmux) })
      if (outcome === 'hook') return post(channel, '⎋ *Interrupted* the running turn.')
      if (outcome === 'superseded' || (session.codexTurnStartedAt ?? null) !== interruptedTurnStartedAt) {
        return post(channel, '⎋ *Interrupted* the prior turn; a newer Codex turn is already running.')
      }
      if (outcome === 'idle') {
        stopPoller(session)
        await clearStatus(session)
        return post(channel, interruptedTurnStartedAt === null
          ? 'ℹ️ Codex is already idle; any stale working status was cleared.'
          : '⎋ *Interrupted* the running turn. Codex returned to idle and its working status was cleared.')
      }
      return post(channel, '⚠️ Interrupt sent, but Codex did not return to idle within 5 seconds. The working status remains active; retry `/sab-stop` or inspect the terminal with `/sab-terminal open`.')
    } else {
      await tmuxInterrupt(session.tmux, activeProvider)
      await failTeamTaskForSession(session, 'The delegated worker turn was interrupted by the owner.')
    }
    return post(channel, '⎋ *Interrupted* the running turn.')
  }
  if (name === 'usage') {
    let usageProvider = commandProvider
    if (!channelSession && !ingressProvider && PROVIDERS.includes(String(rest[0] || '').toLowerCase())) {
      usageProvider = rest.shift().toLowerCase()
    }
    const sub = (rest[0] || '').toLowerCase()
    if (!usageProvider) {
      await post(channel, '⏳ Crunching usage across providers…')
      for (const provider of PROVIDERS) {
        try {
          if (provider === 'pi') await piUsageReport(channel, sub, rest[1])
          else if (sub === 'limits') {
            if (provider === 'claude') await usageLimits(channel)
          } else if (sub === 'days' || sub === 'daily') await usageDays(channel, rest[1], provider)
          else if (sub === 'models') await usageModels(channel, provider)
          else await usageReport(channel, provider)
        } catch (error) { await post(channel, `⚠️ ${providerLabel(provider)} usage failed: ${String(error?.message || error).slice(0, 200)}`) }
      }
      return
    }
    if (usageProvider === 'pi') return piUsageReport(channel, sub, rest[1])
    if (sub === 'limits') {
      if (usageProvider === 'codex') return post(channel, 'Codex plan-limit windows are not exposed by ccusage; token and cost reports are available here.')
      return usageLimits(channel) // instant — no transcript scan
    }
    await post(channel, '⏳ Crunching transcripts…')
    try {
      if (sub === 'days' || sub === 'daily') return await usageDays(channel, rest[1], usageProvider)
      if (sub === 'models') return await usageModels(channel, usageProvider)
      return await usageReport(channel, usageProvider)
    } catch (e) { log('usage error', String(e)); return post(channel, `⚠️ ccusage failed: ${String(e?.message || e).slice(0, 200)}`) }
  }
  if (name === 'account') {
    const session = sessionByChannel(channel)
    const available = listAccounts()
    const known = available.length ? available.map(a => `\`${a}\``).join(' · ') : '_none yet — add one on the Mac with_ `sab account add <name>`'
    if (!session) return post(channel, `*Subscriptions available:* ${known}\nRun \`/sab-account <name>\` in a Claude session channel to bind that session to an account.`)
    if (providerOf(session) !== 'claude') return post(channel, '`/sab-account` is Claude-only; this provider uses its native machine configuration.')
    const cur = session.account ? `\`${session.account}\`` : "this machine's own Claude login (default)"
    if (!rest.length) {
      return post(channel, `*Subscription for this session:* ${cur}\n*Available:* ${known}\nSwitch with \`/sab-account <name>\` (or \`/sab-account default\`). The session restarts and resumes — the conversation is kept.`)
    }
    const want = rest[0].toLowerCase()
    if (want === 'default' || want === 'none') return switchAccount(session, null)
    const picked = safeAccount(rest[0])
    if (!picked || !available.includes(picked)) return post(channel, `❌ Unknown account \`${rest[0]}\`. *Available:* ${known}`)
    if (picked === session.account) return post(channel, `Already running under \`${picked}\`.`)
    return switchAccount(session, picked)
  }
  if (name === 'update' || name === 'restart') {
    const all = rest.length === 1 && rest[0].toLowerCase() === 'all'
    if (rest.length && !all) return post(channel, 'Usage: `/sab-update [all]`')
    if (all) return updateAllSessions(channel)
    const session = sessionByChannel(channel)
    if (!session) return post(channel, 'Use `/sab-update` in a session channel, or `/sab-update all` to update every idle active session.')
    return updateAndRestart(session)
  }
  if (name === 'flags') {
    const session = sessionByChannel(channel)
    if (!session) return post(channel, `Use \`${cmd('flags')}\` in a ${providerLabel(commandProvider)} session channel.`)
    const provider = providerOf(session)
    const alias = provider === 'claude' ? ' (`--dsp` works too)'
      : provider === 'codex' ? ' (`--yolo` works too)'
        : ' (Pi tools are unrestricted by default; `--approve` only controls project resources)'
    const allowed = allowedFlags(provider).map(f => `\`${f}\``).join(' · ') + alias
    if (!rest.length) {
      const cur = displayFlags(session)
      return post(channel, `*Launch flags:* ${cur.length ? '\`' + cur.join(' ') + '\`' : '_none_'}\n` +
        `Set with \`${cmd('flags')} <flags…>\` — the session restarts and resumes this conversation.\n*Allowed:* ${allowed}`)
    }
    const flags = []
    for (const f of rest) {
      const norm = normalizeLaunchFlag(provider, f)
      if (!norm) return post(channel, `❌ Flag not allowed: \`${f}\`\n*Allowed:* ${allowed}`)
      if (!flags.includes(norm)) flags.push(norm)
    }
    return setFlags(session, flags)
  }
  if (name === 'new') {
    if (!ingressProvider) {
      const requested = normalizeProvider(rest[0], null)
      if (!requested) return post(channel, 'Usage: `/sab-new <claude|codex|pi> [folder] [flags]`')
      commandProvider = requested
      rest = rest.slice(1)
    }
    const providerFlag = rest.find(arg => arg === '--codex' || arg === '--claude' || arg === '--pi')
    if (providerFlag) {
      const requested = providerFlag.slice(2)
      return post(channel, `❌ Provider flags are retired. Use \`/sab-new ${requested} [folder] [flags]\`.`)
    }
    if (!rest.length) return postFolderPicker(channel, commandProvider)
    return spawnNew(channel, rest[0], rest.slice(1), commandProvider)
  }
  return post(channel, `Unknown command: \`${name}\`. Try \`${cmd('help')}\`.`)
}

// ---- durable script-facing automation lifecycle ---------------------------
// An automation owns one deterministic tmux identity. Journal transitions are
// synchronous; Slack/tmux effects happen only after the preceding state is on
// disk, so a daemon restart can reconcile without launching or prompting twice.
async function launchAutomation(record) {
  if (record.provider === 'pi' && state.control) {
    pendingSpawnChannels.set(record.tmux, state.control)
    const timer = setTimeout(() => pendingSpawnChannels.delete(record.tmux), 10 * 60000)
    timer.unref?.()
  }
  await executionNodes.spawn(LOCAL_NODE_ID, {
    cwd: record.cwd,
    args: record.flags,
    title: `sab automation ${path.basename(record.cwd)}`,
    tmuxName: record.tmux,
    autoConsent: record.provider === 'claude',
    account: null,
    provider: record.provider,
  })
  let up = false
  for (let i = 0; i < AUTOMATION_TMUX_LAUNCH_ATTEMPTS && !up; i++) {
    await sleep(AUTOMATION_TMUX_POLL_INTERVAL_MS)
    up = await executionNodes.tmuxAlive(LOCAL_NODE_ID, record.tmux)
  }
  if (!up) throw new Error(`automation tmux did not materialize: ${record.tmux}`)
  log('automation launch accepted', record.provider, record.externalKey, record.tmux)
}

async function waitForAutomationInput(session) {
  await waitForProviderInput(session, {
    isProcessAlive: pidAlive,
    isTmuxAlive: tmuxAlive,
    piStream: pid => streams.get(pid),
    sleep,
  })
}

async function injectAutomationPrompt(session, prompt) {
  if (!(session.pid && pidAlive(session.pid))) throw new Error('the correlated provider process is not alive')
  if (providerOf(session) === 'pi') {
    if (!injectQueuedPiPrompt(session.pid, prompt)) throw new Error('the Pi input stream is not connected')
    rememberInjected(session.id, prompt)
    return
  }
  if (!session.tmux || !(await tmuxAlive(session.tmux))) throw new Error('the correlated tmux session is not alive')
  rememberInjected(session.id, prompt)
  await tmuxPaste(session.tmux, prompt)
}

async function terminateAutomation(record) {
  const session = validateAutomationStopTarget(state, record)

  if (session && providerOf(session) === 'pi' && session.pid && pidAlive(session.pid) && session.managed?.status === 'active') {
    try { await sendPiControl(session, 'managed-cancel') } catch {}
  }
  if (record.tmux) {
    await terminateAutomationTmux(record.tmux, {
      isAlive: tmuxAlive,
      terminate: tmuxKill,
      sleep,
    })
  }
  if (session?.pid && pidAlive(session.pid)) { try { process.kill(session.pid) } catch {} }
  if (session) {
    stopPoller(session)
    await clearStatus(session).catch(() => {})
    clearPermissionsForPid(session.pid, 'automation stopped')
    qforms.delete(session.id)
    pendingBySid.delete(session.id)
    restarting.delete(session.id)
    switchingSids.delete(session.id)
    internalTurns.delete(session.id)
  }
  if (record.sessionId || record.channelId) {
    artifactGrants.revoke({
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      ...(record.channelId ? { channelId: record.channelId } : {}),
      provider: record.provider,
    })
  }

  const channel = record.channelId
  detachAutomationState(state, record)
  if (channel) {
    deleteHandoffs(CONFIG_DIR, channel)
  }
  pendingSpawnChannels.delete(record.tmux)
  saveStateNow(state)
}

async function archiveAutomationChannel(channel, record) {
  if (!record.channelId || channel !== record.channelId) throw new Error('refusing to archive a non-correlated channel')
  try { await web.conversations.archive({ channel }) }
  catch (error) {
    if (error?.data?.error !== 'already_archived') throw error
  }
}

const automationLifecycle = createAutomationLifecycle({
  state,
  persist: () => saveStateNow(state),
  launch: launchAutomation,
  invite: inviteSlackCollaborator,
  inject: injectAutomationPrompt,
  waitForInputReady: waitForAutomationInput,
  terminate: terminateAutomation,
  archive: archiveAutomationChannel,
  isTmuxAlive: tmuxAlive,
  notifyFailure: async (record, failure) => {
    log('automation failure', record.externalKey, failure.code, failure.message)
    if (record.channelId) {
      await post(record.channelId, `❌ *Automation failed* — ${failure.message}\n*Action:* ${failure.action}`).catch(() => {})
    }
  },
  log,
})
let automationReconciler = null
function startAutomationReconciler() {
  if (automationReconciler) return
  automationReconciler = setInterval(() => {
    automationLifecycle.reconcile().catch(error => log('automation reconciliation failed', String(error?.message || error)))
  }, 30000)
  automationReconciler.unref?.()
}

const terminalControl = createTerminalControl({
  state, executionNodes,
})

// ---- HTTP (hooks in, SSE out) ----------------------------------------------
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (await handleNodeHttp(req, res, url, getNodeManagement)) return
  if (await handleTeamHttp(req, res, url, teamService)) return
  if (await handleAutomationHttp(req, res, url, automationLifecycle)) return
  if (await handleTerminalHttp(req, res, url, terminalControl)) return
  if (url.pathname === '/codex/commentary' && req.method === 'POST') {
    if (req.headers['x-ccs-provider'] !== 'codex' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      res.writeHead(403); res.end('forbidden'); return
    }
    let raw = ''
    let rawBytes = 0
    for await (const chunk of req) {
      rawBytes += chunk.length
      raw += chunk
      if (rawBytes > (64 << 10)) { res.writeHead(413); res.end('too large'); return }
    }
    try {
      const parsed = JSON.parse(raw)
      const commentary = commentaryFromAppServerMessage({
        method: 'item/completed',
        params: {
          threadId: parsed.threadId,
          turnId: parsed.turnId,
          item: {
            id: parsed.itemId,
            type: 'agentMessage',
            phase: 'commentary',
            text: parsed.text,
          },
        },
      })
      if (!commentary) { res.writeHead(400); res.end('invalid commentary'); return }
      const reportedPid = await resolveAgentPid(url.searchParams.get('ppid'), 'codex')
      const pid = await codexAppServerProcessPid(reportedPid, { execFile })
      const tmux = url.searchParams.get('tmux') || ''
      const session = state.sessions[commentary.threadId]
      const targetClaim = transitionForTarget(state, 'codex', tmux)
      const disposition = codexCommentaryDisposition({
        session,
        commentary,
        pid,
        tmux,
        tmuxClaimValid: session ? await validTmuxClaim(pid, tmux) : false,
        activeSessionId: session?.channel ? state.channels[session.channel] : null,
        privateTurn: internalTurns.has(commentary.threadId),
        targetClaim: Boolean(targetClaim),
      })
      if (disposition === 'ignore') { res.writeHead(204); res.end(); return }
      if (disposition === 'not_ready') { res.writeHead(409); res.end('session or channel not ready'); return }
      if (disposition === 'forbidden') { res.writeHead(403); res.end('identity mismatch'); return }
      if (!claimCodexCommentary(session, commentary.itemId)) {
        res.writeHead(200); res.end('duplicate'); return
      }
      // Claim before the Slack side effect so proxy retries and daemon restarts
      // cannot duplicate a progress update. A known Slack failure releases the
      // claim and asks the local proxy to retry.
      saveStateNow(state)
      try {
        await postMd(session.channel, commentary.text)
        res.writeHead(202); res.end('accepted')
      } catch (error) {
        releaseCodexCommentary(session, commentary.itemId)
        saveStateNow(state)
        log('Codex commentary post failed', commentary.itemId.slice(0, 12), error?.data?.error || String(error))
        res.writeHead(503); res.end('Slack delivery failed')
      }
    } catch (error) {
      log('Codex commentary rejected', String(error?.message || error))
      res.writeHead(400); res.end('invalid commentary')
    }
    return
  }
  if (url.pathname === '/hook' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      await onHook(JSON.parse(body), url.searchParams.get('ppid'), url.searchParams.get('tmux'),
        req.headers['x-ccs-flags'], req.headers['x-ccs-account'], req.headers['x-ccs-provider'] || 'claude')
    }
    catch (e) { log('hook error', String(e)) }
    return
  }
  if (url.pathname === '/statusline' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      const j = JSON.parse(body)
      // Plan rate limits (5h session %, weekly %, reset times) ride along on every
      // statusline tick. They're account-wide, so one fresh copy serves all views.
      if (j.rate_limits) rateLimits = { at: Date.now(), buckets: j.rate_limits }
      if (j.session_id) {
        const prev = sessionMeta.get(j.session_id) || {}
        const next = {
          ...prev,
          model: j.model?.display_name || prev.model,
          effort: j.effort?.level || prev.effort,
          ctxPct: j.context_window?.used_percentage ?? prev.ctxPct,
          cost: j.cost?.total_cost_usd ?? prev.cost,
        }
        sessionMeta.set(j.session_id, next)
        const session = state.sessions[j.session_id]
        if (session?.channel) {
          if (j.cwd) session.cwd = j.cwd // folder can change; keep it current
          if (j.effort?.level && session.effort !== j.effort.level) { session.effort = j.effort.level; saveState(state) } // persist actual telemetry for topics
          if (j.model?.display_name && session.model !== j.model.display_name) { session.model = j.model.display_name; saveState(state) } // persist so topics survive restarts
          const changed = prev.model !== next.model || prev.effort !== next.effort
          if (changed || Date.now() - (lastTopicAt.get(session.channel) || 0) > 6000) {
            lastTopicAt.set(session.channel, Date.now())
            await updateTopic(session)
            if (providerOf(session) === 'codex') await reportCodexModelMismatch(session)
          }
        }
      }
    } catch {}
    return
  }
  if (url.pathname === '/permission-request' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    res.end('ok')
    try {
      const p = JSON.parse(body)
      const pid = await resolveClaudePid(url.searchParams.get('ppid'))
      const session = sessionByPid(pid)
      if (!session?.channel) { log('perm-request: no channel for pid', pid); return }
      const ts = await postPermissionPrompt(session.channel, p)
      state.perms[p.request_id] = { pid, channel: session.channel, ts, tool: p.tool_name || 'tool' }
      saveState(state)
      log('perm-request', p.request_id, p.tool_name, '→', session.id.slice(0, 8))
    } catch (e) { log('perm-request error', String(e)) }
    return
  }
  if (url.pathname === '/codex/permission' && req.method === 'POST') {
    let raw = ''
    for await (const c of req) raw += c
    res.setHeader('content-type', 'application/json')
    try {
      const p = JSON.parse(raw)
      const pid = await resolveAgentPid(url.searchParams.get('ppid'), 'codex')
      const session = state.sessions[p.session_id] || sessionByPid(pid)
      const tmux = url.searchParams.get('tmux')
      const validClaim = !tmux || await validTmuxClaim(pid, tmux)
      if (!session?.channel || providerOf(session) !== 'codex' ||
          (session.pid && session.pid !== pid) || (session.tmux && tmux && session.tmux !== tmux) || !validClaim) {
        log('codex perm-request: no Codex channel for pid', pid)
        return res.end('{}') // no hook decision → ordinary local approval prompt
      }
      const rid = permissionId()
      let preview = ''
      try { preview = JSON.stringify(p.tool_input ?? {}, null, 2) } catch { preview = String(p.tool_input || '') }
      const prompt = {
        request_id: rid,
        provider: 'codex',
        tool_name: p.tool_name || 'tool',
        description: p.tool_input?.description || 'Approval requested by Codex.',
        input_preview: preview,
      }
      const ts = await postPermissionPrompt(session.channel, prompt)
      state.perms[rid] = { pid, channel: session.channel, ts, tool: prompt.tool_name, provider: 'codex' }
      saveState(state)
      const timer = setTimeout(async () => {
        const waiter = codexPermissionWaiters.get(rid)
        if (!waiter) return
        codexPermissionWaiters.delete(rid)
        delete state.perms[rid]
        saveState(state)
        if (!res.writableEnded) res.end('{}')
        try {
          await web.chat.update({ channel: session.channel, ts, text: `⌛ Expired ${prompt.tool_name}`, blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `⌛ *Permission request expired* \`${escapeText(prompt.tool_name)}\`` } },
          ] })
        } catch {}
      }, 570000)
      codexPermissionWaiters.set(rid, { res, timer })
      res.on('close', () => {
        const waiter = codexPermissionWaiters.get(rid)
        if (!waiter || waiter.res !== res) return
        clearTimeout(waiter.timer)
        codexPermissionWaiters.delete(rid)
        delete state.perms[rid]
        saveState(state)
      })
      log('codex perm-request', rid, prompt.tool_name, '→', session.id.slice(0, 8))
    } catch (e) {
      log('codex perm-request error', String(e))
      if (!res.writableEnded) res.end('{}')
    }
    return
  }
  if (url.pathname === '/pi/event' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json')
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const event = JSON.parse(raw || '{}')
      await onHook({
        ...event,
        hook_event_name: event.event,
        transcript_path: event.session_file,
      }, url.searchParams.get('ppid'), url.searchParams.get('tmux'),
      req.headers['x-ccs-flags'], null, 'pi')
      res.end(JSON.stringify({ ok: true }))
    } catch (error) {
      log('Pi event error', String(error))
      res.writeHead(400); res.end(JSON.stringify({ ok: false }))
    }
    return
  }
  if (url.pathname === '/pi/permission' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json')
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const request = JSON.parse(raw || '{}')
      const pid = await resolveAgentPid(url.searchParams.get('ppid'), 'pi')
      const tmux = String(url.searchParams.get('tmux') || '')
      const session = state.sessions[request.session_id] || sessionByPid(pid)
      const transition = transitionForTarget(state, 'pi', tmux)
      const provisionalChannel = transition?.transition.target.sid === session?.id ? transition.channel : null
      const channel = session?.channel || provisionalChannel
      const validClaim = tmux && await validTmuxClaim(pid, tmux)
      if (!channel || providerOf(session) !== 'pi' || !validClaim ||
          (session.pid && Number(session.pid) !== Number(pid)) || (session.tmux && session.tmux !== tmux)) {
        return res.end(JSON.stringify({ behavior: 'deny', reason: 'Pi session identity was not authorized.' }))
      }
      const rid = permissionId()
      let preview = ''
      try { preview = JSON.stringify(request.tool_input ?? {}, null, 2) } catch { preview = String(request.tool_input || '') }
      const prompt = {
        request_id: rid, provider: 'pi', tool_name: request.tool_name || 'tool',
        description: 'Safe-mode approval requested by Pi.', input_preview: preview,
      }
      const ts = await postPermissionPrompt(channel, prompt)
      state.perms[rid] = { pid, channel, ts, tool: prompt.tool_name, provider: 'pi' }
      saveState(state)
      const timer = setTimeout(async () => {
        const waiter = piPermissionWaiters.get(rid)
        if (!waiter) return
        piPermissionWaiters.delete(rid); delete state.perms[rid]; saveState(state)
        if (!res.writableEnded) res.end(JSON.stringify({ behavior: 'deny', reason: 'Permission request expired.' }))
        await web.chat.update({ channel, ts, text: `⌛ Expired ${prompt.tool_name}`, blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `⌛ *Permission request expired* \`${escapeText(prompt.tool_name)}\`` } },
        ] }).catch(() => {})
      }, 570000)
      piPermissionWaiters.set(rid, { res, timer, provider: 'pi', kind: 'tool' })
      res.on('close', () => {
        const waiter = piPermissionWaiters.get(rid)
        if (!waiter || waiter.res !== res || res.writableEnded) return
        clearTimeout(waiter.timer); piPermissionWaiters.delete(rid); delete state.perms[rid]; saveState(state)
      })
    } catch (error) {
      log('Pi permission error', String(error))
      if (!res.writableEnded) res.end(JSON.stringify({ behavior: 'deny', reason: 'Permission relay failed.' }))
    }
    return
  }
  if (url.pathname === '/pi/trust' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json')
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const request = JSON.parse(raw || '{}')
      const pid = await resolveAgentPid(url.searchParams.get('ppid'), 'pi')
      const tmux = String(url.searchParams.get('tmux') || '')
      if (!tmux || !(await validTmuxClaim(pid, tmux))) return res.end(JSON.stringify({ trusted: 'undecided' }))
      const candidate = sessionByPid(pid) || Object.values(state.sessions).find(item => item.tmux === tmux)
      const session = candidate && providerOf(candidate) === 'pi' &&
        (!candidate.pid || Number(candidate.pid) === Number(pid)) ? candidate : null
      const transition = transitionForTarget(state, 'pi', tmux)
      const channel = session?.channel || transition?.channel || pendingSpawnChannels.get(tmux)
      if (!channel) return res.end(JSON.stringify({ trusted: 'undecided' }))
      const rid = permissionId()
      const prompt = {
        request_id: rid, provider: 'pi', tool_name: 'project resources',
        description: `Trust Pi project-local settings, extensions, skills, and packages in ${String(request.cwd || '').slice(0, 500)}?`,
        input_preview: 'AGENTS.md and CLAUDE.md load regardless. Approval may execute project-local Pi extensions with your macOS permissions.',
      }
      const ts = await postPermissionPrompt(channel, prompt)
      state.perms[rid] = { pid, channel, ts, tool: prompt.tool_name, provider: 'pi', kind: 'trust' }
      saveState(state)
      const timer = setTimeout(async () => {
        const waiter = piPermissionWaiters.get(rid)
        if (!waiter) return
        piPermissionWaiters.delete(rid); delete state.perms[rid]; saveState(state)
        if (!res.writableEnded) res.end(JSON.stringify({ trusted: 'undecided' }))
        await web.chat.update({ channel, ts, text: '⌛ Pi project trust request expired', blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '⌛ *Pi project trust request expired* — decide locally in Ghostty or retry the launch.' } },
        ] }).catch(() => {})
      }, 570000)
      piPermissionWaiters.set(rid, { res, timer, provider: 'pi', kind: 'trust' })
      res.on('close', () => {
        const waiter = piPermissionWaiters.get(rid)
        if (!waiter || waiter.res !== res || res.writableEnded) return
        clearTimeout(waiter.timer); piPermissionWaiters.delete(rid); delete state.perms[rid]; saveState(state)
      })
    } catch (error) {
      log('Pi trust relay error', String(error))
      if (!res.writableEnded) res.end(JSON.stringify({ trusted: 'undecided' }))
    }
    return
  }
  if (url.pathname === '/pi/stream' && req.method === 'GET') {
    const pid = await resolveAgentPid(url.searchParams.get('ppid'), 'pi')
    const tmux = String(url.searchParams.get('tmux') || '')
    const session = sessionByPid(pid)
    const target = transitionForTarget(state, 'pi', tmux)
    if (!tmux || !(await validTmuxClaim(pid, tmux)) ||
        (!target && (!session || providerOf(session) !== 'pi' || session.tmux !== tmux))) {
      res.writeHead(403); res.end(); return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n')
    streams.set(pid, { res, provider: 'pi' })
    log('Pi extension stream attached pid', pid)
    if (session) {
      const queued = pendingBySid.get(session.id) || []
      if (queued.length) {
        pendingBySid.set(session.id, [])
        for (const item of queued) {
          rememberInjected(session.id, queuedPromptText(item))
          if (!injectQueuedPiPrompt(pid, item)) {
            log('Pi reconnect flush failed', session.id.slice(0, 8))
            pendingBySid.set(session.id, queued.slice(queued.indexOf(item)))
            break
          }
        }
      }
    }
    const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
    req.on('close', () => { clearInterval(ka); if (streams.get(pid)?.res === res) streams.delete(pid) })
    return
  }
  // Agent-facing artifact delivery. An opaque grant is minted only for an
  // owner/whitelisted Slack message; process ancestry + tmux bind the caller to
  // that same live provider session. The caller supplies paths, never a Slack
  // destination. Realpath containment prevents workspace and symlink escapes.
  if (url.pathname === '/artifact/upload' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json')
    try {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (Buffer.byteLength(raw) > 65536) {
          throw new ArtifactUploadError('request_too_large', 'The upload request is too large.', 413)
        }
      }
      let request
      try { request = JSON.parse(raw || '{}') }
      catch { throw new ArtifactUploadError('invalid_json', 'The upload request is not valid JSON.') }

      const provider = normalizeProvider(req.headers['x-ccs-provider'] || 'claude')
      const tmux = String(url.searchParams.get('tmux') || '')
      if (!provider || !tmux) {
        throw new ArtifactUploadError('unauthorized_session', 'The upload must come from a live bridged session.', 403)
      }
      const pid = await resolveAgentPid(url.searchParams.get('ppid'), provider)
      const session = sessionByPid(pid)
      const validClaim = session?.tmux === tmux && await validProviderRootClaim(pid, tmux, provider)
      if (!session?.channel || providerOf(session) !== provider || !validClaim || !pidAlive(pid)) {
        throw new ArtifactUploadError('unauthorized_session', 'The upload must come from its authorized live session.', 403)
      }

      const result = await fulfillArtifactUpload(artifactGrants, {
        token: request.grant,
        binding: { sessionId: session.id, channelId: session.channel, provider },
        paths: request.paths,
      }, async ({ grant, files }) => {
        await enqueue(grant.channelId, () => web.filesUploadV2(slackArtifactUploadOptions(grant, files)))
        if (!grant.threadTs) await bumpStatusForChannel(grant.channelId)
      })
      log('artifact uploaded', provider, session.id.slice(0, 8), result.filenames.join(','), result.totalBytes + 'b')
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (error) {
      if (error instanceof ArtifactUploadError) {
        res.writeHead(error.status)
        res.end(JSON.stringify({ ok: false, error: error.message, code: error.code }))
      } else {
        log('artifact upload failed', error?.data?.error || String(error))
        res.writeHead(502)
        res.end(JSON.stringify({ ok: false, error: 'Slack did not accept the upload; the grant remains retryable.' }))
      }
    }
    return
  }
  // Script-facing spawn API (localhost-only, same trust domain as /hook).
  // POST /spawn {cwd, flags[]} — launch a bridged session through the daemon so
  // external scripts (worktree tooling etc.) get the single-icon window path
  // and flag validation instead of rolling their own `open -na Ghostty`.
  if (url.pathname === '/spawn' && req.method === 'POST') {
    let body = ''
    for await (const c of req) body += c
    try {
      const j = JSON.parse(body || '{}')
      const provider = normalizeProvider(j.provider || 'claude')
      if (!provider) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'unknown provider' })) }
      const cwd = path.resolve(String(j.cwd || '').replace(/^~/, process.env.HOME))
      if (!isPathWithin(process.env.HOME, cwd) || !fs.existsSync(cwd)) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'cwd not allowed or missing' })) }
      let flags
      try { flags = normalizeRemoteLaunchFlags(provider, j.flags || []) }
      catch (error) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: String(error?.message || error) })) }
      const account = provider === 'claude' && j.account ? safeAccount(j.account) : null
      if (j.account && !account) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: 'invalid account name' })) }
      const tmuxName = `sab-new-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
      await executionNodes.spawn(LOCAL_NODE_ID, {
        cwd, args: flags, title: `sab ${path.basename(cwd)}`, tmuxName,
        autoConsent: provider === 'claude', account, provider,
      })
      log('spawned via /spawn', provider, cwd, JSON.stringify(flags), account ? `account=${account}` : '')
      res.end(JSON.stringify({ ok: true, tmux: tmuxName, provider }))
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e?.message || e) })) }
    return
  }
  if (url.pathname === '/channel/stream') {
    const ppid = Number(url.searchParams.get('ppid'))
    const pid = await resolveClaudePid(ppid)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': connected\n\n')
    streams.set(pid, { res, provider: 'claude' })
    log('channel attached pid', pid)
    // attach to a session record and flush any queued messages for its sid
    const session = sessionByPid(pid)
    if (session) {
      const q = pendingBySid.get(session.id)
      if (q?.length) { for (const m of q) injectToSession(pid, m); pendingBySid.set(session.id, []) }
    }
    const ka = setInterval(() => { try { res.write(': ka\n\n') } catch {} }, 15000)
    req.on('close', () => { clearInterval(ka); if (streams.get(pid)?.res === res) streams.delete(pid) })
    return
  }
  res.writeHead(404); res.end()
}).listen(8877, '127.0.0.1', () => log('daemon http on 127.0.0.1:8877'))

// ---- Slack Socket Mode ------------------------------------------------------
async function handleSocketMessage({ event }) {
  if (!event) return
  // A Slack topic change is rendered as a channel timeline item. Re-anchor an
  // active status after manual topic changes too; bridge-owned changes also do
  // this directly in updateTopic, and the event timestamp makes this a no-op if
  // that path already won the race.
  if (event.subtype === 'channel_topic') {
    await bumpStatusForChannel(event.channel, event.ts || null)
    return
  }
  if (event.bot_id) return
  // allow normal messages and file shares; skip edits/joins/other subtypes
  if (event.subtype && event.subtype !== 'file_share') return
  // Re-anchor before processing so even a queued or rejected human message
  // cannot leave a live working status stranded above it in the channel.
  if (!event.thread_ts) await bumpStatusForChannel(event.channel, event.ts || null)
  // The owner is always trusted; a whitelisted collaborator may post prompts too.
  const isOwner = event.user === USER
  const name = isOwner ? null : whitelistedName(event.channel, event.user)
  if (!isOwner && !name) return
  const sender = isOwner ? null : { id: event.user, name }
  const request = {
    userId: event.user,
    messageTs: event.ts || null,
    threadTs: event.thread_ts || null,
  }
  try {
    const text = unescapeSlack(event.text || '')
    if (event.files?.length) await handleAttachments(event.channel, text, event.files, sender, request)
    else await handleSlackMessage(event.channel, text, sender, request)
  } catch (e) { log('slack msg error', String(e)) }
}

// Native /sab-* slash commands are delivered over Socket Mode. The immutable
// channel binding—not the command name—is the source of provider truth.
// First-run ownership claim. Fresh installs start with no SLACK_USER_ID — the
// installer no longer asks anyone to dig their member ID out of their profile.
// The first person to run /sab-claim becomes the owner, persisted to the config
// env; until then the daemon trusts nobody and does nothing else.
function persistOwner(uid) {
  const f = path.join(CONFIG_DIR, 'env')
  let env = ''
  try { env = fs.readFileSync(f, 'utf8') } catch {}
  env = /^SLACK_USER_ID=/m.test(env)
    ? env.replace(/^SLACK_USER_ID=.*/m, `SLACK_USER_ID=${uid}`)
    : env.trimEnd() + `\nSLACK_USER_ID=${uid}\n`
  fs.writeFileSync(f, env, { mode: 0o600 })
}
// Reply visibly to a slash command in channels the bot may not be a member of.
async function respondEphemeral(body, text) {
  if (!body?.response_url) return false
  try {
    const response = await fetch(body.response_url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, response_type: 'ephemeral' }),
    })
    return response.ok
  } catch { return false }
}

async function handleSocketSlashCommand({ body }) {
  try {
    const parsed = parseSlackCommand(body.command)
    if (!parsed) return respondEphemeral(body, 'Unknown bridge command.')
    const { name, provider } = parsed
    if (!USER) {
      if (name !== 'claim') return respondEphemeral(body, 'This bridge is unclaimed — run `/sab-claim` to become its owner.')
      USER = body.user_id
      persistOwner(USER)
      log('owner claimed', USER)
      await respondEphemeral(body, '👑 You own this bridge now. Check your private bridge control channel.')
      if (state.control) {
        try { await web.conversations.invite({ channel: state.control, users: USER }) } catch {}
        await post(state.control, `👑 <@${USER}> claimed this bridge. Type \`/sab-\` to see the unified commands; start with \`/sab-new <claude|codex|pi>\`.`).catch(() => {})
      }
      return
    }
    if (name === 'claim') {
      return respondEphemeral(body, body.user_id === USER ? 'You already own this bridge.' : 'This bridge already has an owner.')
    }
    if (body.user_id !== USER) return
    const rest = String(body.text || '').trim().split(/\s+/).filter(Boolean)
    log('slash', body.command, JSON.stringify(body.text || ''))
    await dispatch(name, rest, body.channel_id, provider, { userId: body.user_id })
  } catch (e) {
    log('slash error', String(e))
    const delivered = await reportSlashFailure(body, { postChannel: post, postEphemeral: respondEphemeral })
    if (delivered === 'none') log('slash feedback failed', body?.command || 'unknown command')
  }
}

// Interactive components: Approve/Deny buttons and provider folder pickers.
async function handleSocketInteractive({ body }) {
  try {
    if (body?.type !== 'block_actions' || body.user?.id !== USER) return
    const action = body.actions?.[0]
    if (!action) return
    if (String(action.action_id || '').startsWith('sabnew_folder_')) {
      const folder = action.selected_option?.value
      const provider = normalizeProvider(String(action.action_id).slice('sabnew_folder_'.length), null)
      if (folder) await spawnNew(body.channel?.id, path.join(codeDir(), folder), defaultNewFlags(provider), provider)
      return
    }
    if (String(action.action_id || '').startsWith('team_add_channel:')) {
      const teamId = String(action.action_id).slice('team_add_channel:'.length)
      const sourceChannel = body.channel?.id
      const targetChannel = action.selected_conversation
      try {
        const team = teamById(state, teamId)
        if (!sourceChannel || team.coordinatorChannel !== sourceChannel) {
          throw new TeamError('not_team_coordinator', 'This picker no longer belongs to the team coordinator channel.', 403)
        }
        const target = sessionByChannel(targetChannel)
        if (!target || state.channels?.[targetChannel] !== target.id) {
          throw new TeamError('not_sab_channel', 'The selected channel is not an authoritative SAB session channel.')
        }
        if (activeTransition(targetChannel)) throw new TeamError('target_switching', 'The selected channel is switching providers.')
        const info = await web.conversations.info({ channel: targetChannel })
        if (!info.channel?.is_private || info.channel?.is_archived) {
          throw new TeamError('invalid_target_channel', 'Choose an active private SAB session channel.')
        }
        const alias = normalizeTeamAlias(info.channel.name || `worker-${target.id.slice(0, 8)}`)
        const member = addTeamWorker(state, team.id, { channel: targetChannel, alias })
        saveStateNow(state)
        try {
          await post(targetChannel,
            `🕸️ Joined session team \`${team.name}\` as worker \`${member.alias}\`. <#${sourceChannel}> is the coordinator. ` +
            'Delegated tasks carry an immutable task ID; stable final responses return automatically.')
          await post(sourceChannel,
            `✅ Added <#${targetChannel}> as worker \`${member.alias}\` in \`${team.name}\`. Text delegation is enabled; file relay remains off until \`/sab-team permissions ${member.alias} files on\`.`)
        } catch (notificationError) {
          removeTeamWorker(state, team.id, member.alias)
          saveStateNow(state)
          await post(targetChannel, `⚠️ Team join rolled back because SAB could not report it in both affected channels.`).catch(() => {})
          throw new TeamError('team_join_audit_failed',
            `The membership was rolled back because Slack could not report it: ${notificationError?.data?.error || notificationError?.message || notificationError}`, 502)
        }
      } catch (error) {
        log('team add failed', teamId, targetChannel, error?.code || error?.data?.error || String(error))
        await post(sourceChannel, `❌ Could not add that team worker. ${String(error?.message || error).slice(0, 800)}`)
      }
      return
    }
    if (action.action_id === 'collab_add') {
      const uid = action.selected_user, channel = body.channel?.id
      if (uid && channel && uid !== USER) {
        try {
          const result = await inviteAndWhitelistCollaborator({
            state,
            channel,
            userId: uid,
            invite: (target, user) => web.conversations.invite({ channel: target, users: user }),
            resolveUserName,
            persist: () => saveStateNow(state),
          })
          log('collab add', uid, JSON.stringify(result.name), result.invitation, '→', channel)
          await refreshCollabPanel(body)
          await post(channel, `✅ <@${uid}> can now send prompts here — labelled *[Slack collaborator ${result.name}]* in the transcript.`)
        } catch (error) {
          log('collab invitation failed', uid, '→', channel, error?.code || error?.data?.error || String(error))
          await post(channel, `❌ Could not invite <@${uid}> to this private channel, so they were *not* added to the prompt whitelist. ${String(error?.message || error).slice(0, 800)}`)
        }
      }
      return
    }
    if (action.action_id === 'collab_rm') {
      const uid = String(action.value || '').split(':')[1], channel = body.channel?.id
      if (uid && channel && collaborators(channel)[uid]) {
        delete state.whitelist[channel][uid]
        if (!Object.keys(state.whitelist[channel]).length) delete state.whitelist[channel]
        saveState(state)
        log('collab remove', uid, '→', channel)
        await refreshCollabPanel(body)
        await post(channel, `🚫 Removed <@${uid}> — they can no longer post here.`)
      }
      return
    }
    if (String(action.action_id || '').startsWith('provider_switch_')) {
      const [kind, transitionId, actionName] = String(action.value || '').split(':')
      if (kind === 'switch' && transitionId && actionName) {
        await handleProviderSwitchAction(body.channel?.id, transitionId, actionName)
      }
      return
    }
    if (String(action.action_id || '').startsWith('qform_')) {
      const [, sid, n] = String(action.value || '').split(':')
      const session = state.sessions[sid]
      const o = session && qforms.get(sid)?.options.find(x => String(x.n) === n)
      if (session && o && session.tmux && (await tmuxAlive(session.tmux))) await answerQuestionForm(session, o.n, o.label)
      return
    }
    if (action.value) {
      const [behavior, rid] = String(action.value).split(':')
      await applyVerdict(rid, behavior, body.channel?.id, body.message?.ts)
    }
  } catch (e) { log('interactive error', String(e)) }
}

const socketCoordinator = createSocketModeCoordinator({
  socket: slackRuntime.socket,
  handlers: {
    message: handleSocketMessage,
    slash_commands: handleSocketSlashCommand,
    interactive: handleSocketInteractive,
  },
  onError: (kind, error) => log(`socket ${kind} error`, error?.stack || String(error)),
})

// ---- bridge self-update ------------------------------------------------------
// Every install is a git clone running under launchd with KeepAlive, so keeping
// users current is: fast-forward the clone, refresh deps if package.json moved,
// then exit — launchd restarts the daemon on the new code (sessions keep running;
// restart recovery re-adopts them). Checks at boot and every 6h.
// Opt out with CCS_AUTO_UPDATE=0 in ~/.config/ccs/env.
const pkgVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8')).version } catch { return '?' } }
async function selfUpdate(trigger) {
  if (process.env.CCS_AUTO_UPDATE === '0') return
  const git = (...a) => execFile('git', ['-C', BRIDGE, ...a], { timeout: 60000 })
  try { await git('rev-parse', '--git-dir') } catch { return } // not a git install
  try { await git('fetch', '--quiet', 'origin') } catch { log('self-update: fetch failed (offline?)'); return }
  let ahead = 0, behind = 0
  try {
    const { stdout } = await git('rev-list', '--left-right', '--count', 'HEAD...@{u}')
    ;[ahead, behind] = stdout.trim().split(/\s+/).map(Number)
  } catch { if (trigger === 'boot') log('self-update: no upstream branch — skipping'); return }
  if (!behind) { if (trigger === 'boot') log(`self-update: up to date (v${pkgVersion()})`); return }
  if ((await git('status', '--porcelain')).stdout.trim()) { log(`self-update: ${behind} commit(s) behind but working tree dirty — skipping (dev checkout?)`); return }
  if (ahead) { log('self-update: local commits not on origin — skipping'); return }
  const before = pkgVersion()
  const pkgBefore = fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8')
  try { await git('merge', '--ff-only', '@{u}') } catch (e) { log('self-update: fast-forward failed', e?.stderr || String(e)); return }
  if (fs.readFileSync(path.join(BRIDGE, 'package.json'), 'utf8') !== pkgBefore) {
    log('self-update: package.json changed — refreshing dependencies')
    try { await execFile('npm', ['ci', '--omit=dev'], { cwd: BRIDGE, timeout: 180000 }) }
    catch { await execFile('npm', ['install', '--omit=dev'], { cwd: BRIDGE, timeout: 180000 }).catch(e => log('self-update: npm install failed', String(e))) }
  }
  const after = pkgVersion()
  log(`self-update: v${before} → v${after}; restarting when idle`)
  for (let i = 0; i < 120 && (pollers.size || codexPollers.size || piPollers.size); i++) await sleep(5000) // prefer restarting between turns (≤10 min)
  if (state.control) await post(state.control, `⬆️ *Bridge updated* v${before} → v${after} — restarting the daemon. Sessions keep running.`).catch(() => {})
  setTimeout(() => process.exit(0), 800) // flush the post; launchd (KeepAlive) brings us back on the new code
}
setInterval(() => selfUpdate('interval').catch(e => log('self-update error', String(e))), 6 * 3600 * 1000)

// ---- liveness sweep ---------------------------------------------------------
setInterval(async () => {
  for (const s of Object.values(state.sessions)) {
    if (s.pid && !pidAlive(s.pid)) {
      log('sweep: pid dead', s.pid, s.id.slice(0, 8))
      const switching = transitionForSession(state, s.id)
      stopPoller(s)
      await failTeamTaskForSession(s, 'The worker process exited before completing its delegated task.')
      clearPermissionsForPid(s.pid, 'session process exited')
      s.pid = null
      if (switching?.transition.source.sid === s.id && ['preflight', 'aligning'].includes(switching.transition.phase)) {
        rollbackTransition(state, switching.channel, 'source process exited before provider handoff')
        saveStateNow(state)
        await post(switching.channel, '↩️ Provider switch cancelled because the source process exited before handoff capture. The channel remains on the source leg; write here to resume it.').catch(() => {})
        await flushTransitionQueue(switching.channel)
        continue
      }
      if (switching?.transition.source.sid === s.id && switching.transition.phase === 'handoff') {
        failPrivateTurn(s, new Error('source process exited during handoff capture'))
      } else if (switching?.transition.target.sid === s.id) {
        failPrivateTurn(s, new Error('target process exited during readiness validation'), switching)
      }
      try {
        await clearStatus(s)
        if (s.channel && !switchingSids.has(s.id) && !transitionForSession(state, s.id)) {
          await post(s.channel, '💤 *Session ended* — write here to resume it')
        }
      } catch (e) {
        if (e?.data?.error === 'is_archived') {
          deleteLineage(state, s.channel)
          log('sweep: dropped session with archived channel', s.id.slice(0, 8))
        } else log('sweep post error:', e?.data?.error || String(e))
      }
      saveState(state)
    }
  }
}, 30000)

// ---- boot -------------------------------------------------------------------
;(async () => {
  const r = await web.auth.test()
  log('slack auth ok:', r.team, 'bot', r.user)
  // Remove pre-v2 client-detached → kill-session hooks from adopted live
  // sessions. Terminal attachment no longer owns provider lifetime.
  let hydratedCodexEffort = false
  for (const s of Object.values(state.sessions)) {
    if (providerOf(s) === 'codex' && !s.effort) {
      const effort = resolveCodexEffort({ launchFlags: s.launchFlags, cwd: s.cwd })
      if (effort) { s.effort = effort; hydratedCodexEffort = true }
    }
    if (s.tmux && s.pid && pidAlive(s.pid)) { clearKillOnClose(s.tmux); updateTopic(s).catch(() => {}) }
  }
  if (hydratedCodexEffort) saveState(state)
  if (!state.control) {
    try {
      // Recover either identity before creating anything. This makes a missing
      // state.control field safe on upgrades and prevents duplicate channels.
      const existing = await findControlChannel(cursor => web.conversations.list({
        types: 'private_channel', limit: 200, ...(cursor ? { cursor } : {}),
      }))
      if (existing) state.control = existing.id
      else {
        const c = await web.conversations.create({ name: CONTROL_CHANNEL_NAME, is_private: true })
        state.control = c.channel.id
      }
      if (USER) { // fresh installs are unclaimed; /sab-claim invites the owner later
        try { await web.conversations.invite({ channel: state.control, users: USER }) } catch {}
        await post(state.control, '🤖 *Bridge online.* Type `/sab-` to see the unified commands; start with `/sab-new <claude|codex|pi>`.')
      }
    } catch (e) {
      if (e?.data?.error === 'name_taken') {
        const existing = await findControlChannel(cursor => web.conversations.list({
          types: 'private_channel', limit: 200, ...(cursor ? { cursor } : {}),
        }))
        state.control = existing?.id || null
      }
    }
    saveState(state)
  }
  await startConfiguredNodeListener()
  await socketCoordinator.start()
  log('socket mode connected — bridge ready')
  await recoverProviderSwitches()
  automationLifecycle.recover()
  startAutomationReconciler()
  await recoverHooklessCodexResumes()
  await readoptStatus() // recover live status for turns that were mid-flight on restart
  startTeamReconciler() // status adoption must fence workers that were already busy before restart
  selfUpdate('boot').catch(e => log('self-update error', String(e)))
})().catch(e => { log('BOOT FAILED', e); process.exit(1) })
