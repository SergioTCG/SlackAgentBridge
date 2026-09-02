import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sab = path.join(root, 'bin', 'sab')
const runner = path.join(root, 'scripts', 'run-session.sh')
const claudeConsent = path.join(root, 'scripts', 'claude-consent.sh')

test('sab is the only public session launcher', () => {
  assert.equal(fs.existsSync(sab), true)
  for (const legacy of ['ccs', 'ccs-codex', 'ccs-spawn', 'ccs-window', 'sab-cc', 'sab-codex', 'sab-pi']) {
    assert.equal(fs.existsSync(path.join(root, 'bin', legacy)), false, `${legacy} still exists`)
  }
  const source = fs.readFileSync(sab, 'utf8')
  assert.match(source, /new\).*claude\|codex\|pi/s)
  assert.match(source, /terminal\)/)
  assert.match(source, /team\)/)
  assert.match(source, /node\)/)
  assert.match(source, /__run\)/)
})

test('daemon-created sessions use one detached tmux runner and never require Ghostty', () => {
  const util = fs.readFileSync(path.join(root, 'daemon', 'util.mjs'), 'utf8')
  const daemon = fs.readFileSync(path.join(root, 'daemon', 'daemon.mjs'), 'utf8')
  assert.match(util, /'new-session', '-d'/)
  assert.match(util, /path\.join\(BRIDGE, 'bin', 'sab'\), '__run', provider/)
  const spawnBody = util.slice(util.indexOf('export async function spawnSession'))
  assert.doesNotMatch(spawnBody.split('export async function availableModels')[0], /Ghostty\.app/)
  assert.doesNotMatch(daemon, /CLOSE_GRACE_MS|terminal closed → ending session/)
  assert.match(util, /detach-client', '-s', tname/)
})

test('the private runner exports the authoritative provider and shared bridge identity', () => {
  const source = fs.readFileSync(runner, 'utf8')
  assert.match(source, /export CCS_PROVIDER="\$provider"/)
  assert.match(source, /export CCS_BRIDGE=1/)
  assert.match(source, /run_claude/)
  assert.match(source, /run_codex/)
  assert.match(source, /run_pi/)
})

test('Claude runner uses its explicit approved channel without a detached development-consent gate', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-channel-'))
  try {
    const log = path.join(temp, 'claude-argv')
    fs.writeFileSync(path.join(temp, 'claude'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CLAUDE_TEST_LOG"\n', { mode: 0o755 })
    const run = spawnSync(sab, ['__run', 'claude', '--model', 'opus', '--resume', 'session-id'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        CCS_CONFIG_DIR: temp,
        CCS_NO_TMUX: '1',
        TMUX: '',
        CLAUDE_TEST_LOG: log,
      },
    })
    assert.equal(run.status, 0, run.stderr)
    const args = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.deepEqual(args.slice(0, 4), [
      '--mcp-config', path.join(temp, 'mcp.json'), '--channels', 'server:slack-bridge',
    ])
    assert.deepEqual(args.slice(4), ['--model', 'opus', '--resume', 'session-id'])
    assert.equal(args.includes('--dangerously-load-development-channels'), false)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('Claude trust helper selects the affirmative row instead of confirming the default exit', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-trust-'))
  try {
    const log = path.join(temp, 'keys')
    const selected = path.join(temp, 'selected-yes')
    const ended = path.join(temp, 'ended')
    fs.writeFileSync(path.join(temp, 'tmux'), `#!/bin/bash
case "$1" in
  has-session) [ ! -f "$TMUX_TEST_ENDED" ] ;;
  capture-pane)
    printf '%s\\n' 'Quick safety check: Is this a project you created or one you trust?'
    if [ -f "$TMUX_TEST_SELECTED" ]; then
      printf '%s\\n' '  No, exit' ' ❯ Yes, I trust this folder'
    else
      printf '%s\\n' ' ❯ No, exit' '   Yes, I trust this folder'
    fi
    ;;
  send-keys)
    key="\${!#}"
    printf '%s\\n' "$key" >> "$TMUX_TEST_LOG"
    if [ "$key" = Down ]; then : > "$TMUX_TEST_SELECTED"; fi
    if [ "$key" = Enter ]; then : > "$TMUX_TEST_ENDED"; fi
    ;;
esac
`, { mode: 0o755 })
    const run = spawnSync(claudeConsent, ['sab-test'], {
      encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        TMUX_TEST_LOG: log,
        TMUX_TEST_SELECTED: selected,
        TMUX_TEST_ENDED: ended,
      },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['Down', 'Enter'])
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('local sab new preserves provider argv without evaluating it through a shell', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-local-new-'))
  try {
    const marker = path.join(temp, 'must-not-exist')
    fs.writeFileSync(path.join(temp, 'tmux'), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const literal = `--model=literal;touch ${marker}`
    const run = spawnSync(sab, ['new', 'pi', '--cwd', temp, literal, '--thinking=xhigh'], {
      encoding: 'utf8', env: {
        ...process.env, PATH: `${temp}:${process.env.PATH}`, TMUX: '', CCS_TMUX: '', CCS_NO_TMUX: '',
      },
    })
    assert.equal(run.status, 0, run.stderr)
    const args = run.stdout.trim().split('\n')
    assert.equal(args[0], 'new-session')
    assert.ok(args.includes('--'))
    assert.ok(args.includes('env'))
    assert.ok(args.includes('CCS_PROVIDER=pi'))
    assert.ok(args.includes(literal))
    assert.equal(fs.existsSync(marker), false)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('Codex runner observes semantic commentary through a loopback App Server proxy', () => {
  const source = fs.readFileSync(runner, 'utf8')
  assert.match(source, /app-server --listen ws:\/\/127\.0\.0\.1:0/)
  assert.match(source, /codex-event-proxy\.mjs/)
  assert.match(source, /codex --remote "\$proxy_url"/)
  assert.match(source, /check_for_update_on_startup=false/)
  assert.match(source, /using the direct TUI/)
})

test('Codex runner inserts the transparent event proxy without changing user flags', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-codex-proxy-'))
  try {
    const log = path.join(temp, 'codex-argv')
    const flagsLog = path.join(temp, 'codex-user-flags')
    fs.writeFileSync(path.join(temp, 'codex'), `#!/bin/bash
if [ "$1" = app-server ]; then
  printf '%s\n' 'listening on: ws://127.0.0.1:45678'
  trap 'exit 0' TERM INT
  while :; do sleep 1; done
fi
printf '%s\n' "$@" > "$CODEX_TEST_LOG"
printf '%s\n' "$CCS_FLAGS" > "$CODEX_TEST_FLAGS_LOG"
`, { mode: 0o755 })
    const run = spawnSync(sab, ['__run', 'codex', '--model', 'gpt-test', '--search'], {
      encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env, PATH: `${temp}:${process.env.PATH}`, TMPDIR: temp,
        TMUX: 'test-client', CCS_TMUX: 'sab-test', CODEX_TEST_LOG: log,
        CODEX_TEST_FLAGS_LOG: flagsLog,
      },
    })
    assert.equal(run.status, 0, run.stderr)
    const args = fs.readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(args[0], '--remote')
    assert.match(args[1], /^ws:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual(args.slice(2), [
      '-c', 'check_for_update_on_startup=false',
      '-c', 'tui.keymap.chat.interrupt_turn="f12"',
      '--model', 'gpt-test', '--search',
    ])
    assert.equal(fs.readFileSync(flagsLog, 'utf8').trim(), '--model gpt-test --search')
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('Codex runner falls back to the direct TUI when App Server is unavailable', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-codex-fallback-'))
  try {
    const log = path.join(temp, 'codex-argv')
    fs.writeFileSync(path.join(temp, 'codex'), `#!/bin/bash
if [ "$1" = app-server ]; then exit 1; fi
printf '%s\n' "$@" > "$CODEX_TEST_LOG"
`, { mode: 0o755 })
    const run = spawnSync(sab, ['__run', 'codex', '--search'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, TMPDIR: temp, TMUX: 'test-client', CCS_TMUX: 'sab-test', CODEX_TEST_LOG: log },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stderr, /using the direct TUI/)
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
      '-c', 'check_for_update_on_startup=false',
      '-c', 'tui.keymap.chat.interrupt_turn="f12"',
      '--search',
    ])
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('Pi runner translates validated inline values to native argv pairs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-pi-argv-'))
  try {
    fs.writeFileSync(path.join(temp, 'pi'), '#!/bin/bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const run = spawnSync(sab, ['__run', 'pi', '--safe', '--model=qwen38-local/qwen3.8-27b', '--thinking=xhigh', '--provider=local', '--session', 'pi-session-id'], {
      encoding: 'utf8', env: { ...process.env, CCS_NO_TMUX: '1', PATH: `${temp}:${process.env.PATH}` },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(run.stdout.trim().split('\n').slice(2), [
      '--model', 'qwen38-local/qwen3.8-27b', '--thinking', 'xhigh', '--provider', 'local', '--session', 'pi-session-id',
    ])
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
