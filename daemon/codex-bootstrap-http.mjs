import { codexAutomationBootstrapFromAppServerMessage } from './codex-commentary.mjs'

const MAX_BOOTSTRAP_BODY_BYTES = 16 << 10

async function readBootstrap(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_BOOTSTRAP_BODY_BYTES) throw Object.assign(new Error('bootstrap is too large'), { status: 413 })
    chunks.push(chunk)
  }
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('invalid bootstrap'), { status: 400 }) }
  const bootstrap = codexAutomationBootstrapFromAppServerMessage({
    method: 'thread/started',
    params: { thread: {
      id: parsed.threadId,
      parentThreadId: null,
      cwd: parsed.cwd,
      model: parsed.model,
      reasoningEffort: parsed.effort,
    } },
  })
  if (!bootstrap) throw Object.assign(new Error('invalid bootstrap'), { status: 400 })
  return bootstrap
}

export async function handleCodexBootstrapHttp(req, res, url, {
  lifecycle,
  resolveAgentPid,
  codexAppServerProcessPid,
  validProviderRootClaim,
  acceptHook,
  execFile,
  log = () => {},
}) {
  if (url.pathname !== '/codex/bootstrap') return false
  if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return true }
  if (req.headers['x-ccs-provider'] !== 'codex' ||
      String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(403); res.end('forbidden'); return true
  }
  try {
    const bootstrap = await readBootstrap(req)
    const tmux = url.searchParams.get('tmux') || ''
    const disposition = await lifecycle.acceptCodexBootstrap(bootstrap, tmux, async record => {
      const reportedPid = await resolveAgentPid(url.searchParams.get('ppid'), 'codex')
      const pid = await codexAppServerProcessPid(reportedPid, { execFile })
      if (!(pid && await validProviderRootClaim(pid, tmux, 'codex'))) {
        throw Object.assign(new Error('identity mismatch'), { status: 403 })
      }
      await acceptHook({
        hook_event_name: 'SessionStart',
        session_id: bootstrap.threadId,
        cwd: bootstrap.cwd,
        model: bootstrap.model,
        effort: bootstrap.effort,
        source: 'automation-app-server',
      }, pid, tmux, record.flags.join(' '), null, 'codex')
    })
    if (disposition === 'ignore') { res.writeHead(204); res.end(); return true }
    if (disposition === 'forbidden') { res.writeHead(403); res.end('identity mismatch'); return true }
    if (disposition === 'not_ready') { res.writeHead(409); res.end('automation correlation not ready'); return true }
    res.writeHead(disposition === 'accepted' ? 202 : 200)
    res.end(disposition)
  } catch (error) {
    log('Codex automation bootstrap failed', String(error?.message || error))
    res.writeHead(error?.status || 503)
    res.end(error?.status === 403 ? 'identity mismatch' : error?.status === 400 ? 'invalid bootstrap' : 'bootstrap unavailable')
  }
  return true
}
