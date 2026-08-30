import { TeamError } from './teams.mjs'

const MAX_REQUEST_BODY = 256 * 1024
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function requireScriptClient(req, { json = false } = {}) {
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) {
    throw new TeamError('invalid_host', 'team requests must use a loopback host', 403)
  }
  if (req.headers.origin || req.headers['sec-fetch-site']) {
    throw new TeamError('browser_request_rejected', 'browser-originated team requests are not allowed', 403)
  }
  if (json && String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new TeamError('unsupported_media_type', 'team POST requests require application/json', 415)
  }
}

async function readJson(req) {
  const chunks = []
  let length = 0
  let tooLarge = false
  for await (const chunk of req) {
    if (tooLarge) continue
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_REQUEST_BODY) { chunks.length = 0; tooLarge = true; continue }
    chunks.push(buffer)
  }
  if (tooLarge) throw new TeamError('request_too_large', 'team request body is too large', 413)
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8') || '{}') }
  catch { throw new TeamError('invalid_json', 'team request body is not valid JSON') }
}

function callerRequest(req, url) {
  return {
    ppid: url.searchParams.get('ppid'),
    tmux: url.searchParams.get('tmux'),
    provider: req.headers['x-ccs-provider'] || 'claude',
  }
}

function decoded(segment) {
  try { return decodeURIComponent(segment) }
  catch { throw new TeamError('invalid_task_id', 'task path encoding is invalid') }
}

export async function handleTeamHttp(req, res, url, service) {
  const taskMatch = /^\/team\/tasks\/([^/]+)$/.exec(url.pathname)
  const known = ['/team/context', '/team/peers', '/team/inbox', '/team/send', '/team/reply'].includes(url.pathname) || taskMatch
  if (!known) return false
  try {
    const mutation = req.method === 'POST'
    requireScriptClient(req, { json: mutation })
    const caller = callerRequest(req, url)
    if (url.pathname === '/team/context' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, context: await service.context(caller) })
      return true
    }
    if (url.pathname === '/team/peers' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, peers: await service.peers(caller) })
      return true
    }
    if (url.pathname === '/team/inbox' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, tasks: await service.inbox(caller, {
        limit: url.searchParams.get('limit'), after: url.searchParams.get('after'),
      }) })
      return true
    }
    if (taskMatch && req.method === 'GET') {
      sendJson(res, 200, { ok: true, task: await service.task(caller, decoded(taskMatch[1])) })
      return true
    }
    if (url.pathname === '/team/send' && req.method === 'POST') {
      sendJson(res, 202, { ok: true, ...(await service.send(caller, await readJson(req))) })
      return true
    }
    if (url.pathname === '/team/reply' && req.method === 'POST') {
      sendJson(res, 200, { ok: true, ...(await service.reply(caller, await readJson(req))) })
      return true
    }
    sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'method not allowed' })
  } catch (error) {
    const expected = error instanceof TeamError
    sendJson(res, expected ? error.status : 500, {
      ok: false,
      code: error?.code || 'team_request_failed',
      error: expected ? error.message : 'team request failed',
    })
  }
  return true
}
