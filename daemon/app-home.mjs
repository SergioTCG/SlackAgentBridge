export const APP_HOME_CALLBACK = 'sab_app_home_v1'
export const APP_HOME_NEW_CALLBACK = 'sab_app_home_new_session_v1'

const ACTION_PREFIX = 'sab_home'
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/
const MAX_HOME_SESSIONS = 50

const plain = (value, limit = 75) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, limit) || '—'
const optionValue = value => {
  const raw = String(value ?? '')
  // Slack Option values are identity-bearing and allow 150 characters. Never
  // truncate one into a different project/model identity; omit invalid values.
  return raw && raw.length <= 150 && !/[\r\n\0]/.test(raw) ? raw : null
}
const providerName = provider => provider === 'claude' ? 'Claude Code'
  : provider === 'codex' ? 'Codex'
    : provider === 'pi' ? 'Pi' : plain(provider)

function token(value, field) {
  const normalized = String(value || '')
  if (!TOKEN_RE.test(normalized)) throw new Error(`invalid App Home ${field}`)
  return normalized
}

export function appHomeActionId(kind, target = 'bridge', action = 'open') {
  return [ACTION_PREFIX, token(kind, 'kind'), token(target, 'target'), token(action, 'action')].join(':')
}

export function parseAppHomeActionId(value) {
  const parts = String(value || '').split(':')
  if (parts.length !== 4 || parts[0] !== ACTION_PREFIX ||
      !parts.slice(1).every(part => TOKEN_RE.test(part))) return null
  return { kind: parts[1], target: parts[2], action: parts[3] }
}

const confirmation = ({ title, body, confirm, danger = false }) => ({
  title: { type: 'plain_text', text: plain(title, 100) },
  text: { type: 'mrkdwn', text: String(body).slice(0, 300) },
  confirm: { type: 'plain_text', text: plain(confirm, 30) },
  deny: { type: 'plain_text', text: 'Cancel' },
  ...(danger ? { style: 'danger' } : {}),
})

function button(label, kind, target, action, { style, confirm } = {}) {
  return {
    type: 'button', text: { type: 'plain_text', text: plain(label) },
    action_id: appHomeActionId(kind, target, action), value: action,
    ...(style ? { style } : {}), ...(confirm ? { confirm } : {}),
  }
}

function selectOptions(items) {
  const seen = new Set()
  const options = []
  for (const item of items || []) {
    const value = optionValue(item?.value ?? item)
    if (!value || seen.has(value)) continue
    seen.add(value)
    const option = { text: { type: 'plain_text', text: plain(item?.label ?? item) }, value }
    if (item?.description) option.description = { type: 'plain_text', text: plain(item.description) }
    options.push(option)
    if (options.length === 100) break
  }
  return options
}

function selector({ kind, sessionId, current, placeholder, options }) {
  const selected = options.find(option => option.value === current)
  return {
    type: 'static_select', action_id: appHomeActionId(kind, sessionId, 'select'),
    placeholder: { type: 'plain_text', text: plain(placeholder) }, options,
    ...(selected ? { initial_option: selected } : {}),
  }
}

