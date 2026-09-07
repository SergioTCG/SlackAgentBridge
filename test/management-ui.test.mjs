import test from 'node:test'
import assert from 'node:assert/strict'
import {
  authoritativeManagementBinding,
  bridgeDashboardBlocks,
  managementActionId,
  modelPickerBlocks,
  newSessionBlocks,
  parseManagementActionId,
  sessionDashboardBlocks,
  settingPickerBlocks,
  switchPickerBlocks,
  teamPickerBlocks,
  terminalPickerBlocks,
  updatePickerBlocks,
} from '../daemon/management-ui.mjs'

const SID = '01a01234-5678-7abc-8def-0123456789ab'

test('management action ids round-trip a bounded session identity', () => {
  const id = managementActionId('terminal', SID, 'open')
  assert.deepEqual(parseManagementActionId(id), {
    kind: 'terminal', target: SID, action: 'open',
  })
  assert.equal(parseManagementActionId('collab_add'), null)
  assert.throws(() => managementActionId('terminal', 'bad:session', 'open'))
})

test('management controls bind to one exact current channel and session', () => {
  const session = { id: SID, channel: 'C123' }
  const state = { sessions: { [SID]: session }, channels: { C123: SID } }
  assert.equal(authoritativeManagementBinding(state, 'C123', SID), session)
  assert.equal(authoritativeManagementBinding(state, 'C999', SID), null)
  state.channels.C123 = 'replacement-session'
  assert.equal(authoritativeManagementBinding(state, 'C123', SID), null)
})

test('model picker is bounded to Slack limits and preserves the selected value', () => {
  const blocks = modelPickerBlocks({
    sessionId: SID,
    provider: 'codex',
    current: 'model-4',
    models: Array.from({ length: 105 }, (_, index) => ({
      value: `model-${index}`,
      label: `Model ${index}`,
      description: `Reasoning model ${index}`,
    })),
  })
  const select = blocks[1].accessory
  assert.equal(select.type, 'static_select')
  assert.equal(select.options.length, 100)
  assert.equal(select.initial_option.value, 'model-4')
  assert.deepEqual(parseManagementActionId(select.action_id), {
    kind: 'model', target: SID, action: 'select',
  })
  assert.ok(select.options.every(option => option.text.text.length <= 75))
  assert.ok(select.options.every(option => option.value.length <= 150))
})

test('model picker never truncates an overlong value into a different model identity', () => {
  const valid = `provider/${'m'.repeat(141)}`
  const tooLong = `provider/${'m'.repeat(142)}`
  const blocks = modelPickerBlocks({
    sessionId: SID, provider: 'pi', current: valid,
    models: [{ value: tooLong, label: 'Invalid long model' }, { value: valid, label: 'Valid long model' }],
  })
  assert.deepEqual(blocks[1].accessory.options.map(option => option.value), [valid])
  assert.equal(blocks[1].accessory.options[0].text.text, 'Valid long model')
})

test('effort, terminal, update, switch, new, and dashboard panels use only SAB actions', () => {
  const panels = [
    settingPickerBlocks({ sessionId: SID, kind: 'effort', title: 'Effort', current: 'xhigh', values: ['low', 'xhigh'] }),
    terminalPickerBlocks({ sessionId: SID }),
    updatePickerBlocks({ sessionId: SID }),
    switchPickerBlocks({ sessionId: SID, currentProvider: 'codex', providers: ['claude', 'codex', 'pi'] }),
    newSessionBlocks(['claude', 'codex', 'pi']),
    bridgeDashboardBlocks(),
    sessionDashboardBlocks({ sessionId: SID, provider: 'codex' }),
    teamPickerBlocks({ sessionId: SID, team: { id: 'team_one', coordinator: true, continuation: 'manual' } }),
  ]
  const actions = panels.flatMap(blocks => blocks)
    .flatMap(block => block.type === 'actions' ? block.elements : block.accessory ? [block.accessory] : [])
  assert.ok(actions.length > 10)
  assert.ok(actions.every(action => action.action_id.startsWith('sab_manage:')))
  assert.ok(actions.every(action => action.action_id.length <= 255))
  assert.ok(panels.flat().filter(block => block.type === 'actions').every(block => block.elements.length <= 5))
  assert.ok(panels.flat().filter(block => block.type === 'actions').every(block => {
    const ids = block.elements.map(element => element.action_id)
    return new Set(ids).size === ids.length
  }))
})

test('dangerous update-all button requires an explicit Slack confirmation', () => {
  const blocks = updatePickerBlocks({ sessionId: SID })
  const buttons = blocks.find(block => block.type === 'actions').elements
  const all = buttons.find(button => parseManagementActionId(button.action_id)?.action === 'all')
  assert.equal(all.style, 'danger')
  assert.match(all.confirm.title.text, /all/i)
  assert.match(all.confirm.confirm.text, /update/i)
})

test('team close is coordinator-only and confirmed', () => {
  const worker = teamPickerBlocks({ sessionId: SID, team: { id: 'team_old', coordinator: false, continuation: 'manual' } })
  assert.equal(worker.find(block => block.type === 'actions').elements.length, 1)
  const coordinator = teamPickerBlocks({ sessionId: SID, team: { id: 'team_old', coordinator: true, continuation: 'manual' } })
  const close = coordinator.find(block => block.type === 'actions').elements
    .find(action => parseManagementActionId(action.action_id)?.action === 'close')
  assert.equal(close.style, 'danger')
  assert.match(close.confirm.title.text, /close/i)
  assert.equal(parseManagementActionId(close.action_id).binding, 'team_old')
})
