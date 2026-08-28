import { NodeManagementError } from './node-management.mjs'

const MAX_REQUEST_BODY = 16 * 1024
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function requestError(code, message, status) {
  return new NodeManagementError(code, message, status)
}

function requireScriptClient(req, { json = false } = {}) {
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) {
    throw requestError('invalid_host', 'node requests must use a loopback host', 403)
  }
  if (req.headers.origin || req.headers['sec-fetch-site']) {
    throw requestError('browser_request_rejected', 'browser-originated node requests are not allowed', 403)
  }
  if (json && String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw requestError('unsupported_media_type', 'node POST requests require application/json', 415)
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
  if (tooLarge) throw requestError('request_too_large', 'node request body is too large', 413)
  try { return JSON.parse(Buffer.concat(chunks, length).toString('utf8') || '{}') }
  catch { throw requestError('invalid_json', 'node request body is not valid JSON', 400) }
}

function decodedNodeId(value) {
  try { return decodeURIComponent(value) }
  catch { throw requestError('invalid_node_id', 'node ID path encoding is invalid', 400) }
}

export async function handleNodeHttp(req, res, url, getManagement) {
  const revokeMatch = /^\/nodes\/([^/]+)\/revoke$/.exec(url.pathname)
  const isRoute = url.pathname === '/nodes' || url.pathname === '/nodes/invitations' || Boolean(revokeMatch)
  if (!isRoute) return false
  try {
    const mutation = req.method === 'POST'
    requireScriptClient(req, { json: mutation })
    const management = getManagement()
    if (url.pathname === '/nodes' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...management.status() })
      return true
    }
    if (url.pathname === '/nodes/invitations' && req.method === 'POST') {
      const invitation = await management.issueInvitation(await readJson(req))
      sendJson(res, 201, { ok: true, invitation })
      return true
    }
    if (revokeMatch && req.method === 'POST') {
      const body = await readJson(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
        throw requestError('invalid_revoke', 'node revoke body must be an empty JSON object', 400)
      }
      const result = await management.revoke(decodedNodeId(revokeMatch[1]))
      sendJson(res, 200, { ok: true, ...result })
      return true
    }
    sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'method not allowed' })
  } catch (error) {
    const expected = error instanceof NodeManagementError
    sendJson(res, expected ? error.status : 500, {
      ok: false,
      code: expected ? error.code : 'node_management_failed',
      error: expected ? error.message : 'node management request failed',
    })
  }
  return true
}
