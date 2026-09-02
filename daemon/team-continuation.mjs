import crypto from 'node:crypto'

// Continuations are deliberately opt-in. Existing teams without this record
// remain manual, preserving the owner-turn safety boundary.
export const TEAM_CONTINUATION_MODES = new Set(['manual', 'auto-until-blocked'])
export const TEAM_CONTINUATION_MAX_PENDING = 64

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
  return continuation
}

export function queueContinuation(team, { taskId, kind = 'completed', replyId = null, now = Date.now() } = {}) {
  const continuation = continuationFor(team, { create: true })
  if (continuation.mode !== 'auto-until-blocked') return { created: false, event: null }
  const key = `${String(taskId || '')}:${String(kind || 'completed')}:${String(replyId || '')}`
  const existing = continuation.pending.find(event => event.key === key) ||
    (continuation.active?.key === key ? continuation.active : null)
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
