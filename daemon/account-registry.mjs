// Owner-confirmed account/group metadata and pure policy checks. No credential
// acquisition, native launch, Slack I/O, or lifecycle mutation belongs here.
import crypto from 'node:crypto'
import { z } from 'zod'
import { buildAccountMigrationPreview } from './account-discovery.mjs'
import { channelNodeId, nodeIdForSession, LOCAL_NODE_ID } from './nodes.mjs'

export class AccountRegistryError extends Error {
  constructor(code) { super(code); this.name = 'AccountRegistryError'; this.code = code }
}
const fail = code => { throw new AccountRegistryError(code) }
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/)
const alias = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const channel = z.string().regex(/^[CG][A-Z0-9]{1,32}$/)
const provider = z.enum(['claude', 'codex'])
const email = z.string().trim().email().max(254)
const workspace = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).nullable().default(null)
const credential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native-default') }).strict(),
  z.object({ kind: z.literal('legacy-claude'), alias }).strict(),
  z.object({ kind: z.literal('codex-profile'), profile: alias }).strict(),
  z.object({ kind: z.literal('claude-profile'), profile: alias }).strict(),
])
const account = z.object({
  key, provider, email, workspaceId: workspace, identityConfirmed: z.literal(true),
  credentials: z.array(credential).min(1).max(32),
  allowedChannels: z.array(channel).max(4096).nullable().default(null),
  lifecycle: z.enum(['active', 'draining', 'retired']).default('active'),
}).strict()
const group = z.object({
  key, name: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/),
  members: z.array(key).min(1).max(128),
  drainingMembers: z.array(key).max(128).default([]),
  preferred: z.object({ claude: key.optional(), codex: key.optional() }).strict().default({}),
}).strict()
const enrollmentSchema = z.object({
  schemaVersion: z.literal(1), requestId: key,
  accounts: z.array(account).min(1).max(128), groups: z.array(group).min(1).max(64),
  routing: z.object({ defaultGroup: key, channels: z.record(channel, key).refine(value => Object.keys(value).length <= 4096) }).strict(),
}).strict()
const digestPattern = /^[a-f0-9]{64}$/
const accountId = z.string().regex(/^acct_[a-z0-9-]{16,64}$/)
const groupId = z.string().regex(/^group_[a-z0-9-]{16,64}$/)
const envelopeSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().min(1).max(4096),
  mode: z.literal('staged'), automaticSwitching: z.literal(false), spec: enrollmentSchema,
  history: z.object({
    accounts: z.record(key, z.object({ id: accountId, provider, email, workspaceId: workspace }).strict()),
    groups: z.record(key, groupId),
  }).strict(),
  receipts: z.array(z.object({ requestId: key, digest: z.string().regex(digestPattern), revision: z.number().int().min(1).max(4096) }).strict()).min(1).max(4096),
  sourceDigest: z.string().regex(digestPattern),
}).strict()

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
export const accountRegistryDigest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
const identityKey = value => [value.provider, value.email.toLowerCase(), value.workspaceId || ''].join('\0')
const refKey = (current, ref) => ref.kind === 'native-default' ? `${current.provider}:native-default`
  : ref.kind.endsWith('-profile') ? `${current.provider}:profile:${ref.profile}` : `claude:legacy:${ref.alias}`
const unique = values => new Set(values).size === values.length

export function normalizeAccountEnrollment(input) {
  const parsed = enrollmentSchema.safeParse(input)
  if (!parsed.success) fail('invalid_enrollment')
  const spec = parsed.data
  if (Buffer.byteLength(JSON.stringify(spec)) > (1 << 20)) fail('invalid_enrollment')
  if (!unique(spec.accounts.map(a => a.key)) || !unique(spec.groups.map(g => g.key)) ||
      !unique(spec.groups.map(g => g.name.toLowerCase()))) fail('duplicate_registry_key')
  if (!unique(spec.accounts.map(identityKey))) fail('duplicate_account_identity')
  const accounts = new Map(spec.accounts.map(a => [a.key, a]))
  const groups = new Map(spec.groups.map(g => [g.key, g]))
  const refs = new Set()
  for (const current of spec.accounts) {
    if (current.allowedChannels && !unique(current.allowedChannels)) fail('duplicate_channel_scope')
    for (const ref of current.credentials) {
      if (ref.kind === 'legacy-claude' && current.provider !== 'claude') fail('credential_provider_mismatch')
      if (ref.kind === 'codex-profile' && current.provider !== 'codex') fail('credential_provider_mismatch')
      if (ref.kind === 'claude-profile' && current.provider !== 'claude') fail('credential_provider_mismatch')
      const name = refKey(current, ref)
      if (refs.has(name)) fail('duplicate_credential_reference')
      refs.add(name)
    }
    current.credentials.sort((a, b) => refKey(current, a).localeCompare(refKey(current, b)))
    current.allowedChannels?.sort()
  }
  for (const current of spec.groups) {
    if (!unique(current.members)) fail('duplicate_group_member')
    if (!unique(current.drainingMembers) || current.drainingMembers.some(k => !current.members.includes(k))) fail('invalid_draining_members')
    for (const member of current.members) if (!accounts.has(member)) fail('unknown_account_key')
    for (const [name, member] of Object.entries(current.preferred)) {
      if (!current.members.includes(member) || accounts.get(member)?.provider !== name) fail('invalid_group_preference')
    }
    current.members.sort()
    current.drainingMembers.sort()
  }
  if (!groups.has(spec.routing.defaultGroup) || Object.values(spec.routing.channels).some(name => !groups.has(name))) fail('unknown_group_key')
  spec.accounts.sort((a, b) => a.key.localeCompare(b.key))
  spec.groups.sort((a, b) => a.key.localeCompare(b.key))
  return canonical(spec)
}

