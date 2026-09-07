const CODEX_EFFORT_WORDS = '(?:minimal|low|medium|high|xhigh)'

// Read only the stable model/effort footer near the bottom of the Codex TUI.
// This deliberately ignores transcript content, tool output, and older
// scrollback so a conversational model name cannot mutate session metadata.
// Codex also renders a short confirmation when an operator changes the model
// from the native picker. That line is the only terminal evidence strong
// enough to change SAB's durable requested settings: an ordinary footer can
// be a provider capacity fallback and must remain actual-only.
export function codexFooterSettings(pane) {
  const rows = String(pane || '').split(/\r?\n/).slice(-12)
  const explicitRows = rows.map((row, index) => ({
    index,
    match: row.match(new RegExp(`\\bModel changed to\\s+(gpt-[A-Za-z0-9._-]+)\\s+(${CODEX_EFFORT_WORDS})\\b`, 'i')),
  })).filter(item => item.match)
  const explicit = explicitRows.at(-1)
  const lastCapacity = rows.reduce((last, row, index) =>
    /Selected model is at capacity\. Please try a different model\./i.test(row) ? index : last, -1)
  for (const row of rows.reverse()) {
    const match = row.match(new RegExp(`\\b(gpt-[A-Za-z0-9._-]+)\\s+(${CODEX_EFFORT_WORDS})\\s+·`, 'i'))
    if (match) {
      const model = match[1]
      const effort = match[2].toLowerCase()
      return {
        model,
        effort,
        explicitChange: Boolean(explicit && explicit.index > lastCapacity &&
          explicit.match[1] === model && explicit.match[2].toLowerCase() === effort),
      }
    }
  }
  return null
}

export function shouldPromoteCodexFooter({ turnStartedAt = null, pollerActive = false,
  restarting = false, updating = false, explicitChange = false } = {}) {
  // Never infer operator intent from an unqualified footer. The explicit
  // confirmation is required while the native TUI is idle; an old confirmation
  // can remain in scrollback during a later active turn.
  return Boolean(explicitChange) && !turnStartedAt && !pollerActive && !restarting && !updating
}
