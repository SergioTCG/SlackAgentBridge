import { z } from 'zod'
import { accountEditSchema } from './account-management.mjs'

const channel = z.string().regex(/^[CG][A-Z0-9]{1,32}$/)
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
const switchSchema = z.object({ channel, session: identifier, account: z.string().min(1).max(254), requestId: identifier }).strict()
const refreshSchema = z.object({ account: identifier }).strict()
const reconcileSchema = z.object({ channel, session: identifier, requestId: identifier }).strict()
const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
const error = (status, code) => { throw Object.assign(new Error(code), { status }) }
const publicErrors = new Set(['account_outside_group', 'account_channel_forbidden', 'provider_mismatch', 'unknown_account', 'ambiguous_account',
  'stale_account_session', 'account_switch_blocked', 'account_pool_read_only', 'account_switch_in_progress', 'account_request_conflict',
  'account_handover_uncertain', 'registry_not_staged', 'invalid_pool_state', 'account_receipt_history_full'])
for (const code of ['revision_conflict', 'request_id_conflict', 'account_in_use', 'account_is_preferred', 'account_draining',
  'group_is_routed', 'unknown_group', 'channel_account_incompatible', 'account_outside_group', 'account_pool_operation_in_progress',
  'invalid_enrollment', 'credential_provider_mismatch', 'duplicate_account_identity', 'invalid_account_edit']) publicErrors.add(code)
for (const code of ['account_handover_rejected', 'account_identity_unverified']) publicErrors.add(code)

export async function handleAccountPoolHttp(req, res, url, runtime, state) {
  if (!url.pathname.startsWith('/account-pools/') || !runtime.enabled) return false
  try {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || '') || req.headers.origin || req.headers['sec-fetch-site']) error(403, 'script_loopback_required')
    if (url.pathname === '/account-pools/status' && req.method === 'GET') {
      const id = channel.safeParse(url.searchParams.get('channel'))
      if (!id.success || [...url.searchParams.keys()].some(key => key !== 'channel')) error(400, 'invalid_account_request')
      send(res, 200, runtime.status(id.data)); return true
    }
    if (url.pathname === '/account-pools/inventory' && req.method === 'GET') {
      if (url.search) error(400, 'invalid_account_request')
      send(res, 200, runtime.inventory()); return true
    }
    if (!['/account-pools/refresh', '/account-pools/switch', '/account-pools/manage', '/account-pools/reconcile'].includes(url.pathname)) error(404, 'unknown_account_endpoint')
    if (req.method !== 'POST') error(405, 'method_not_allowed')
    if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') error(415, 'json_required')
    const chunks = []; let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > 8192) error(413, 'account_request_too_large')
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { error(400, 'invalid_account_request') }
    if (url.pathname === '/account-pools/manage') {
      const parsed = accountEditSchema.safeParse(body)
      if (!parsed.success) error(400, 'invalid_account_edit')
      send(res, 200, runtime.manage(parsed.data)); return true
    }
    if (url.pathname === '/account-pools/refresh') {
      const parsed = refreshSchema.safeParse(body)
      if (!parsed.success) error(400, 'invalid_account_request')
      send(res, 200, { observation: await runtime.refresh(parsed.data.account) }); return true
    }
    const reconciling = url.pathname === '/account-pools/reconcile'
    const parsed = (reconciling ? reconcileSchema : switchSchema).safeParse(body)
    if (!parsed.success) error(400, 'invalid_account_request')
    const input = parsed.data, session = state.sessions?.[state.channels?.[input.channel]]
    if (!session || session.id !== input.session || session.channel !== input.channel) error(409, 'stale_account_session')
    send(res, 200, reconciling ? await runtime.reconcile(session, { expectedSessionId: input.session, requestId: input.requestId })
      : await runtime.switchAccount(session, input.account, { expectedSessionId: input.session, requestId: input.requestId }))
  } catch (failure) {
    const fixed = failure.status ? failure.message : publicErrors.has(failure.message) ? failure.message : 'account_pool_request_failed'
    send(res, failure.status || 409, { ok: false, error: fixed })
  }
  return true
}
