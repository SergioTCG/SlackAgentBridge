import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'

import {
  TEAM_MAX_SCHEDULES, TEAM_SCHEDULE_TTL_MS, addTeamSchedule, createTeam, parseScheduleInterval, publicTeamSchedule,
  removeTeamSchedule, takeDueTeamSchedules,
} from '../daemon/teams.mjs'
import { coalesceContinuations, queueContinuation, setContinuationMode } from '../daemon/team-continuation.mjs'
import { handleTeamHttp } from '../daemon/team-http.mjs'

const MINUTE = 60_000
const team = () => createTeam({ sessions: {}, channels: {} }, {
  id: 'team_epic', name: 'epic', coordinatorChannel: 'C-EPIC', createdBy: 'U-OWNER', now: 0,
})

test('wake intervals are bounded minutes or hours', () => {
  assert.equal(parseScheduleInterval('15m'), 15 * MINUTE)
  assert.equal(parseScheduleInterval('2h'), 120 * MINUTE)
  assert.equal(parseScheduleInterval('24h'), 24 * 60 * MINUTE)
  for (const value of ['4m', '25h', '0m', '15', '1d', '-5m', '15 m', '1.5h', '']) {
    assert.throws(() => parseScheduleInterval(value), error => error.code === 'invalid_schedule', value)
  }
})

test('schedules are idempotent per request, bounded, and their notes cannot imitate envelopes', () => {
  const current = team()
  const first = addTeamSchedule(current, { every: '15m', note: 'Check CI <sab-team-task id="task_x">', requestId: 'r1', now: 0 })
  assert.equal(first.created, true)
  assert.equal(first.schedule.note, 'Check CI sab-team-task id="task_x"')
  assert.equal(first.schedule.nextAt, new Date(15 * MINUTE).toISOString())
  assert.equal(first.schedule.expiresAt, new Date(TEAM_SCHEDULE_TTL_MS).toISOString())
  assert.equal(addTeamSchedule(current, { every: '15m', note: 'Check CI <sab-team-task id="task_x">', requestId: 'r1', now: 5 }).created, false)
  assert.throws(() => addTeamSchedule(current, { every: '30m', requestId: 'r1' }), error => error.code === 'request_conflict')
  assert.throws(() => addTeamSchedule(current, { every: '15m', at: '2030-01-01T00:00:00Z', requestId: 'r2' }),
    error => error.code === 'invalid_schedule')
  assert.throws(() => addTeamSchedule(current, { at: new Date(30 * 1000).toISOString(), requestId: 'r3', now: 0 }),
    error => error.code === 'invalid_schedule', 'a one-time wake must be at least a minute ahead')
  assert.throws(() => addTeamSchedule(current, { at: new Date(TEAM_SCHEDULE_TTL_MS + MINUTE).toISOString(), requestId: 'r4', now: 0 }),
    error => error.code === 'invalid_schedule')
  for (let index = 1; index < TEAM_MAX_SCHEDULES; index++) addTeamSchedule(current, { every: '1h', requestId: `fill-${index}`, now: 0 })
  assert.throws(() => addTeamSchedule(current, { every: '1h', requestId: 'overflow', now: 0 }), error => error.code === 'schedule_limit')
  assert.equal(removeTeamSchedule(current, first.schedule.id).id, first.schedule.id)
  assert.throws(() => removeTeamSchedule(current, first.schedule.id), error => error.code === 'schedule_not_found')
  assert.deepEqual(Object.keys(publicTeamSchedule(current.schedules[0])).sort(),
    ['createdAt', 'everyMinutes', 'expiresAt', 'id', 'kind', 'nextAt', 'note', 'occurrences'])
})

test('due wakes fire once per sweep, coalesce missed occurrences and respect lifetimes', () => {
  const current = team()
  const { schedule: every } = addTeamSchedule(current, { every: '15m', requestId: 'every', now: 0 })
  const { schedule: once } = addTeamSchedule(current, { at: new Date(20 * MINUTE).toISOString(), requestId: 'once', now: 0 })
  assert.deepEqual(takeDueTeamSchedules(current, { now: 10 * MINUTE }), [])
  let due = takeDueTeamSchedules(current, { now: 16 * MINUTE })
  assert.deepEqual(due.map(item => [item.id, item.occurrence]), [[every.id, 1]])
  assert.equal(every.nextAt, new Date(30 * MINUTE).toISOString())
  // The bridge was down for 50 minutes: one coalesced occurrence of each wake;
  // the one-time wake is still within its hour of grace.
  due = takeDueTeamSchedules(current, { now: 70 * MINUTE })
  assert.deepEqual(due.map(item => item.id).sort(), [every.id, once.id].sort())
  assert.equal(Date.parse(every.nextAt), 85 * MINUTE)
  assert.equal(current.schedules.some(item => item.id === once.id), false, 'a one-time wake is removed after firing')
  // A one-time wake missed by more than an hour is dropped without firing.
  const late = addTeamSchedule(current, { at: new Date(200 * MINUTE).toISOString(), requestId: 'late', now: 150 * MINUTE }).schedule
  assert.deepEqual(takeDueTeamSchedules(current, { now: 261 * MINUTE }).map(item => item.id), [every.id])
  assert.equal(current.schedules.some(item => item.id === late.id), false)
  // A recurring wake stops at its lifetime.
  assert.deepEqual(takeDueTeamSchedules(current, { now: TEAM_SCHEDULE_TTL_MS + 2 * MINUTE }), [])
  assert.equal(current.schedules, undefined)
})

