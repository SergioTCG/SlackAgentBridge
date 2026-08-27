import test from 'node:test'
import assert from 'node:assert/strict'

import {
  nextStructuredQuestion,
  questionBlocks,
  questionFormFromPane,
  questionFormMatches,
  questionFormsFromHook,
  questionFormsFromToolInput,
  questionOptionsMatch,
} from '../daemon/claude-question.mjs'

const toolInput = {
  questions: [{
    question: '`firstIndex` — 0-based position in the full ordered list is what I\'ll implement. Confirm or redirect?',
    header: 'Index base',
    multiSelect: false,
    options: [{
      label: '0-based, full list (Recommended)',
      description: 'firstIndex=0 is the very first tile; page = firstIndex / size.',
      preview: 'items[0] = "Ægir Estate" -> global index 0\nitems[7] = "Pétrus" -> global index 7',
    }, {
      label: '1-based',
      description: 'firstIndex=1 is the first tile.',
      preview: 'alphabet: [{ letter: "A", firstIndex: 1 }]',
    }],
  }],
}

test('structured Claude questions preserve semantic fields and recommendation state', () => {
  const [form] = questionFormsFromToolInput(toolInput)
  assert.equal(form.source, 'structured')
  assert.equal(form.header, 'Index base')
  assert.equal(form.question, toolInput.questions[0].question)
  assert.equal(form.multiSelect, false)
  assert.deepEqual(form.options, [{
    n: 1,
    label: '0-based, full list',
    recommended: true,
    description: 'firstIndex=0 is the very first tile; page = firstIndex / size.',
    preview: 'items[0] = "Ægir Estate" -> global index 0\nitems[7] = "Pétrus" -> global index 7',
  }, {
    n: 2,
    label: '1-based',
    recommended: false,
    description: 'firstIndex=1 is the first tile.',
    preview: 'alphabet: [{ letter: "A", firstIndex: 1 }]',
  }])
  assert.match(form.hash, /Index base/)
})

test('only the Claude AskUserQuestion hook activates structured question rendering', () => {
  assert.equal(questionFormsFromHook({ tool_name: 'Bash', tool_input: toolInput }).length, 0)
  assert.equal(questionFormsFromHook({ tool_name: 'AskUserQuestion', tool_input: toolInput }).length, 1)
})

test('Slack question blocks keep descriptions out of concise action buttons', () => {
  const [form] = questionFormsFromToolInput(toolInput)
  const blocks = questionBlocks('695df7b4-session', form)
  assert.match(blocks[0].text.text, /Claude asks — Index base/)
  assert.match(blocks[0].text.text, /`firstIndex` — 0-based position/)

  const optionSections = blocks.filter(block => block.type === 'section').slice(1)
  assert.match(optionSections[0].text.text, /\*1\. 0-based, full list\*  _Recommended_/)
  assert.match(optionSections[0].text.text, /firstIndex=0 is the very first tile/)
  assert.match(optionSections[0].text.text, /```[\s\S]*Ægir Estate[\s\S]*```/)
  assert.match(optionSections[1].text.text, /\*2\. 1-based\*/)

  const buttons = blocks.find(block => block.type === 'actions').elements
  assert.deepEqual(buttons.map(button => button.text.text), ['1. 0-based, full list', '2. 1-based'])
  assert.ok(buttons.every(button => button.text.text.length <= 75))
  assert.deepEqual(buttons.map(button => button.value), [
    'qform:695df7b4-session:1', 'qform:695df7b4-session:2',
  ])
})

test('wide terminal fallback ignores the side-by-side description panel', () => {
  const pane = [
    '────────────────────────────────────────────────────────────────────────',
    '  Plan saved to ~/.claude/plans/index-base.md',
    '  □ Index base',
    '',
    '  `firstIndex` — 0-based position in the full ordered list is what I\'ll implement. Confirm or redirect?',
    '',
    '❯ 1. 0-based, full list                 groupBy=winery&sortBy=winery&size=20',
    '    (Recommended)                       ┌──────────────────────────────┐',
    '  2. 1-based                            ├──────────── ✂ ─── 18 lines ─┤',
    '                                        └──────────────────────────────┘',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')
  const form = questionFormFromPane(pane)
  assert.equal(form.source, 'pane')
  assert.equal(form.header, 'Index base')
  assert.equal(form.question, toolInput.questions[0].question)
  assert.deepEqual(form.options.map(option => ({ n: option.n, label: option.label })), [
    { n: 1, label: '0-based, full list' },
    { n: 2, label: '1-based' },
  ])
  assert.equal(form.options[0].recommended, true)
  assert.equal(form.planPath, '~/.claude/plans/index-base.md')
})

test('pane fallback retains choices above the currently highlighted option', () => {
  const form = questionFormFromPane([
    'Choose an index base?',
    '  1. 0-based, full list',
    '❯ 2. 1-based',
    'Enter to select',
  ].join('\n'))
  assert.deepEqual(form.options.map(option => option.label), ['0-based, full list', '1-based'])
})

test('structured question sequences advance without replacing semantic forms with pane copies', () => {
  const forms = questionFormsFromToolInput({ questions: [
    toolInput.questions[0],
    { question: 'Choose verification depth.', header: 'Verification', multiSelect: false, options: [
      { label: 'Full suite', description: 'Run every gate.' },
      { label: 'Focused only', description: 'Run the affected tests.' },
    ] },
  ] })
  assert.equal(questionOptionsMatch(forms[0], questionFormFromPane([
    '  `firstIndex` — 0-based position in the full ordered list is what I\'ll implement. Confirm or redirect?',
    '❯ 1. 0-based, full list          preview text',
    '  2. 1-based                     more preview text',
    'Enter to select',
  ].join('\n'))), true)
  assert.equal(questionFormMatches(forms[0], { ...forms[0], question: 'A different question?' }), false)
  assert.deepEqual(nextStructuredQuestion({ sequence: forms, index: 0 }), { form: forms[1], index: 1 })
  assert.equal(nextStructuredQuestion({ sequence: forms, index: 1 }), null)
})

test('malformed question input is rejected and Slack fields stay bounded', () => {
  assert.deepEqual(questionFormsFromToolInput({ questions: [{ question: '', options: [] }] }), [])
  const [form] = questionFormsFromToolInput({ questions: [{
    question: 'q'.repeat(5000), header: '<unsafe>', options: [
      { label: `one ${'x'.repeat(500)}`, description: 'd'.repeat(5000), preview: 'p'.repeat(5000) },
      { label: 'two', description: 'ok' },
    ],
  }] })
  const blocks = questionBlocks('session', form)
  assert.ok(blocks.filter(block => block.type === 'section').every(block => block.text.text.length <= 3000))
  assert.doesNotMatch(blocks[0].text.text, /<unsafe>/)
  assert.ok(blocks.find(block => block.type === 'actions').elements.every(button => button.text.text.length <= 75))
})
