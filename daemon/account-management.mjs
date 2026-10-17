// Pure owner edits. The daemon performs the synchronous CAS publication; no
// credential material or process side effects are part of an edit.
import { z } from 'zod'
import { normalizeAccountEnrollment, publicAccountRegistry } from './account-registry.mjs'
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/)
const selector = z.string().min(1).max(254)
const named = type => z.object({ type: z.literal(type), group: selector, name: z.string().min(1).max(64) }).strict()
const member = type => z.object({ type: z.literal(type), group: selector, account: selector }).strict()
const accountOp = type => z.object({ type: z.literal(type), account: selector }).strict()
export const accountEditSchema = z.object({ requestId: key, expectedRevision: z.number().int().min(0).max(4096), operation: z.discriminatedUnion('type', [
  z.object({ type: z.literal('group-create'), key, name: z.string().min(1).max(64), members: z.array(selector).min(1).max(128) }).strict(),
  named('group-rename'), z.object({ type: z.literal('group-remove'), group: selector }).strict(),
  ...['group-add', 'group-delete-member', 'group-drain-member', 'group-prefer'].map(member),
  ...['account-drain', 'account-retire', 'account-enable'].map(accountOp),
  z.object({ type: z.literal('account-enroll'), account: z.record(z.string(), z.unknown()), group: selector }).strict(),
  z.object({ type: z.literal('account-credential'), account: selector, provider: z.enum(['claude', 'codex']), profile: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
  z.object({ type: z.literal('channel-group'), channel: z.string().regex(/^[CG][A-Z0-9]{1,32}$/), group: selector }).strict(),
] ) }).strict()
const fail = code => { throw new Error(code) }

export function editAccountRegistry(record, input, { usage = {} } = {}) {
  const parsed = accountEditSchema.safeParse(input)
  if (!parsed.success) fail('invalid_account_edit')
  const { requestId, expectedRevision, operation: op } = parsed.data
  if (record.revision !== expectedRevision) fail('revision_conflict')
  const view = publicAccountRegistry(record), spec = structuredClone(record.spec)
  spec.requestId = requestId
  const find = (items, selection, type) => {
    const matches = items.filter(a => [a.key, a.id, a.email].includes(selection))
    if (matches.length !== 1) fail(matches.length ? `ambiguous_${type}` : `unknown_${type}`)
    return matches[0]
  }
  const account = value => spec.accounts.find(a => a.key === find(view.accounts, value, 'account').key)
  const group = value => spec.groups.find(g => g.key === find(view.groups, value, 'group').key)
  const inUse = a => (usage[record.history.accounts[a.key]?.id] || []).length > 0
  const preferred = a => spec.groups.some(g => Object.values(g.preferred).includes(a.key))
  if (op.type === 'group-create') spec.groups.push({ key: op.key, name: op.name, members: op.members.map(v => account(v).key), preferred: {} })
  else if (op.type === 'account-enroll') {
    spec.accounts.push(op.account); group(op.group).members.push(op.account.key)
  } else if (op.type === 'account-credential') {
    const a = account(op.account)
    if (a.provider !== op.provider) fail('provider_mismatch')
    const oldProfile = a.credentials.find(ref => ref.kind === `${a.provider}-profile`)
    if (oldProfile && oldProfile.profile !== op.profile && inUse(a)) fail('account_in_use')
    // Keep old references for migration ownership and historical leg lookup;
    // runtime explicitly prefers the full OAuth profile after enrollment.
    a.credentials = a.credentials.filter(ref => ref.kind !== `${a.provider}-profile`)
    a.credentials.push({ kind: `${a.provider}-profile`, profile: op.profile })
  } else if (op.type.startsWith('account-')) {
    const a = account(op.account)
    if (op.type === 'account-retire' && inUse(a)) fail('account_in_use')
    if (op.type !== 'account-enable' && preferred(a)) fail('account_is_preferred')
    a.lifecycle = op.type === 'account-enable' ? 'active' : op.type === 'account-drain' ? 'draining' : 'retired'
  } else {
    const g = group(op.group)
    if (op.type === 'group-rename') g.name = op.name
    else if (op.type === 'group-remove') {
      if (spec.routing.defaultGroup === g.key || Object.values(spec.routing.channels).includes(g.key)) fail('group_is_routed')
      spec.groups = spec.groups.filter(v => v !== g)
    } else if (op.type === 'channel-group') {
      // Existing bindings must be deliberately corrected before rerouting.
      if (view.accounts.some(a => usage[a.id]?.includes(op.channel) &&
          (!g.members.includes(a.key) || a.allowedChannels && !a.allowedChannels.includes(op.channel)))) fail('channel_account_incompatible')
      spec.routing.channels[op.channel] = g.key
    } else {
      const a = account(op.account)
      if (op.type === 'group-add') {
        if (!g.members.includes(a.key)) g.members.push(a.key)
        g.drainingMembers = g.drainingMembers.filter(k => k !== a.key)
      } else {
        if (!g.members.includes(a.key)) fail('account_outside_group')
        if (op.type === 'group-prefer') {
          if (a.lifecycle !== 'active' || g.drainingMembers.includes(a.key)) fail('account_draining')
          g.preferred[a.provider] = a.key
        } else {
          if (Object.values(g.preferred).includes(a.key)) fail('account_is_preferred')
          if (op.type === 'group-drain-member') {
            if (!g.drainingMembers.includes(a.key)) g.drainingMembers.push(a.key)
          } else {
            if (inUse(a)) fail('account_in_use')
            g.members = g.members.filter(k => k !== a.key)
            g.drainingMembers = g.drainingMembers.filter(k => k !== a.key)
          }
        }
      }
    }
  }
  return normalizeAccountEnrollment(spec)
}