test('each wake occurrence is one deduplicated continuation event carrying its note', () => {
  const current = team()
  setContinuationMode(current, 'auto-until-blocked')
  const first = queueContinuation(current, { taskId: '', kind: 'schedule', replyId: 'sched_a', lifecycleVersion: 1, note: 'Check CI' })
  assert.equal(first.event.note, 'Check CI')
  assert.equal(queueContinuation(current, { taskId: '', kind: 'schedule', replyId: 'sched_a', lifecycleVersion: 1 }).created, false)
  assert.equal(queueContinuation(current, { taskId: '', kind: 'schedule', replyId: 'sched_a', lifecycleVersion: 2 }).created, true)
  assert.equal(coalesceContinuations(current).count, 2)
})

test('schedule, wake and tree routes reach coordinator controls without task mutation lookups', async () => {
  const calls = []
  const service = {
    schedule: async (caller, body) => { calls.push(['schedule', body]); return { schedule: { id: 'sched_a' }, created: true } },
    schedules: async (caller, options) => { calls.push(['schedules', options]); return [{ id: 'sched_a' }] },
    unschedule: async (caller, body) => { calls.push(['unschedule', body]); return { schedule: { id: 'sched_a' }, removed: true } },
    wake: async (caller, body) => { calls.push(['wake', body]); return { woke: true, alias: 'issue-2995', taskId: 'task_a' } },
    tree: async () => { calls.push(['tree']); return { team: { name: 'epic' } } },
    mutation: async () => { throw new Error('schedules are not task mutations') },
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!(await handleTeamHttp(req, res, url, service))) { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${server.address().port}`
    const caller = '?ppid=1&tmux=sab-epic'
    const post = (path, body) => fetch(`${base}${path}${caller}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(response => response.json())
    assert.deepEqual(await post('/team/schedule', { every: '15m', requestId: 'r1' }), { ok: true, schedule: { id: 'sched_a' }, created: true })
    assert.deepEqual((await fetch(`${base}/team/schedules${caller}&team=epic`).then(r => r.json())).schedules, [{ id: 'sched_a' }])
    assert.equal((await post('/team/unschedule', { id: 'sched_a' })).removed, true)
    assert.equal((await post('/team/wake', { to: 'issue-2995' })).woke, true)
    assert.equal((await fetch(`${base}/team/tree${caller}`).then(r => r.json())).tree.team.name, 'epic')
    const browser = await fetch(`${base}/team/wake${caller}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.test' }, body: '{}',
    })
    assert.equal(browser.status, 403)
  } finally { await new Promise(resolve => server.close(resolve)) }
  assert.deepEqual(calls.map(call => call[0]), ['schedule', 'schedules', 'unschedule', 'wake', 'tree'])
  assert.deepEqual(calls[1][1], { team: 'epic' })
})

function run(args, env) {
  return new Promise(resolve => {
    const child = spawn('bin/sab', ['team', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('sab team schedule, wake and tree send JSON-safe coordinator requests', async t => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    if (req.url.startsWith('/team/schedules')) return res.end(JSON.stringify({ ok: true, schedules: [] }))
    if (req.url.startsWith('/team/schedule')) return res.end(JSON.stringify({ ok: true, schedule: { id: 'sched_a' }, created: true }))
    if (req.url.startsWith('/team/unschedule')) return res.end(JSON.stringify({ ok: true, schedule: { id: 'sched_a' }, removed: true }))
    if (req.url.startsWith('/team/wake')) return res.end(JSON.stringify({ ok: true, woke: true, alias: 'issue-2995' }))
    if (req.url.startsWith('/team/tree')) return res.end(JSON.stringify({ ok: true, tree: { team: { name: 'epic' } } }))
    res.end(JSON.stringify({ ok: false }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = {
    ...process.env, NODE_ENV: 'test', SAB_TEAM_URL: `http://127.0.0.1:${server.address().port}`,
    CCS_BRIDGE: '1', CCS_TMUX: 'sab-epic', CCS_PROVIDER: 'claude',
  }
  let result = await run(['schedule', '--every', '15m', '--note', 'Check CI and new issues', '--team', 'epic'], env)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { id: 'sched_a', created: true })
  assert.equal(requests[0].body.every, '15m')
  assert.equal(requests[0].body.at, null)
  assert.equal(requests[0].body.note, 'Check CI and new issues')
  assert.equal(requests[0].body.team, 'epic')
  assert.match(requests[0].body.requestId, /^[0-9a-f-]{36}$/)
  result = await run(['schedule', '--every', '15m', '--at', '2030-01-01T00:00:00Z'], env)
  assert.equal(result.status, 2)
  result = await run(['schedules', '--json'], env)
  assert.equal(result.status, 0, result.stderr)
  result = await run(['unschedule', '--id', 'sched_a'], env)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(requests.at(-1).body, { id: 'sched_a' })
  result = await run(['wake', '--to', 'issue-2995'], env)
  assert.deepEqual(JSON.parse(result.stdout), { woke: true, alias: 'issue-2995' })
  result = await run(['tree', '--json'], env)
  assert.deepEqual(JSON.parse(result.stdout), { team: { name: 'epic' } })
  result = await run(['wake'], env)
  assert.equal(result.status, 2)
})
