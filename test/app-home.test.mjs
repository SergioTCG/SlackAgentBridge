import test from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_HOME_CALLBACK,
  APP_HOME_NEW_CALLBACK,
  appHomeOverviewView,
  appHomeSessionView,
  newSessionModal,
  parseAppHomeActionId,
  parseNewSessionSubmission,
  validateNewSessionSelection,
} from '../daemon/app-home.mjs'

const SID = '01a01234-5678-7abc-8def-0123456789ab'

test('authorized App Home renders bounded bridge controls and exact session navigation', () => {
  const sessions = Array.from({ length: 60 }, (_, index) => ({
    id: index === 0 ? SID : `session-${index}`,
    channel: `C${index}`,
    cwd: `/Users/example/Code/project-${index}`,
    provider: index % 2 ? 'claude' : 'codex',
    model: index % 2 ? 'opus' : 'gpt-5.6-sol',
    effort: 'xhigh',
    active: index % 3 !== 0,
  }))
  const view = appHomeOverviewView({
    authorized: true,
    stats: { active: 40, dormant: 20, claude: 30, codex: 30, pi: 0, uptime: '2.5h' },
    sessions,
  })
  assert.equal(view.type, 'home')
  assert.equal(view.callback_id, APP_HOME_CALLBACK)
  assert.ok(view.blocks.length <= 100)
  const actions = view.blocks.flatMap(block => block.type === 'actions' ? block.elements : block.accessory ? [block.accessory] : [])
  assert.ok(actions.every(action => action.action_id.startsWith('sab_home:')))
  assert.ok(actions.every(action => action.action_id.length <= 255))
  assert.ok(actions.some(action => parseAppHomeActionId(action.action_id)?.target === SID))
  assert.match(JSON.stringify(view), /Showing 50 of 60/)
})

test('unauthorized App Home contains no interactive controls or session data', () => {
  const view = appHomeOverviewView({ authorized: false, stats: {}, sessions: [{ id: SID, cwd: '/secret' }] })
  assert.equal(view.type, 'home')
  assert.doesNotMatch(JSON.stringify(view), /secret|sab_home:/)
  assert.match(JSON.stringify(view), /owner/i)
})

test('session App Home exposes provider-valid settings and confirmed lifecycle controls', () => {
  const view = appHomeSessionView({
    session: {
      id: SID, channel: 'C123', cwd: '/Users/example/Code/project', provider: 'codex',
      model: 'gpt-5.6-sol', effort: 'xhigh', active: true, terminalOpen: false,
    },
    models: [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    providers: ['claude', 'codex', 'pi'],
  })
  const serialized = JSON.stringify(view)
  assert.match(serialized, /gpt-5\.6-sol/)
  assert.match(serialized, /Switch to Claude Code/)
  assert.doesNotMatch(serialized, /Switch to Codex/)
  const actions = view.blocks.flatMap(block => block.type === 'actions' ? block.elements : block.accessory ? [block.accessory] : [])
  const update = actions.find(action => parseAppHomeActionId(action.action_id)?.kind === 'update')
  assert.match(update.confirm.title.text, /update/i)
})

test('new-session modal parses JSON-safe provider, folder, and flags fields', () => {
  const modal = newSessionModal({ providers: ['claude', 'codex', 'pi'], projects: ['Barrique', 'Project999'] })
  assert.equal(modal.type, 'modal')
  assert.equal(modal.callback_id, APP_HOME_NEW_CALLBACK)
  assert.ok(modal.blocks.length <= 100)
  const parsed = parseNewSessionSubmission({
    callback_id: APP_HOME_NEW_CALLBACK,
    state: { values: {
      sab_home_new_provider: { sab_home_new_provider_select: { selected_option: { value: 'codex' } } },
      sab_home_new_project: { sab_home_new_project_select: { selected_option: { value: 'Barrique' } } },
      sab_home_new_flags: { sab_home_new_flags_input: { value: '--yolo --search' } },
    } },
  })
  assert.deepEqual(parsed, { provider: 'codex', project: 'Barrique', flags: ['--yolo', '--search'] })
  assert.equal(validateNewSessionSelection(parsed, {
    providers: ['claude', 'codex', 'pi'], projects: ['Barrique', 'Project999'],
  }), parsed)
  assert.throws(() => validateNewSessionSelection({ ...parsed, project: '../secret' }, {
    providers: ['claude', 'codex', 'pi'], projects: ['Barrique', 'Project999'],
  }))
  assert.throws(() => parseNewSessionSubmission({ callback_id: 'foreign', state: { values: {} } }))
})

test('App Home action ids reject malformed or unbounded identities', () => {
  assert.deepEqual(parseAppHomeActionId(`sab_home:navigate:${SID}:session`), {
    kind: 'navigate', target: SID, action: 'session',
  })
  assert.equal(parseAppHomeActionId('sab_manage:panel:bridge:new'), null)
  assert.equal(parseAppHomeActionId(`sab_home:navigate:${'x'.repeat(129)}:session`), null)
})
