import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const manifest = JSON.parse(fs.readFileSync(new URL('../slack/app-manifest.json', import.meta.url), 'utf8'))
const commands = manifest.features.slash_commands
const names = commands.map(command => command.command)

test('Slack manifest has unique command names', () => {
  assert.equal(new Set(names).size, names.length)
})

test('Slack command definitions satisfy manifest field constraints', () => {
  for (const command of commands) {
    assert.match(command.command, /^\/[a-z0-9_-]{1,32}$/)
    assert.ok(command.description.length <= 75, `${command.command} description is too long`)
    assert.ok(!command.usage_hint || command.usage_hint.length <= 150, `${command.command} usage hint is too long`)
  }
  const scopes = new Set(manifest.oauth_config.scopes.bot)
  for (const scope of ['commands', 'chat:write', 'groups:write', 'groups:read', 'groups:history', 'files:write', 'files:read', 'users:read']) {
    assert.ok(scopes.has(scope), `missing required Slack scope ${scope}`)
  }
  assert.equal(manifest.settings.socket_mode_enabled, true)
  assert.equal(manifest.settings.interactivity.is_enabled, true)
})

test('Slack manifest has provider-neutral metadata', () => {
  assert.equal(manifest.display_information.name, 'Slack Agent Bridge')
  assert.match(manifest.display_information.description, /Claude Code, Codex, and Pi/)
  assert.equal(manifest.features.bot_user.display_name, 'Clavdivs')
})

test('the manifest exposes only the unified SAB namespace', () => {
  const expected = ['new', 'model', 'effort', 'flags', 'update', 'stop', 'switch', 'kill', 'status', 'usage',
    'run', 'account', 'terminal', 'health', 'cleanup', 'claim', 'help']
  assert.deepEqual(names.slice().sort(), expected.map(name => `/sab-${name}`).sort())
  assert.equal(names.some(name => /^\/(?:cc|codex|pi)-/.test(name)), false)
})

test('managed-run and terminal controls are available through SAB', () => {
  const command = commands.find(item => item.command === '/sab-run')
  assert.match(command.description, /managed/i)
  assert.match(command.usage_hint, /status/)
  assert.match(command.usage_hint, /mode/)
  const terminal = commands.find(item => item.command === '/sab-terminal')
  assert.match(terminal.usage_hint, /open-all/)
  assert.match(terminal.usage_hint, /close-all/)
  const update = commands.find(item => item.command === '/sab-update')
  assert.equal(update.usage_hint, '[all]')
})
