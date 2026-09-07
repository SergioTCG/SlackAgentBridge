const ACTION_PREFIX = 'sab_manage'
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/

const text = (value, limit = 75) => String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, limit) || '—'
const providerName = provider => provider === 'claude' ? 'Claude Code'
  : provider === 'codex' ? 'Codex'
    : provider === 'pi' ? 'Pi' : text(provider)

function token(value, field) {
  const normalized = String(value || '')
  if (!TOKEN_RE.test(normalized)) throw new Error(`invalid management ${field}`)
  return normalized
}

export function managementActionId(kind, target = 'bridge', action = 'open', binding = null) {
  const parts = [ACTION_PREFIX, token(kind, 'kind'), token(target, 'target'), token(action, 'action')]
  if (binding) parts.push(token(binding, 'binding'))
  return parts.join(':')
}

export function parseManagementActionId(value) {
  const parts = String(value || '').split(':')
  if (![4, 5].includes(parts.length) || parts[0] !== ACTION_PREFIX ||
      !parts.slice(1).every(part => TOKEN_RE.test(part))) return null
  return {
    kind: parts[1], target: parts[2], action: parts[3],
    ...(parts[4] ? { binding: parts[4] } : {}),
  }
}

export function authoritativeManagementBinding(state, channel, target) {
  if (!channel || !target || target === 'bridge') return null
  const session = state?.sessions?.[target]
  if (!session || state?.channels?.[channel] !== target || session.channel !== channel) return null
  return session
}

function button(label, kind, target, action, { style, confirm, binding } = {}) {
  return {
    type: 'button',
    text: { type: 'plain_text', text: text(label) },
    action_id: managementActionId(kind, target, action, binding),
    value: action,
    ...(style ? { style } : {}),
    ...(confirm ? { confirm } : {}),
  }
}

const confirmation = ({ title, body, confirm: confirmText, danger = false }) => ({
  title: { type: 'plain_text', text: text(title, 100) },
  text: { type: 'mrkdwn', text: String(body).slice(0, 300) },
  confirm: { type: 'plain_text', text: text(confirmText, 30) },
  deny: { type: 'plain_text', text: 'Cancel' },
  ...(danger ? { style: 'danger' } : {}),
})

function optionsFrom(models) {
  const seen = new Set()
  const options = []
  for (const model of models || []) {
    const value = text(model?.value, 150)
    if (seen.has(value) || value === '—') continue
    seen.add(value)
    const option = { text: { type: 'plain_text', text: text(model?.label || value) }, value }
    if (model?.description) option.description = { type: 'plain_text', text: text(model.description) }
    options.push(option)
    if (options.length === 100) break
  }
  return options
}

export function modelPickerBlocks({ sessionId, provider, current, models }) {
  const target = token(sessionId, 'session')
  const options = optionsFrom(models)
  if (!options.length) return []
  const selected = options.find(option => option.value === current)
  const select = {
    type: 'static_select',
    action_id: managementActionId('model', target, 'select'),
    placeholder: { type: 'plain_text', text: 'Choose a model…' },
    options,
    ...(selected ? { initial_option: selected } : {}),
  }
  return [
    { type: 'header', text: { type: 'plain_text', text: `${providerName(provider)} model` } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Current: \`${text(current, 120)}\`\nChoose a supported model. The authoritative provider validates it again before applying.` },
      accessory: select,
    },
    ...(models.length > options.length
      ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `_Showing the first ${options.length} supported models. The textual \`/sab-model <id>\` form accepts the full catalog._` }] }]
      : []),
  ]
}

export function settingPickerBlocks({ sessionId, kind, title, current, values }) {
  const target = token(sessionId, 'session')
  const options = optionsFrom((values || []).map(value => ({ value, label: value })))
  if (!options.length) return []
  const selected = options.find(option => option.value === current)
  return [
    { type: 'header', text: { type: 'plain_text', text: text(title) } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `Current: \`${text(current, 120)}\`` },
      accessory: {
        type: 'static_select',
        action_id: managementActionId(kind, target, 'select'),
        placeholder: { type: 'plain_text', text: `Choose ${kind}…` },
        options,
        ...(selected ? { initial_option: selected } : {}),
      },
    },
  ]
}

export function terminalPickerBlocks({ sessionId = null } = {}) {
  const target = sessionId ? token(sessionId, 'session') : 'bridge'
  const elements = []
  if (sessionId) {
    elements.push(button('Open / focus', 'terminal', target, 'open', { style: 'primary' }))
    elements.push(button('Close viewport', 'terminal', target, 'close'))
  }
  elements.push(button('List terminals', 'terminal', target, 'list'))
  elements.push(button('Open all', 'terminal', target, 'open-all'))
  elements.push(button('Close all', 'terminal', target, 'close-all'))
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Terminal viewports' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Ghostty is only a viewport. Opening or closing it never starts, stops, or interrupts the tmux-owned agent session.' } },
    { type: 'actions', block_id: `sab_terminal_${target}`, elements },
  ]
}