export function validateStoredAccountRegistry(input) {
  try {
    const parsed = envelopeSchema.safeParse(input)
    if (!parsed.success) fail('invalid_registry_file')
    const value = parsed.data
    const spec = normalizeAccountEnrollment(value.spec)
    const accounts = Object.values(value.history.accounts)
    const groups = Object.values(value.history.groups)
    if (accounts.length > 256 || groups.length > 128 || !unique(accounts.map(a => a.id)) || !unique(groups) ||
        value.receipts.length !== value.revision || !unique(value.receipts.map(r => r.requestId)) ||
        value.receipts.some((r, index) => r.revision !== index + 1)) fail('invalid_registry_file')
    for (const current of spec.accounts) {
      const prior = Object.hasOwn(value.history.accounts, current.key) ? value.history.accounts[current.key] : null
      if (!prior || identityKey(prior) !== identityKey(current)) fail('invalid_registry_file')
    }
    if (spec.groups.some(current => !Object.hasOwn(value.history.groups, current.key))) fail('invalid_registry_file')
    const latest = value.receipts.at(-1)
    if (latest.requestId !== spec.requestId || latest.digest !== accountRegistryDigest(spec)) fail('invalid_registry_file')
    return { ...value, spec }
  } catch { fail('invalid_registry_file') }
}

export function compileAccountRegistry(input, { legacyAccounts = '', prior = null,
  acceptSourceChange = false,
  idFactory = kind => `${kind}_${crypto.randomUUID()}`,
} = {}) {
  const spec = normalizeAccountEnrollment(input)
  if (prior) prior = validateStoredAccountRegistry(prior)
  const sourceDigest = accountRegistryDigest(legacyAccounts)
  if (prior && prior.sourceDigest !== sourceDigest && (!acceptSourceChange || prior.receipts.some(r => r.requestId === spec.requestId))) fail('legacy_credentials_changed')
  const receipt = prior?.receipts.find(r => r.requestId === spec.requestId)
  if (receipt) {
    if (receipt.digest !== accountRegistryDigest(spec)) fail('request_id_conflict')
    // Re-running a read-only plan for an already-staged request must not
    // manufacture a new revision or resurrect an older policy.
    return prior
  }
  const source = buildAccountMigrationPreview({ provider: 'claude', legacyAccounts })
  if (source.issues.some(issue => issue.severity === 'blocking' && issue.code !== 'identity-verification-required')) fail('invalid_legacy_registry')
  const aliasClasses = new Map(source.accounts.filter(a => a.kind === 'legacy-named')
    .flatMap(a => a.aliases.map(name => [name, a.id])))
  const owners = new Map(), covered = new Set()
  for (const current of spec.accounts) for (const ref of current.credentials) {
    if (ref.kind !== 'legacy-claude') continue
    const sourceId = aliasClasses.get(ref.alias)
    if (!sourceId) fail('unknown_legacy_alias')
    if (owners.has(sourceId) && owners.get(sourceId) !== current.key) fail('duplicate_credential_ownership')
    owners.set(sourceId, current.key)
    covered.add(ref.alias)
  }
  if ([...aliasClasses.keys()].some(name => !covered.has(name))) fail('unmapped_legacy_alias')
  const history = structuredClone(prior?.history || { accounts: {}, groups: {} })
  for (const current of spec.accounts) {
    const previous = Object.hasOwn(history.accounts, current.key) ? history.accounts[current.key] : null
    if (previous && identityKey(previous) !== identityKey(current)) fail('identity_key_reuse')
    if (!previous) history.accounts[current.key] = { id: idFactory('acct', current.key), provider: current.provider,
      email: current.email, workspaceId: current.workspaceId }
  }
  for (const current of spec.groups) if (!Object.hasOwn(history.groups, current.key)) history.groups[current.key] = idFactory('group', current.key)
  if (Object.keys(history.accounts).length > 256 || Object.keys(history.groups).length > 128) fail('registry_history_full')
  const revision = (prior?.revision || 0) + 1
  if (revision > 4096) fail('registry_history_full')
  return validateStoredAccountRegistry({
    schemaVersion: 1, revision, mode: 'staged', automaticSwitching: false, spec, history, sourceDigest,
    receipts: [...(prior?.receipts || []), { requestId: spec.requestId, digest: accountRegistryDigest(spec), revision }],
  })
}

