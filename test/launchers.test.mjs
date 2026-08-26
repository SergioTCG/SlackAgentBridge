import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

for (const [legacy, canonical] of [['ccs', 'sab-cc'], ['ccs-codex', 'sab-codex']]) {
  test(`${legacy} forwards every argument to ${canonical}`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-launcher-alias-'))
    try {
      const bin = path.join(temp, 'bin')
      fs.mkdirSync(bin)
      fs.copyFileSync(path.join(root, 'bin', legacy), path.join(bin, legacy))
      fs.chmodSync(path.join(bin, legacy), 0o755)
      fs.writeFileSync(path.join(bin, canonical), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
      const run = spawnSync(path.join(bin, legacy), ['--model', 'value with spaces', '--flag=x'], { encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      assert.deepEqual(run.stdout.trim().split('\n'), ['--model', 'value with spaces', '--flag=x'])
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
}

test('daemon-spawned sessions use canonical sab launchers', () => {
  const util = fs.readFileSync(path.join(root, 'daemon', 'util.mjs'), 'utf8')
  assert.match(util, /claude: 'sab-cc'/)
  assert.match(util, /codex: 'sab-codex'/)
  assert.match(util, /pi: 'sab-pi'/)
})

test('script-facing spawn accepts Pi as an explicit provider namespace', () => {
  const launcher = fs.readFileSync(path.join(root, 'bin', 'ccs-spawn'), 'utf8')
  assert.match(launcher, /"--pi"/)
  assert.match(launcher, /choose exactly one provider flag/)
})

test('canonical launchers export an authoritative provider for shared helpers', () => {
  const claude = fs.readFileSync(path.join(root, 'bin', 'sab-cc'), 'utf8')
  const codex = fs.readFileSync(path.join(root, 'bin', 'sab-codex'), 'utf8')
  const pi = fs.readFileSync(path.join(root, 'bin', 'sab-pi'), 'utf8')
  assert.match(claude, /export CCS_PROVIDER=claude/)
  assert.match(codex, /export CCS_PROVIDER=codex/)
  assert.match(pi, /export CCS_PROVIDER=pi/)
  assert.match(pi, /--extension/)
})

test('Codex launcher observes semantic commentary through a loopback App Server proxy', () => {
  const codex = fs.readFileSync(path.join(root, 'bin', 'sab-codex'), 'utf8')
  assert.match(codex, /app-server --listen ws:\/\/127\.0\.0\.1:0/)
  assert.match(codex, /codex-event-proxy\.mjs/)
  assert.match(codex, /--remote "\$CODEX_PROXY_URL"/)
  assert.match(codex, /falling back to the direct Codex TUI/)
})

test('Codex launcher inserts the transparent event proxy without changing user flags', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-codex-proxy-'))
  try {
    const log = path.join(temp, 'codex-argv')
    const fakeCodex = path.join(temp, 'codex')
    fs.writeFileSync(path.join(temp, 'tmux'), '#!/bin/sh\nprintf "%s\\n" ccs-test\n', { mode: 0o755 })
    fs.writeFileSync(fakeCodex, `#!/bin/bash
if [ "$1" = app-server ]; then
  printf '%s\\n' 'listening on: ws://127.0.0.1:45678'
  trap 'exit 0' TERM INT
  while :; do sleep 1; done
fi
printf '%s\\n' "$@" > "$CODEX_TEST_LOG"
`, { mode: 0o755 })
    const run = spawnSync(path.join(root, 'bin', 'sab-codex'), ['--model', 'gpt-test', '--search'], {
      encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        TMPDIR: temp,
        TMUX: 'test-client',
        CCS_TMUX: 'ccs-test',
        CODEX_TEST_LOG: log,
      },
    })
    assert.equal(run.status, 0, run.stderr)
    const args = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(args[0], '--remote')
    assert.match(args[1], /^ws:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual(args.slice(2), [
      '-c', 'tui.keymap.chat.interrupt_turn="f12"', '--model', 'gpt-test', '--search',
    ])
    assert.equal(fs.readdirSync(temp).some(name => name.startsWith('sab-codex-events.')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('Codex launcher fails back to the legacy direct TUI when App Server is unavailable', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-codex-fallback-'))
  try {
    const log = path.join(temp, 'codex-argv')
    const fakeCodex = path.join(temp, 'codex')
    fs.writeFileSync(path.join(temp, 'tmux'), '#!/bin/sh\nprintf "%s\\n" ccs-test\n', { mode: 0o755 })
    fs.writeFileSync(fakeCodex, `#!/bin/bash
if [ "$1" = app-server ]; then exit 1; fi
printf '%s\\n' "$@" > "$CODEX_TEST_LOG"
`, { mode: 0o755 })
    const run = spawnSync(path.join(root, 'bin', 'sab-codex'), ['--search'], {
      encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        TMPDIR: temp,
        TMUX: 'test-client',
        CCS_TMUX: 'ccs-test',
        CODEX_TEST_LOG: log,
      },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /falling back to the direct Codex TUI/)
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      '-c', 'tui.keymap.chat.interrupt_turn="f12"', '--search',
    ])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('sab-pi translates validated inline value flags to Pi native argv pairs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-pi-argv-'))
  try {
    const fakePi = path.join(temp, 'pi')
    fs.writeFileSync(fakePi, '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const run = spawnSync(path.join(root, 'bin', 'sab-pi'), [
      '--safe',
      '--model=qwen38-local/qwen3.8-27b',
      '--thinking=xhigh',
      '--provider=local',
      '--session', 'pi-session-id',
    ], {
      encoding: 'utf8',
      env: { ...process.env, CCS_NO_TMUX: '1', PATH: `${temp}:${process.env.PATH}` },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(run.stdout.trim().split('\n').slice(2), [
      '--model', 'qwen38-local/qwen3.8-27b',
      '--thinking', 'xhigh',
      '--provider', 'local',
      '--session', 'pi-session-id',
    ])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
