import crypto from 'node:crypto'

// Continuations are deliberately opt-in. Existing teams without this record
// remain manual, preserving the owner-turn safety boundary.
export const TEAM_CONTINUATION_MODES = new Set(['manual', 'auto-until-blocked'])
export const TEAM_CONTINUATION_MAX_PENDING = 64
export const TEAM_CONTINUATION_IDLE_GRACE_MS = 15_000
export const TEAM_CONTINUATION_IDLE_CONFIRMATIONS = 2
export const TEAM_CONTINUATION_WAIT_NOTICE_MS = 60_000

const nowIso = now => new Date(now).toISOString()

export function continuationFor(team, { create = false } = {}) {
  if (!team) return null
  if (create) {
    team.continuation ||= { mode: 'manual', pending: [], active: null }
    team.continuation.pending ||= []
  }
  return team.continuation || null
}

export function setContinuationMode(team, mode, { now = Date.now() } = {}) {
  const value = String(mode || '').toLowerCase()
  if (!TEAM_CONTINUATION_MODES.has(value)) throw new Error(`Unknown team continuation mode: ${value}`)
  const continuation = continuationFor(team, { create: true })
  continuation.mode = value
  continuation.updatedAt = nowIso(now)
  if (value === 'manual') delete continuation.waiting
  return continuation
}

const eventKeys = event => Array.isArray(event?.coalescedKeys)
  ? event.coalescedKeys
  : event?.key ? [event.key] : []

export function queueContinuation(team, { taskId, kind = 'completed', replyId = null, now = Date.now() } = {}) {
  const continuation = continuationFor(team, { create: true })
  if (continuation.mode !== 'auto-until-blocked') return { created: false, event: null }
  const key = `${String(taskId || '')}:${String(kind || 'completed')}:${String(replyId || '')}`
  const existing = continuation.pending.find(event => eventKeys(event).includes(key)) ||
    (eventKeys(continuation.active).includes(key) ? continuation.active : null)
  if (existing) return { created: false, event: existing }
  if (continuation.pending.length >= TEAM_CONTINUATION_MAX_PENDING) {
    throw new Error('Team continuation queue is full; owner attention is required.')
  }
  const event = {
    id: `team_event_${crypto.randomBytes(10).toString('base64url')}`,
    key, taskId: String(taskId || ''), replyId: replyId ? String(replyId) : null, kind: String(kind || 'completed'),
    status: 'queued', createdAt: nowIso(now), updatedAt: nowIso(now),
  }
  continuation.pending.push(event)
  return { created: true, event }
}

// A continuation prompt never trusts an event payload: it instructs the
// coordinator to reread the complete authenticated inbox. Consequently every
// event already queued at claim time can be represented by one durable wake.
// Keep the covered keys so hook/reply retries remain idempotent while queued.
export function coalesceContinuations(team, { now = Date.now() } = {}) {
  const continuation = continuationFor(team)
  const pending = continuation?.pending
  if (!Array.isArray(pending) || pending.length < 2) {
    const event = pending?.[0] || null
    return { changed: false, event, count: event?.coalescedCount || (event ? 1 : 0) }
  }
  const latest = pending.at(-1)
  const keys = [...new Set(pending.flatMap(event => eventKeys(event)))]
  const taskIds = [...new Set(pending.flatMap(event =>
    Array.isArray(event.coalescedTaskIds) ? event.coalescedTaskIds : [event.taskId]).filter(Boolean))]
  const count = pending.reduce((total, event) => total + Math.max(1, Number(event.coalescedCount) || 1), 0)
  latest.coalescedCount = count
  latest.coalescedKeys = keys.slice(-TEAM_CONTINUATION_MAX_PENDING)
  latest.coalescedTaskIds = taskIds.slice(-TEAM_CONTINUATION_MAX_PENDING)
  latest.firstCreatedAt = pending[0].firstCreatedAt || pending[0].createdAt
  latest.updatedAt = nowIso(now)
  continuation.pending = [latest]
  return { changed: true, event: latest, count }
}