export function publicAccountRegistry(input) {
  const value = validateStoredAccountRegistry(input)
  const id = key => value.history.accounts[key].id
  return {
    schemaVersion: 1, revision: value.revision, mode: 'staged', automaticSwitching: false,
    accounts: value.spec.accounts.map(current => ({
      id: id(current.key), ...current, nodeId: LOCAL_NODE_ID, identity: 'owner-confirmed',
      monitoring: 'not-enrolled', automaticEligible: false,
    })),
    groups: value.spec.groups.map(current => ({ id: value.history.groups[current.key], key: current.key, name: current.name,
      members: current.members.map(id), drainingMembers: current.drainingMembers.map(id), preferred: Object.fromEntries(Object.entries(current.preferred).map(([p, key]) => [p, id(key)])) })),
    routing: { defaultGroupId: value.history.groups[value.spec.routing.defaultGroup],
      channels: Object.fromEntries(Object.entries(value.spec.routing.channels).map(([ch, key]) => [ch, value.history.groups[key]])) },
  }
}

export function previewPoolAccountSelection(input, { channelId, provider: currentProvider, account: selector = null,
  nodeId = LOCAL_NODE_ID, mode = 'manual',
} = {}) {
  if (!channel.safeParse(channelId).success) fail('invalid_channel')
  if (nodeId !== LOCAL_NODE_ID) fail('nonlocal_account_node')
  if (mode === 'automatic') fail('automatic_switching_disabled')
  if (mode !== 'manual') fail('invalid_selection_mode')
  if (!provider.safeParse(currentProvider).success) fail('provider_not_managed')
  const value = publicAccountRegistry(input)
  const groupId = value.routing.channels[channelId] || value.routing.defaultGroupId
  const currentGroup = value.groups.find(g => g.id === groupId)
  const providerMembers = value.accounts.filter(a => currentGroup.members.includes(a.id) && a.provider === currentProvider)
  const permitted = a => a.allowedChannels === null || a.allowedChannels.includes(channelId)
  let selected
  if (selector !== null) {
    if (typeof selector !== 'string' || selector.length > 254) fail('invalid_account_selector')
    let candidates = value.accounts.filter(a => a.id === selector || a.key === selector ||
      a.credentials.some(ref => ref.kind === 'legacy-claude' && ref.alias === selector || ref.kind.endsWith('-profile') && ref.profile === selector))
    if (!candidates.length) candidates = value.accounts.filter(a => a.provider === currentProvider && a.email.toLowerCase() === selector.toLowerCase())
    if (!candidates.length) fail('unknown_account')
    if (candidates.length !== 1) fail('ambiguous_account')
    selected = candidates[0]
    if (selected.provider !== currentProvider) fail('provider_mismatch')
    if (!currentGroup.members.includes(selected.id)) fail('account_outside_group')
    if (!permitted(selected)) fail('account_channel_forbidden')
    if (selected.lifecycle !== 'active' || currentGroup.drainingMembers.includes(selected.id)) fail('account_draining')
  } else {
    if (!providerMembers.length) fail('no_provider_account')
    const candidates = providerMembers.filter(a => permitted(a) && a.lifecycle === 'active' && !currentGroup.drainingMembers.includes(a.id))
    if (!candidates.length) fail('account_channel_forbidden')
    selected = candidates.find(a => a.id === currentGroup.preferred[currentProvider])
    if (!selected && candidates.length !== 1) fail('account_selection_required')
    selected ||= candidates[0]
  }
  return { readOnly: true, policyAllowed: true, runtimeAllowed: false, automaticSwitching: false,
    group: { id: currentGroup.id, key: currentGroup.key, name: currentGroup.name }, account: selected }
}

