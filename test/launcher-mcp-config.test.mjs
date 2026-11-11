import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

// Every Claude launch passes the same shared MCP config file to Claude, and
// other launches start at the same time. A launch must never let anyone read
// that file empty or partly written: a Claude that does starts without the
// slack-bridge server and never receives its prompt.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(root, 'scripts', 'run-session.sh')
const LAUNCHES = 160
const PARALLEL = 8

const configFor = bridge =>
  `{ "mcpServers": { "slack-bridge": { "command": "node", "args": ["${bridge}/channel/server.mjs"] } } }\n`

// A fake Claude that checks, as the real one does at startup, that the config
// it was given has content.
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" != --mcp-config ] || [ ! -s "$2" ]; then echo "$2" >> "$SAB_TEST_EMPTY_CONFIGS"; fi
if [ -n "\${SAB_TEST_CLAUDE_STARTED:-}" ]; then : > "$SAB_TEST_CLAUDE_STARTED"; fi
exit 0
`

// Reads and parses the config in a loop until the stop file appears, then
// reports what it saw. The first check for the stop file comes after 63 reads,
// so a reader the scheduler starts late still reads.
const READER = `
const fs = require('node:fs')
const [target, stop, ...expected] = process.argv.slice(1)
const report = { reads: 0, empty: 0, invalid: 0, missing: 0, unexpected: 0, seen: expected.map(() => 0), first: null }
const deadline = Date.now() + 120000
process.stdout.write('ready\\n')
for (let i = 1; !(i % 64 === 0 && (fs.existsSync(stop) || Date.now() > deadline)); i++) {
  let text
  try { text = fs.readFileSync(target, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    report.missing++
    report.first ??= '(missing)'
    continue
  }
  report.reads++
  if (!text) { report.empty++; report.first ??= '(empty)'; continue }
  try { JSON.parse(text) } catch { report.invalid++; report.first ??= text; continue }
  const index = expected.indexOf(text)
  if (index < 0) { report.unexpected++; report.first ??= text } else report.seen[index]++
}
process.stdout.write(JSON.stringify(report) + '\\n')
`

// Two copies of the launcher in two bridge checkouts, so that consecutive
// launches write different content and every launch has something to write.
function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-mcp-config-'))
  const bin = path.join(temp, 'bin')
  const configDir = path.join(temp, 'config')
  fs.mkdirSync(bin)
  fs.mkdirSync(configDir)
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 })
  const bridges = ['a', 'b'].map(name => {
    const bridge = path.join(temp, `bridge-${name}`)
    fs.mkdirSync(path.join(bridge, 'scripts'), { recursive: true })
    fs.copyFileSync(runner, path.join(bridge, 'scripts', 'run-session.sh'))
    fs.chmodSync(path.join(bridge, 'scripts', 'run-session.sh'), 0o755)
    return fs.realpathSync(bridge)
  })
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    // An enclosing SAB or Claude session must not steer the launch under test.
    if (!/^(CCS_|CLAUDE)/.test(key) && key !== 'TMUX') env[key] = value
  }
  Object.assign(env, {
    HOME: temp,
    PATH: `${bin}:${process.env.PATH}`,
    CCS_CONFIG_DIR: configDir,
    CCS_NO_TMUX: '1',
    SAB_TEST_EMPTY_CONFIGS: path.join(temp, 'empty-configs'),
  })
  return {
    temp, bin, configDir, bridges, env,
    target: path.join(configDir, 'mcp.json'),
    launchers: bridges.map(bridge => path.join(bridge, 'scripts', 'run-session.sh')),
    emptyConfigs: () => fs.existsSync(env.SAB_TEST_EMPTY_CONFIGS)
      ? fs.readFileSync(env.SAB_TEST_EMPTY_CONFIGS, 'utf8').trim().split('\n') : [],
    cleanup: () => fs.rmSync(temp, { recursive: true, force: true }),
  }
}

function launch(launcher, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['claude'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stderr }))
  })
}

test('parallel launches never let Claude or a reader see the shared MCP config empty or partly written', async t => {
  const f = fixture()
  let reader
  try {
    const first = await launch(f.launchers[0], f.env)
    assert.equal(first.status, 0, first.stderr)

    const stop = path.join(f.temp, 'stop')
    reader = spawn(process.execPath, ['-e', READER, f.target, stop, ...f.bridges.map(configFor)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const lines = readline.createInterface({ input: reader.stdout })[Symbol.asyncIterator]()
    assert.equal((await lines.next()).value, 'ready')

    const results = []
    let next = 0
    const worker = async () => {
      while (next < LAUNCHES) {
        const index = next++
        results.push(await launch(f.launchers[index % 2], f.env))
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    fs.writeFileSync(stop, '')
    const line = await lines.next()
    assert.equal(line.done, false, 'the reader stopped without a report')
    const report = JSON.parse(line.value)
    t.diagnostic(`${LAUNCHES} launches, ${PARALLEL} at a time; reader: ${JSON.stringify(report)}`)

    for (const result of results) assert.equal(result.status, 0, result.stderr)
    const empty = f.emptyConfigs()
    assert.equal(empty.length, 0, `${empty.length} of ${LAUNCHES + 1} launched Claudes were given an empty config`)
    assert.ok(report.reads > 0, 'the reader read nothing')
    const bad = report.empty + report.invalid + report.missing + report.unexpected
    assert.equal(bad, 0,
      `the reader saw the config empty ${report.empty} times, invalid ${report.invalid}, missing ${report.missing} ` +
      `and unexpected ${report.unexpected} in ${report.reads} reads; first: ${report.first}`)
    assert.ok(f.bridges.map(configFor).includes(fs.readFileSync(f.target, 'utf8')))
    assert.deepEqual(fs.readdirSync(f.configDir), ['mcp.json'], 'a temporary file was left behind')
  } finally {
    reader?.kill()
    f.cleanup()
  }
})

test('the launcher writes the MCP config byte for byte as before and replaces a stale one', () => {
  const f = fixture()
  try {
    const bridge = fs.realpathSync(root)
    const env = { ...f.env, SAB_TEST_CLAUDE_STARTED: path.join(f.temp, 'started') }
    let run = spawnSync(runner, ['claude'], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(fs.readFileSync(f.target, 'utf8'), configFor(bridge))

    fs.writeFileSync(f.target, configFor('/an/older/bridge'))
    run = spawnSync(runner, ['claude'], { env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(fs.readFileSync(f.target, 'utf8'), configFor(bridge))
    assert.equal(fs.existsSync(env.SAB_TEST_CLAUDE_STARTED), true)
    assert.deepEqual(fs.readdirSync(f.configDir), ['mcp.json'])
  } finally { f.cleanup() }
})

test('a launch leaves an MCP config that already holds its content untouched', () => {
  const f = fixture()
  try {
    let run = spawnSync(f.launchers[0], ['claude'], { env: f.env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const past = new Date('2001-02-03T04:05:06Z')
    fs.utimesSync(f.target, past, past)
    const before = fs.statSync(f.target)

    run = spawnSync(f.launchers[0], ['claude'], { env: f.env, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    const after = fs.statSync(f.target)
    assert.equal(after.ino, before.ino, 'the config was replaced')
    assert.equal(after.mtimeMs, before.mtimeMs, 'the config was rewritten')
    assert.equal(fs.readFileSync(f.target, 'utf8'), configFor(f.bridges[0]))
    assert.deepEqual(fs.readdirSync(f.configDir), ['mcp.json'])
  } finally { f.cleanup() }
})

test('a failed config write leaves the shared MCP config whole, removes its temporary file and starts no Claude', () => {
  // The failing step writes part of the config before it fails.
  for (const step of ['cat', 'mv']) {
    const f = fixture()
    try {
      const stale = configFor('/an/older/bridge')
      fs.writeFileSync(f.target, stale)
      fs.writeFileSync(path.join(f.bin, step), '#!/bin/sh\nprintf \'{ "mcpServers": \'\nexit 1\n', { mode: 0o755 })
      const env = { ...f.env, SAB_TEST_CLAUDE_STARTED: path.join(f.temp, 'started') }

      const run = spawnSync(f.launchers[0], ['claude'], { env, encoding: 'utf8' })
      assert.notEqual(run.status, 0, `the launch went on after a failed ${step}`)
      assert.equal(fs.readFileSync(f.target, 'utf8'), stale, `a failed ${step} changed the shared config`)
      assert.deepEqual(fs.readdirSync(f.configDir), ['mcp.json'], `a failed ${step} left a temporary file`)
      assert.equal(fs.existsSync(env.SAB_TEST_CLAUDE_STARTED), false, `Claude started after a failed ${step}`)
    } finally { f.cleanup() }
  }
})
