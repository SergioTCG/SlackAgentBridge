const MAX_QUESTIONS = 4
const MAX_OPTIONS = 10
const MAX_SECTION_CHARS = 3000
const MAX_BUTTON_CHARS = 75

function bounded(value, limit) {
  let text = String(value || '')
  if (text.length <= limit) return text
  text = text.slice(0, Math.max(0, limit - 1))
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  return `${text.trimEnd()}…`
}

function clean(value, limit) {
  return bounded(String(value || '').replace(/[\u0000-\u001f\u007f]/g, character =>
    character === '\n' || character === '\t' ? character : ' ').trim(), limit)
}

function cleanLine(value, limit) {
  return bounded(clean(value, limit * 2).replace(/\s+/g, ' '), limit)
}

function escapeSlack(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function optionIdentity(label) {
  return String(label || '').replace(/\s*\(recommended\)\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function formHash(form) {
  return [form.header, form.question, form.multiSelect ? 'multi' : 'single', ...form.options.flatMap(option => [
    option.n, option.label, option.recommended ? 'recommended' : '', option.description, option.preview,
  ])].join('|')
}

function structuredOption(option, index) {
  if (!option || typeof option !== 'object') return null
  const rawLabel = cleanLine(option.label, 240)
  const recommended = /\s*\(recommended\)\s*$/i.test(rawLabel)
  const label = rawLabel.replace(/\s*\(recommended\)\s*$/i, '').trim()
  if (!label) return null
  return {
    n: index + 1,
    label,
    recommended,
    description: clean(option.description, 2400),
    preview: clean(option.preview, 6000),
  }
}

export function questionFormsFromToolInput(input) {
  if (!input || !Array.isArray(input.questions)) return []
  const forms = []
  for (const raw of input.questions.slice(0, MAX_QUESTIONS)) {
    if (!raw || typeof raw !== 'object') continue
    const question = clean(raw.question, 5000)
    const options = Array.isArray(raw.options)
      ? raw.options.slice(0, MAX_OPTIONS).map(structuredOption).filter(Boolean)
      : []
    if (!question || options.length < 2) continue
    const form = {
      source: 'structured',
      header: cleanLine(raw.header, 180),
      question,
      multiSelect: raw.multiSelect === true,
      options,
    }
    form.hash = formHash(form)
    forms.push(form)
  }
  return forms
}

export function questionFormsFromHook(body) {
  return body?.tool_name === 'AskUserQuestion' ? questionFormsFromToolInput(body.tool_input) : []
}

function optionSection(option) {
  const marker = option.recommended ? '  _Recommended_' : ''
  const heading = `*${option.n}. ${escapeSlack(option.label)}*${marker}`
  const description = escapeSlack(option.description)
  let text = description ? `${heading}\n${description}` : heading
  if (option.preview) {
    const room = MAX_SECTION_CHARS - text.length - 9
    if (room > 20) {
      const preview = bounded(escapeSlack(option.preview).replace(/```/g, "'''"), room)
      text += `\n\`\`\`\n${preview}\n\`\`\``
    }
  }
  return bounded(text, MAX_SECTION_CHARS)
}

export function questionBlocks(sessionId, form) {
  if (!form || !Array.isArray(form.options) || form.options.length < 2) return []
  const title = form.header
    ? `❓ *Claude asks — ${escapeSlack(form.header)}*`
    : '❓ *Claude asks*'
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: bounded(`${title}\n${escapeSlack(form.question)}`, MAX_SECTION_CHARS) },
  }]
  for (const option of form.options.slice(0, MAX_OPTIONS)) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: optionSection(option) } })
  }
  const buttons = form.options.slice(0, MAX_OPTIONS).map(option => ({
    type: 'button',
    text: { type: 'plain_text', text: bounded(`${option.n}. ${option.label}`, MAX_BUTTON_CHARS) },
    action_id: `qform_${option.n}`,
    value: `qform:${sessionId}:${option.n}`,
  }))
  for (let index = 0; index < buttons.length; index += 5) {
    blocks.push({
      type: 'actions',
      block_id: `qform_${String(sessionId).slice(0, 8)}_${index / 5}`,
      elements: buttons.slice(index, index + 5),
    })
  }
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: form.multiSelect
      ? 'select option numbers in the terminal, or reply here with one number at a time'
      : 'tap an option — or reply with just the number' }],
  })
  return blocks
}