export function planAccountRegistryMigration(spec, { legacyAccounts = '', state = {}, prior = null, acceptSourceChange = false } = {}) {
  const compiled = compileAccountRegistry(spec, { legacyAccounts, prior, acceptSourceChange,
    idFactory: (kind, key) => `${kind}_preview-${accountRegistryDigest(key).slice(0, 16)}` })
  const view = publicAccountRegistry(compiled)
  const bindings = []
  const record = value => value && typeof value === 'object' && !Array.isArray(value)
  const safeSid = sid => typeof sid === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(sid)
  const audit = (channelId, sessionId, session, leg, local) => {
    const currentProvider = session.provider || 'claude'
    const groupId = view.routing.channels[channelId] || view.routing.defaultGroupId
    const targetGroup = view.groups.find(g => g.id === groupId)
    const base = { channelId, sessionId, provider: ['claude', 'codex', 'pi'].includes(currentProvider) ? currentProvider : 'unsupported',
      leg, groupId, groupName: targetGroup.name, currentAccountId: null, currentEmail: null, desiredAccountId: null, desiredEmail: null }
    if (!local) return { ...base, action: 'requires-review', reason: 'nonlocal-or-mismatched-node' }
    if (currentProvider === 'pi') return { ...base, action: 'provider-not-managed' }
    if (!['claude', 'codex'].includes(currentProvider)) return { ...base, action: 'requires-review', reason: 'unsupported-provider' }
    const alias = session.account || null
    const current = view.accounts.find(a => a.provider === currentProvider && a.credentials.some(ref =>
      alias === null ? ref.kind === 'native-default' : currentProvider === 'codex'
        ? ref.kind === 'codex-profile' && ref.profile === alias : session.accountKind === 'claude-profile'
          ? ref.kind === 'claude-profile' && ref.profile === alias : ref.kind === 'legacy-claude' && ref.alias === alias))
    if (!current) return { ...base, action: 'requires-review', reason: 'unknown-current-account' }
    base.currentAccountId = current.id; base.currentEmail = current.email
    try {
      previewPoolAccountSelection(compiled, { channelId, provider: currentProvider, account: current.id })
      return { ...base, desiredAccountId: current.id, desiredEmail: current.email, action: 'preserve' }
    } catch (error) {
      if (!['account_outside_group', 'account_channel_forbidden'].includes(error.code)) return { ...base, action: 'requires-review', reason: 'selection-unresolved' }
      try {
        const next = previewPoolAccountSelection(compiled, { channelId, provider: currentProvider })
        return { ...base, desiredAccountId: next.account.id, desiredEmail: next.account.email, action: 'account-correction-required' }
      } catch { return { ...base, action: 'requires-review', reason: 'no-unambiguous-destination' } }
    }
  }
  if (!record(state?.channels) || !record(state?.sessions)) state = { channels: {}, sessions: {} }
  for (const channelId of Object.keys(state.channels).sort()) {
    const sessionId = state.channels[channelId], session = state.sessions[sessionId]
    if (!channel.safeParse(channelId).success || !safeSid(sessionId) || !record(session) ||
        session.channel !== channelId || (session.id && session.id !== sessionId)) continue
    if (bindings.length >= 4096) fail('too_many_bindings')
    const local = channelNodeId(state, channelId) === LOCAL_NODE_ID
    bindings.push(audit(channelId, sessionId, session, 'active', local))
    const lineage = state.lineages?.[channelId]
    const currentProvider = session.provider || 'claude'
    if (lineage?.activeProvider !== currentProvider || lineage.legs?.[currentProvider] !== sessionId) continue
    for (const nextProvider of ['claude', 'codex']) {
      const sid = lineage.legs?.[nextProvider], standby = state.sessions[sid]
      if (nextProvider === currentProvider || !safeSid(sid) || !record(standby) ||
          standby.channel != null || (standby.provider || 'claude') !== nextProvider || (standby.id && standby.id !== sid)) continue
      if (bindings.length >= 4096) fail('too_many_bindings')
      let standbyLocal = false
      try { standbyLocal = local && nodeIdForSession(standby) === LOCAL_NODE_ID } catch {}
      bindings.push(audit(channelId, sid, standby, 'standby', standbyLocal))
    }
  }
  return { schemaVersion: 1, status: 'proposed', readOnly: true, canStage: true, canActivate: false,
    registry: view, bindings, summary: {
      accounts: view.accounts.length, groups: view.groups.length, bindings: bindings.length,
      corrections: bindings.filter(b => b.action === 'account-correction-required').length,
      preserved: bindings.filter(b => b.action === 'preserve').length,
      reviews: bindings.filter(b => b.action === 'requires-review').length,
      standbyChecks: bindings.filter(b => b.leg === 'standby').length,
    } }
}
