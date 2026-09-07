import { codexFinalDisposition, codexFinalFromAppServerMessage } from './codex-commentary.mjs'

const MAX_FINAL_BODY_BYTES = 2 << 20

async function readFinal(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    if (length > MAX_FINAL_BODY_BYTES) throw Object.assign(new Error('final is too large'), { status: 413 })
    chunks.push(chunk)
  }
  let parsed
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Object.assign(new Error('invalid final'), { status: 400 }) }
  const final = codexFinalFromAppServerMessage({
    method: 'turn/completed',
    params: {
      threadId: parsed.threadId,
      turn: {
        id: parsed.turnId,
        status: 'completed',
        items: [{
          id: parsed.itemId,
          type: 'agentMessage',
          phase: 'final_answer',
          text: parsed.text,
        }],
      },
    },
  })
  if (!final) throw Object.assign(new Error('invalid final'), { status: 400 })
  return final
}

export async function handleCodexFinalHttp(req, res, url, {
  state,
  execFile,
  internalTurns,
  resolveAgentPid,
  codexAppServerProcessPid,
  validTmuxClaim,
  transitionForTarget,
  completePrivateTurn,
  finalizeCodexTurn,
  isNoSpaceError = () => false,
  log = () => {},
}) {
  if (url.pathname !== '/codex/final') return false
  if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return true }
  if (req.headers['x-ccs-provider'] !== 'codex' ||
      String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(403); res.end('forbidden'); return true
  }
  try {
    const final = await readFinal(req)
    const reportedPid = await resolveAgentPid(url.searchParams.get('ppid'), 'codex')
    const pid = await codexAppServerProcessPid(reportedPid, { execFile })
    const tmux = url.searchParams.get('tmux') || ''
    const session = state.sessions[final.threadId]
    const targetClaim = transitionForTarget(state, 'codex', tmux)
    const disposition = codexFinalDisposition({
      session,
      final,
      pid,
      tmux,
      tmuxClaimValid: session ? await validTmuxClaim(pid, tmux) : false,
      activeSessionId: session?.channel ? state.channels[session.channel] : null,
      privateTurn: internalTurns.has(final.threadId),
      targetClaim: Boolean(targetClaim),
    })
    if (disposition === 'ignore') { res.writeHead(200); res.end('duplicate'); return true }
    if (disposition === 'not_ready') { res.writeHead(409); res.end('session or channel not ready'); return true }
    if (disposition === 'forbidden') { res.writeHead(403); res.end('identity mismatch'); return true }
    if (disposition === 'private') {
      const completed = await completePrivateTurn(session, {
        turn_id: final.turnId,
        last_assistant_message: final.text,
      }, targetClaim)
      res.writeHead(completed ? 202 : 200)
      res.end(completed ? 'accepted' : 'private turn already complete')
      return true
    }
    const delivered = await finalizeCodexTurn(session, {
      turn_id: final.turnId,
      last_assistant_message: final.text,
    })
    res.writeHead(delivered ? 202 : 200)
    res.end(delivered ? 'accepted' : 'duplicate')
  } catch (error) {
    log('Codex final delivery failed', String(error?.message || error))
    const status = error?.status || 503
    res.writeHead(status)
    res.end(status === 503 && isNoSpaceError(error) ? 'state persistence unavailable' :
      status === 503 ? 'final delivery unavailable' : String(error?.message || error))
  }
  return true
}