function paneLabel(value) {
  return cleanLine(String(value || '').split(/\s{2,}/, 1)[0].replace(/[┌┐└┘├┤│─✂].*$/, ''), 240)
}

export function questionFormFromPane(pane) {
  const lines = String(pane || '').split('\n')
  let footer = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    if (/Enter to select/i.test(lines[index])) { footer = index; break }
  }
  if (footer < 0) return null

  let selected = -1
  for (let index = footer - 1; index >= Math.max(0, footer - 80); index--) {
    if (/^\s*❯\s*\d{1,2}\.\s+/.test(lines[index])) { selected = index; break }
  }
  if (selected < 0) return null

  const candidates = []
  for (let index = Math.max(0, selected - 24); index < footer; index++) {
    const match = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/.exec(lines[index])
    if (!match) continue
    const label = paneLabel(match[2])
    if (label) candidates.push({ index, n: Number(match[1]), label })
  }
  const selectedPosition = candidates.findIndex(option => option.index === selected)
  if (selectedPosition < 0) return null
  let first = selectedPosition
  let last = selectedPosition
  while (first > 0 && candidates[first].index - candidates[first - 1].index <= 6) first--
  while (last + 1 < candidates.length && candidates[last + 1].index - candidates[last].index <= 6) last++
  const matches = candidates.slice(first, last + 1)
  const unique = []
  for (const match of matches) {
    if (!unique.some(option => option.n === match.n)) unique.push(match)
  }
  if (unique.length < 2) return null
  unique.sort((a, b) => a.n - b.n)

  const options = unique.map((option, position) => {
    const end = position + 1 < unique.length ? unique[position + 1].index : footer
    const recommended = lines.slice(option.index + 1, end).some(line => /\(recommended\)/i.test(line))
    return { n: option.n, label: option.label, recommended, description: '', preview: '' }
  })

  let header = ''
  let question = ''
  for (let index = selected - 1; index >= Math.max(0, selected - 24); index--) {
    const value = lines[index].trim()
    if (!header) {
      const tab = /^[□☐☑◻]\s+(.+)$/.exec(value)
      if (tab) header = paneLabel(tab[1])
    }
    if (!question && /\?\s*$/.test(value) && !/Enter to select/i.test(value)) {
      question = clean(value, 5000)
    }
  }
  const form = {
    source: 'pane',
    header,
    question: question || 'Claude asks:',
    multiSelect: false,
    options,
    planPath: (String(pane || '').match(/(~|\/Users\/[^\s]+)\/\.claude\/plans\/[\w.-]+\.md/) || [])[0] || null,
  }
  form.hash = formHash(form)
  return form
}

export function questionOptionsMatch(left, right) {
  if (!left?.options || !right?.options || left.options.length !== right.options.length) return false
  return left.options.every((option, index) => optionIdentity(option.label) === optionIdentity(right.options[index]?.label))
}

export function questionFormMatches(left, right) {
  if (!questionOptionsMatch(left, right)) return false
  const leftQuestion = clean(left?.question, 5000).replace(/\s+/g, ' ').toLowerCase()
  const rightQuestion = clean(right?.question, 5000).replace(/\s+/g, ' ').toLowerCase()
  if (!leftQuestion || !rightQuestion || leftQuestion === 'claude asks:' || rightQuestion === 'claude asks:') return true
  return leftQuestion === rightQuestion
}

export function nextStructuredQuestion(entry) {
  if (!Array.isArray(entry?.sequence)) return null
  const index = Number(entry.index) + 1
  const form = entry.sequence[index]
  return form ? { form, index } : null
}
