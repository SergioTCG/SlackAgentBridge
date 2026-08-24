import { AutomationRequestError } from './automation.mjs'

const MAX_REQUEST_BODY = 320 * 1024

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  let raw = ''
  let tooLarge = false
  for await (const chunk of req) {
    if (tooLarge) continue // drain the socket so keep-alive clients are not reset
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_REQUEST_BODY) { raw = ''; tooLarge = true }
  }
  if (tooLarge) throw new AutomationRequestError('request_too_large', 'automation request body is too large', 413)
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
      const { automation, created } = lifecycle.create(await readJson(req))
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
    const externalKey = decodedKey(match[1])
    if (!match[2] && req.method === 'GET') {
      const status = lifecycle.status(externalKey)
      if (!status) sendJson(res, 404, { ok: false, code: 'automation_not_found', error: 'automation not found' })
      else sendJson(res, 200, { ok: true, ...status })
      return true
    }
    if (match[2] && req.method === 'POST') {
      const body = await readJson(req)
      if (body.archive !== undefined && typeof body.archive !== 'boolean') {
        throw new AutomationRequestError('invalid_archive', 'archive must be a boolean')
      }
      const status = await lifecycle.stop(externalKey, { archive: body.archive === true })
      if (!status) sendJson(res, 404, { ok: false, code: 'automation_not_found', error: 'automation not found' })
      else sendJson(res, 200, { ok: true, ...status })
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
