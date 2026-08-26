const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function requireScriptClient(req, { json = false } = {}) {
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) throw Object.assign(new Error('terminal requests must use a loopback host'), { status: 403 })
  if (req.headers.origin || req.headers['sec-fetch-site']) throw Object.assign(new Error('browser-originated terminal requests are not allowed'), { status: 403 })
  if (json && String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('terminal POST requests require application/json'), { status: 415 })
  }
}

async function readJson(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > 8192) throw Object.assign(new Error('terminal request body is too large'), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
  catch { throw Object.assign(new Error('terminal request body is not valid JSON'), { status: 400 }) }
}

export async function handleTerminalHttp(req, res, url, terminalControl) {
  const actionMatch = /^\/terminals\/(open|close)$/.exec(url.pathname)
  if (url.pathname !== '/terminals' && !actionMatch) return false
  try {
    requireScriptClient(req, { json: Boolean(actionMatch) })
    if (url.pathname === '/terminals' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, terminals: await terminalControl.list() })
      return true
    }
    if (actionMatch && req.method === 'POST') {
      const body = await readJson(req)
      if (body.all !== undefined && typeof body.all !== 'boolean') throw Object.assign(new Error('all must be a boolean'), { status: 400 })
      if (!body.all && (typeof body.selector !== 'string' || !body.selector)) throw Object.assign(new Error('selector is required'), { status: 400 })
      const result = await terminalControl.act(actionMatch[1], { selector: body.selector, all: body.all === true })
      sendJson(res, result.failures.length ? 409 : 200, { ok: !result.failures.length, ...result })
      return true
    }
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
  } catch (error) {
    sendJson(res, error?.status || 500, { ok: false, error: String(error?.message || error) })
  }
  return true
}
