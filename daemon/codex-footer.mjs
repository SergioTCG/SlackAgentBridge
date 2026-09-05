const CODEX_EFFORT_WORDS = '(?:minimal|low|medium|high|xhigh)'

// Read only the stable model/effort footer near the bottom of the Codex TUI.
// This deliberately ignores transcript content, tool output, and older
// scrollback so a conversational model name cannot mutate session metadata.
export function codexFooterSettings(pane) {
  const rows = String(pane || '').split(/\r?\n/).slice(-12)
  for (const row of rows.reverse()) {
    const match = row.match(new RegExp(`\\b(gpt-[A-Za-z0-9._-]+)\\s+(${CODEX_EFFORT_WORDS})\\s+·`, 'i'))
    if (match) return { model: match[1], effort: match[2].toLowerCase() }
  }
  return null
}