export function appHomeOverviewView({ authorized, stats = {}, sessions = [], notice = '' }) {
  if (!authorized) {
    return {
      type: 'home', callback_id: APP_HOME_CALLBACK,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Slack Agent Bridge' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Owner-only management*\nThis bridge is managed by its assigned owner. Ask the owner to add you as a collaborator to an individual session when appropriate.' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'No session identities, folders, settings, or controls are exposed here.' }] },
      ],
    }
  }

  const shown = sessions.slice(0, MAX_HOME_SESSIONS)
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Slack Agent Bridge' } },
    ...(notice ? [{ type: 'section', text: { type: 'mrkdwn', text: String(notice).slice(0, 2000) } }] : []),
    {
      type: 'section',
      text: { type: 'mrkdwn', text:
        `*Bridge overview* · uptime ${plain(stats.uptime, 40)}\n` +
        `${Number(stats.active) || 0} active · ${Number(stats.dormant) || 0} dormant · ` +
        `${Number(stats.claude) || 0} Claude · ${Number(stats.codex) || 0} Codex · ${Number(stats.pi) || 0} Pi` },
    },
    {
      type: 'actions', block_id: 'sab_home_bridge_primary', elements: [
        button('Refresh', 'navigate', 'bridge', 'overview'),
        button('New session', 'modal', 'bridge', 'new', { style: 'primary' }),
        button('Open all terminals', 'terminal', 'bridge', 'open-all'),
        button('Close all terminals', 'terminal', 'bridge', 'close-all'),
        button('Update all', 'update', 'bridge', 'all', {
          style: 'danger',
          confirm: confirmation({
            title: 'Update all sessions?',
            body: 'Only eligible idle authoritative sessions are restarted. Busy and protected sessions are skipped.',
            confirm: 'Update all', danger: true,
          }),
        }),
      ],
    },
    {
      type: 'actions', block_id: 'sab_home_bridge_secondary', elements: [
        button('Usage report', 'dispatch', 'bridge', 'usage'),
        button('Health report', 'dispatch', 'bridge', 'health'),
      ],
    },
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: 'Authoritative session channels' } },
  ]
  if (!shown.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No authoritative session channels yet._' } })
  }
  for (const session of shown) {
    const details = [session.model ? `model \`${plain(session.model, 100)}\`` : null, session.effort ? `effort \`${plain(session.effort, 40)}\`` : null]
      .filter(Boolean).join(' · ')
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text:
        `*<#${session.channel}>* · ${providerName(session.provider)} · ${session.active ? '🟢 active' : '💤 dormant'}\n` +
        `${details || '_settings unknown_'}\n\`${plain(session.cwd, 500)}\`` },
      accessory: button('Manage', 'navigate', session.id, 'session'),
    })
  }
  if (sessions.length > shown.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_Showing ${shown.length} of ${sessions.length} sessions. Use \`/sab-status\` in the control channel for the complete list._` }] })
  }
  return { type: 'home', callback_id: APP_HOME_CALLBACK, blocks }
}

