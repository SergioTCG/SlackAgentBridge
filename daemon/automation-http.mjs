import { AutomationRequestError } from './automation.mjs'

const MAX_REQUEST_BODY = 320 * 1024
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function requireScriptClient(req, { json = false } = {}) {
  const host = String(req.headers.host || '')
  if (!LOOPBACK_HOST.test(host)) {
    throw new AutomationRequestError('invalid_host', 'automation requests must use a loopback host', 403)
  }
  // Binding to 127.0.0.1 does not stop a hostile webpage from submitting a
  // no-CORS request (or using DNS rebinding). Script clients have neither
  // browser fetch metadata nor an Origin header; reject both before mutation.
  if (req.headers.origin || req.headers['sec-fetch-site']) {
    throw new AutomationRequestError('browser_request_rejected', 'browser-originated automation requests are not allowed', 403)
  }
  if (json && String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AutomationRequestError('unsupported_media_type', 'automation POST requests require application/json', 415)
  }
}

export async function readAutomationJson(req) {
  const chunks = []
  let length = 0
  let tooLarge = false
  for await (const chunk of req) {
    if (tooLarge) continue // drain the socket so keep-alive clients are not reset
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_REQUEST_BODY) { chunks.length = 0; tooLarge = true; continue }
    chunks.push(buffer)
  }
  if (tooLarge) throw new AutomationRequestError('request_too_large', 'automation request body is too large', 413)
  const raw = Buffer.concat(chunks, length).toString('utf8')
  try { return JSON.parse(raw || '{}') }
  catch { throw new AutomationRequestError('invalid_json', 'request body is not valid JSON') }
}

function decodedKey(segment) {
  try { return decodeURIComponent(segment) }
  catch { throw new AutomationRequestError('invalid_external_key', 'externalKey path encoding is invalid') }
}

export async function handleAutomationHttp(req, res, url, lifecycle) {
  if (url.pathname === '/automation/sessions' && req.method === 'POST') {
    try {
      requireScriptClient(req, { json: true })
      const { automation, created } = lifecycle.create(await readAutomationJson(req))
      sendJson(res, 202, {
        ok: true,
        created,
        externalKey: automation.externalKey,
        tmux: automation.tmux,
        status: automation.status,
      })
    } catch (error) {
      const status = error instanceof AutomationRequestError ? error.status : 500
      sendJson(res, status, {
        ok: false,
        code: error?.code || 'automation_create_failed',
        error: error instanceof AutomationRequestError ? error.message : 'automation creation failed',
      })
    }
    return true
  }

  const match = /^\/automation\/sessions\/([^/]+?)(\/stop)?$/.exec(url.pathname)
  if (!match) return false
  try {
    requireScriptClient(req, { json: req.method === 'POST' })
    const externalKey = decodedKey(match[1])
    if (!match[2] && req.method === 'GET') {
      const status = lifecycle.status(externalKey)
      if (!status) sendJson(res, 404, { ok: false, code: 'automation_not_found', error: 'automation not found' })
      else sendJson(res, 200, { ok: true, ...status })
      return true
    }
    if (match[2] && req.method === 'POST') {
      const body = await readAutomationJson(req)
      if (body.archive !== undefined && typeof body.archive !== 'boolean') {
        throw new AutomationRequestError('invalid_archive', 'archive must be a boolean')
      }
      const status = await lifecycle.stop(externalKey, { archive: body.archive === true })
      if (!status) sendJson(res, 404, { ok: false, code: 'automation_not_found', error: 'automation not found' })
      else if (status.status !== 'stopped') {
        sendJson(res, 409, {
          ok: false,
          ...status,
          code: status.failure?.code || 'automation_stop_incomplete',
          error: status.failure?.message || 'automation stop did not complete',
        })
      } else sendJson(res, 200, { ok: true, ...status })
      return true
    }
  } catch (error) {
    const status = error instanceof AutomationRequestError ? error.status : 500
    sendJson(res, status, {
      ok: false,
      code: error?.code || 'automation_request_failed',
      error: error instanceof AutomationRequestError ? error.message : 'automation request failed',
    })
    return true
  }
  sendJson(res, 405, { ok: false, code: 'method_not_allowed', error: 'method not allowed' })
  return true
}