export function updatePickerBlocks({ sessionId = null } = {}) {
  const target = sessionId ? token(sessionId, 'session') : 'bridge'
  const elements = []
  if (sessionId) {
    elements.push(button('Update this session', 'update', target, 'current', {
      style: 'primary',
      confirm: confirmation({
        title: 'Update this session?',
        body: 'The provider process will restart and resume with its latest known settings.',
        confirm: 'Update',
      }),
    }))
  }
  elements.push(button('Update all idle sessions', 'update', target, 'all', {
    style: 'danger',
    confirm: confirmation({
      title: 'Update all sessions?',
      body: 'Only eligible idle authoritative sessions are restarted. Busy and protected sessions are skipped.',
      confirm: 'Update all',
      danger: true,
    }),
  }))
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Provider maintenance' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Updates preserve each session’s latest known model, effort, flags, account, cwd, and native conversation identity.' } },
    { type: 'actions', block_id: `sab_update_${target}`, elements },
  ]
}

export function switchPickerBlocks({ sessionId, currentProvider, providers }) {
  const target = token(sessionId, 'session')
  const elements = (providers || [])
    .filter(provider => provider !== currentProvider)
    .map(provider => button(`Switch to ${providerName(provider)}`, 'switch', target, provider))
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Switch provider' } },
    { type: 'section', text: { type: 'mrkdwn', text: `Current provider: *${providerName(currentProvider)}*. The existing leg remains authoritative until private handoff validation succeeds.` } },
    { type: 'actions', block_id: `sab_switch_${target}`, elements },
  ]
}

export function newSessionBlocks(providers) {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'New agent session' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'Choose a provider, then choose a project folder. The provider’s configured default launch flags are applied.' } },
    {
      type: 'actions', block_id: 'sab_new_provider',
      elements: (providers || []).map(provider => button(providerName(provider), 'new', 'bridge', provider, provider === 'codex' ? { style: 'primary' } : {})),
    },
  ]
}

export function sessionDashboardBlocks({ sessionId, provider }) {
  const target = token(sessionId, 'session')
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Manage this SAB session' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Authoritative provider: *${providerName(provider)}*. Controls are revalidated when clicked.` }] },
    {
      type: 'actions', block_id: `sab_dashboard_primary_${target}`,
      elements: [
        button('Model', 'panel', target, 'model'),
        button('Effort', 'panel', target, 'effort'),
        button('Terminal', 'panel', target, 'terminal'),
        button('Switch provider', 'panel', target, 'switch'),
        button('Update', 'panel', target, 'update'),
      ],
    },
    {
      type: 'actions', block_id: `sab_dashboard_secondary_${target}`,
      elements: [
        button('Usage', 'panel', target, 'usage'),
        button('Team', 'panel', target, 'team'),
      ],
    },
  ]
}

export function bridgeDashboardBlocks() {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Manage Slack Agent Bridge' } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Bridge-wide controls use the same `/sab-*` command paths and safety gates as their textual forms.' }] },
    {
      type: 'actions', block_id: 'sab_dashboard_bridge',
      elements: [
        button('New session', 'panel', 'bridge', 'new', { style: 'primary' }),
        button('Terminals', 'panel', 'bridge', 'terminal'),
        button('Update sessions', 'panel', 'bridge', 'update'),
        button('Health', 'panel', 'bridge', 'health'),
        button('Usage', 'panel', 'bridge', 'usage'),
      ],
    },
  ]
}

export function teamPickerBlocks({ sessionId, team }) {
  const target = token(sessionId, 'session')
  if (!team) return []
  const binding = token(team.id, 'team')
  const coordinator = Boolean(team.coordinator)
  const elements = [button('Refresh', 'team', target, 'status', { binding })]
  if (coordinator) {
    elements.push(button('Add worker', 'team', target, 'add', { binding }))
    elements.push(button(team.continuation === 'auto-until-blocked' ? 'Use manual mode' : 'Enable auto mode',
      'team', target, team.continuation === 'auto-until-blocked' ? 'manual' : 'auto', { binding }))
    elements.push(button('Permissions', 'team', target, 'permissions', { binding }))
    elements.push(button('Close team', 'team', target, 'close', {
      binding,
      style: 'danger',
      confirm: confirmation({
        title: 'Close this team?',
        body: 'Membership and outstanding team tasks are revoked. Provider sessions remain running.',
        confirm: 'Close team',
        danger: true,
      }),
    }))
  }
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Session team controls' } },
    { type: 'actions', block_id: `sab_team_${target}`, elements },
  ]
}