const parsedTimestamp = value => {
  if (Number.isFinite(value)) return Number(value)
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

// Codex resume can expose a working TUI yet omit both UserPromptSubmit and Stop.
// Releasing its bridge-owned coordinator fences is safe only after the exact
// authoritative process has shown a ready input surface twice, after a grace
// period, with the same immutable turn fingerprint on both observations.
export function observeIdleCodexCoordinator(session, {
  ready = false,
  previous = null,
  now = Date.now(),
  graceMs = TEAM_CONTINUATION_IDLE_GRACE_MS,
  confirmations = TEAM_CONTINUATION_IDLE_CONFIRMATIONS,
} = {}) {
  if (!ready || session?.teamActiveTaskId || (!session?.teamTurn && !session?.teamInputReservation)) {
    return { action: 'reset', observation: null }
  }
  const timestamps = [
    parsedTimestamp(session.teamTurn?.startedAt),
    parsedTimestamp(session.teamInputReservation?.acceptedAt),
    parsedTimestamp(session.codexTurnStartedAt),
  ].filter(Number.isFinite)
  if (!timestamps.length) return { action: 'blocked', observation: null }
  const latestAt = Math.max(...timestamps)
  const fingerprint = [
    session.id || '', session.pid || '', session.tmux || '',
    session.teamTurn?.startedAt || '', session.teamInputReservation?.acceptedAt || '',
    session.codexTurnStartedAt || '',
  ].join('|')
  if (now - latestAt < Math.max(0, Number(graceMs) || 0)) {
    return { action: 'wait', observation: { fingerprint, count: 0, latestAt } }
  }
  const count = previous?.fingerprint === fingerprint ? Number(previous.count || 0) + 1 : 1
  const observation = { fingerprint, count, latestAt }
  return count >= Math.max(1, Number(confirmations) || 1)
    ? { action: 'release', observation }
    : { action: 'confirm', observation }
}

export function noteContinuationWaiting(team, reason, {
  now = Date.now(), noticeAfterMs = TEAM_CONTINUATION_WAIT_NOTICE_MS,
} = {}) {
  const continuation = continuationFor(team, { create: true })
  const normalized = String(reason || 'coordinator busy').slice(0, 300)
  if (!continuation.waiting || continuation.waiting.reason !== normalized) {
    continuation.waiting = { reason: normalized, since: nowIso(now), notifiedAt: null }
    return { changed: true, notify: false, waiting: continuation.waiting }
  }
  const since = parsedTimestamp(continuation.waiting.since)
  if (!continuation.waiting.notifiedAt && since !== null && now - since >= Math.max(0, Number(noticeAfterMs) || 0)) {
    continuation.waiting.notifiedAt = nowIso(now)
    return { changed: true, notify: true, waiting: continuation.waiting }
  }
  return { changed: false, notify: false, waiting: continuation.waiting }
}

export function clearContinuationWaiting(team) {
  const continuation = continuationFor(team)
  if (!continuation || !Object.hasOwn(continuation, 'waiting')) return false
  delete continuation.waiting
  return true
}

export function claimContinuation(team, { now = Date.now() } = {}) {
  const continuation = continuationFor(team)
  if (!continuation || continuation.mode !== 'auto-until-blocked' || continuation.active || !continuation.pending.length) return null
  const event = continuation.pending.shift()
  event.status = 'running'
  event.claimedAt = nowIso(now)
  event.updatedAt = event.claimedAt
  continuation.active = event
  return event
}

export function settleContinuation(team, eventId, { status = 'succeeded', error = null, now = Date.now() } = {}) {
  const continuation = continuationFor(team)
  if (!continuation?.active || continuation.active.id !== eventId) return null
  continuation.active.status = status
  continuation.active.error = error ? String(error).slice(0, 1000) : null
  continuation.active.updatedAt = nowIso(now)
  const event = continuation.active
  continuation.active = null
  return event
}

export function deferContinuation(team, eventId, { now = Date.now() } = {}) {
  const continuation = continuationFor(team)
  if (!continuation?.active || continuation.active.id !== eventId) return null
  const event = continuation.active
  event.status = 'queued'
  event.updatedAt = nowIso(now)
  continuation.active = null
  continuation.pending.unshift(event)
  return event
}