export function appHomeSessionView({ session, models = [], efforts = [], providers = [], notice = '' }) {
  const sid = token(session?.id, 'session')
  const modelOptions = selectOptions(models)
  const effortOptions = selectOptions(efforts)
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Manage SAB session' } },
    ...(notice ? [{ type: 'section', text: { type: 'mrkdwn', text: String(notice).slice(0, 2000) } }] : []),
    {
      type: 'actions', block_id: `sab_home_navigation_${sid}`, elements: [
        button('← All sessions', 'navigate', 'bridge', 'overview'),
        button('Refresh', 'navigate', sid, 'session'),
      ],
    },
    {
      type: 'section', text: { type: 'mrkdwn', text:
        `*<#${session.channel}>* · ${providerName(session.provider)} · ${session.active ? '🟢 active' : '💤 dormant'}\n` +
        `Model \`${plain(session.model, 120)}\` · effort \`${plain(session.effort, 50)}\` · terminal ${session.terminalOpen ? '🖥️ open' : '▫️ closed'}\n` +
        `\`${plain(session.cwd, 500)}\`` },
    },
    { type: 'divider' },
  ]
  if (modelOptions.length) {
    blocks.push({
      type: 'section', text: { type: 'mrkdwn', text: '*Model*\nThe provider catalog is revalidated when selected.' },
      accessory: selector({ kind: 'model', sessionId: sid, current: session.model, placeholder: 'Choose a model…', options: modelOptions }),
    })
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '_The live model catalog is currently unavailable; no model control is shown._' }] })
  }
  if (effortOptions.length) {
    blocks.push({
      type: 'section', text: { type: 'mrkdwn', text: `*${session.provider === 'pi' ? 'Thinking' : 'Effort'}*` },
      accessory: selector({ kind: 'effort', sessionId: sid, current: session.effort, placeholder: 'Choose effort…', options: effortOptions }),
    })
  }
  blocks.push(
    {
      type: 'actions', block_id: `sab_home_terminal_${sid}`, elements: [
        button('Open / focus terminal', 'terminal', sid, 'open', { style: 'primary' }),
        button('Close terminal', 'terminal', sid, 'close'),
      ],
    },
    {
      type: 'actions', block_id: `sab_home_switch_${sid}`, elements: (providers || [])
        .filter(provider => provider !== session.provider)
        .map(provider => button(`Switch to ${providerName(provider)}`, 'switch', sid, provider)),
    },
    {
      type: 'actions', block_id: `sab_home_session_${sid}`, elements: [
        button('Update session', 'update', sid, 'current', {
          confirm: confirmation({
            title: 'Update this session?',
            body: 'The provider process will restart and resume with its latest known settings.',
            confirm: 'Update',
          }),
        }),
        button('Usage', 'dispatch', sid, 'usage'),
        button('Team', 'dispatch', sid, 'team'),
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Lifecycle reports, switch confirmation, usage, and team details remain visible in the session channel.' }] },
  )
  return { type: 'home', callback_id: APP_HOME_CALLBACK, private_metadata: `session:${sid}`, blocks }
}

export function newSessionModal({ providers = [], projects = [] }) {
  const providerOptions = selectOptions(providers.map(provider => ({ value: provider, label: providerName(provider) })))
  const projectOptions = selectOptions(projects.map(project => ({ value: project, label: project })))
  if (!providerOptions.length || !projectOptions.length) throw new Error('new-session modal requires providers and projects')
  return {
    type: 'modal', callback_id: APP_HOME_NEW_CALLBACK,
    title: { type: 'plain_text', text: 'New SAB session' },
    submit: { type: 'plain_text', text: 'Start session' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input', block_id: 'sab_home_new_provider',
        label: { type: 'plain_text', text: 'Provider' },
        element: {
          type: 'static_select', action_id: 'sab_home_new_provider_select',
          placeholder: { type: 'plain_text', text: 'Choose a provider…' }, options: providerOptions,
        },
      },
      {
        type: 'input', block_id: 'sab_home_new_project',
        label: { type: 'plain_text', text: 'Project folder' },
        element: {
          type: 'static_select', action_id: 'sab_home_new_project_select',
          placeholder: { type: 'plain_text', text: 'Choose a project…' }, options: projectOptions,
        },
      },
      {
        type: 'input', block_id: 'sab_home_new_flags', optional: true,
        label: { type: 'plain_text', text: 'Launch flags (optional)' },
        hint: { type: 'plain_text', text: 'Leave blank for the provider defaults. Values use the same allowlist as /sab-new.' },
        element: {
          type: 'plain_text_input', action_id: 'sab_home_new_flags_input',
          placeholder: { type: 'plain_text', text: '--model opus --effort max --dsp' },
        },
      },
    ],
  }
}

export function parseNewSessionSubmission(view) {
  if (view?.callback_id !== APP_HOME_NEW_CALLBACK) throw new Error('unknown App Home modal')
  const values = view?.state?.values || {}
  const provider = values.sab_home_new_provider?.sab_home_new_provider_select?.selected_option?.value
  const project = values.sab_home_new_project?.sab_home_new_project_select?.selected_option?.value
  const rawFlags = values.sab_home_new_flags?.sab_home_new_flags_input?.value || ''
  if (!provider || !project || String(project).length > 150 || String(project).includes('\0')) {
    throw new Error('incomplete new-session modal')
  }
  const flags = String(rawFlags).trim().split(/\s+/).filter(Boolean)
  if (flags.length > 64 || flags.some(flag => flag.length > 500 || flag.includes('\0'))) throw new Error('invalid launch flags')
  return { provider: String(provider), project: String(project), flags }
}

export function validateNewSessionSelection(request, { providers = [], projects = [] }) {
  if (!request || !providers.includes(request.provider) || !projects.includes(request.project)) {
    throw new Error('the selected provider or project is no longer available')
  }
  return request
}
