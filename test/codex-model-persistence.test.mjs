import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')

test('Codex keeps requested settings separate from its actual reported model', () => {
  assert.match(daemon, /if \(!session\.requestedModel\) session\.requestedModel = codexModelFromArgs\(session\.launchFlags\)/)
  assert.match(daemon, /if \(name === 'model'\) session\.requestedModel = value/)
  assert.match(daemon, /sessionMeta\.set\(session\.id,[\s\S]*model: body\.model/)
  assert.match(daemon, /Codex started with \*\$\{session\.model(?:\s*\|\|[^}]*)?}/)
  assert.match(daemon, /explicitChange: footer\.explicitChange/)
  assert.match(daemon, /const actualUnchanged = session\.model === footer\.model && session\.effort === footer\.effort/)
  assert.match(daemon, /sessionMeta\.set\(session\.id,[\s\S]*\/\/ Journal operator intent immediately before teardown[\s\S]*saveStateNow\(state\)/)
})
