import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tmuxLoadBuffer, tmuxPaste } from '../daemon/util.mjs'
import { TEAM_MESSAGE_MAX_BYTES, delegatedTaskPrompt } from '../daemon/teams.mjs'

// tmux sends each command to its server as one message of at most 16 KiB.
// `tmux set-buffer <text>` therefore failed with "command too long" for any
// payload above ~16,340 bytes, although team instructions may be 24 KiB.
const TMUX_COMMAND_LIMIT = 16 * 1024

function recordingTmux() {
  const buffers = new Map()
  const calls = []
  const run = async (_command, args) => {
    calls.push(args)
    const operation = args[0]
    const option = name => args[args.indexOf(name) + 1]
    if (operation === 'paste-buffer') {
      assert.equal(buffers.has(option('-b')), true, `missing staged buffer ${option('-b')}`)
      return { stdout: '', stderr: '' }
    }
    if (operation === 'delete-buffer') { buffers.delete(option('-b')); return { stdout: '', stderr: '' } }
    if (operation === 'send-keys') return { stdout: '', stderr: '' }
    throw new Error(`unexpected tmux operation: ${operation}`)
  }
  const load = async (buffer, text) => { calls.push(['load-buffer', '-b', buffer, '-']); buffers.set(buffer, text) }
  return { buffers, calls, run, load, pause: async () => {} }
}

function maximumDelegatedPrompt() {
  // 24 KiB of instruction including multibyte text, plus the task envelope.
  let text = ''
  while (Buffer.byteLength(text + 'Ä→ step ✓\n') <= TEAM_MESSAGE_MAX_BYTES) text += 'Ä→ step ✓\n'
  const team = { id: 'team_issues', name: 'issue-batch' }
  const task = { id: 'task_lane_one', text, completionPolicy: 'coordinator-release', providerWorkGeneration: 1 }
  return { text, prompt: delegatedTaskPrompt(team, task, []) }
}

test('concurrent tmux pastes use isolated buffers and preserve their destinations', async () => {
  const buffers = new Map()
  const deliveries = new Map()
  const enters = []
  let loads = 0

  const load = async (buffer, text) => {
    loads++
    buffers.set(buffer, text)
    // Force both writers to overlap at the buffer boundary which used to be
    // shared bridge-wide as `sab-inject`.
    if (loads === 1) await new Promise(resolve => setImmediate(resolve))
  }
  const run = async (_command, args) => {
    const operation = args[0]
    const option = name => args[args.indexOf(name) + 1]
    if (operation === 'paste-buffer') {
      const buffer = option('-b')
      assert.equal(buffers.has(buffer), true, `missing isolated buffer ${buffer}`)
      deliveries.set(option('-t'), buffers.get(buffer))
      return { stdout: '', stderr: '' }
    }
    if (operation === 'delete-buffer') {
      buffers.delete(option('-b'))
      return { stdout: '', stderr: '' }
    }
    if (operation === 'send-keys') {
      enters.push(option('-t'))
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected tmux operation: ${operation}`)
  }

  await Promise.all([
    tmuxPaste('sab-one', 'prompt one', { run, load, pause: async () => {} }),
    tmuxPaste('sab-two', 'prompt two', { run, load, pause: async () => {} }),
  ])

  assert.equal(deliveries.get('sab-one'), 'prompt one')
  assert.equal(deliveries.get('sab-two'), 'prompt two')
  assert.deepEqual(enters.sort(), ['sab-one', 'sab-two'])
  assert.equal(buffers.size, 0)
})

test('instructions beyond the tmux command bound are staged on stdin, never in argv', async () => {
  const { prompt } = maximumDelegatedPrompt()
  assert.ok(Buffer.byteLength(prompt) > TMUX_COMMAND_LIMIT + 8 * 1024,
    'a maximum delegated task must exceed the old set-buffer bound')
  const unit = 'x'.repeat(63) + '\n'
  const boundary = n => unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
  for (const payload of [boundary(16_340), boundary(16_400), boundary(TMUX_COMMAND_LIMIT + 1), prompt]) {
    const tmux = recordingTmux()
    let staged = null
    await tmuxPaste('sab-worker', payload, {
      ...tmux, load: async (buffer, text) => { staged = text; return tmux.load(buffer, text) },
    })
    assert.equal(staged, payload, `${Buffer.byteLength(payload)} bytes must be staged exactly`)
    assert.deepEqual(tmux.calls.map(args => args[0]), ['load-buffer', 'paste-buffer', 'delete-buffer', 'send-keys'])
    for (const args of tmux.calls) {
      assert.ok(args.every(arg => Buffer.byteLength(String(arg)) < 256), 'no tmux argv may carry the payload')
    }
    assert.equal(tmux.buffers.size, 0)
  }
})

test('a staging failure proves non-delivery: nothing is pasted or submitted', async () => {
  const tmux = recordingTmux()
  const failure = await tmuxPaste('sab-worker', 'delegated work', {
    ...tmux, load: async () => { throw new Error('tmux load-buffer exited 1: no server running') },
  }).then(() => null, error => error)
  assert.equal(failure?.inputNotDelivered, true)
  assert.match(failure.message, /tmux could not stage the input: tmux load-buffer exited 1/)
  assert.deepEqual(tmux.calls.map(args => args[0]), ['delete-buffer'])
})

test('paste or Enter failures stay uncertain and are never repeated', async () => {
  for (const failing of ['paste-buffer', 'send-keys']) {
    const tmux = recordingTmux()
    const run = async (command, args) => {
      if (args[0] === failing) { tmux.calls.push(args); throw new Error(`${failing} failed`) }
      return tmux.run(command, args)
    }
    const failure = await tmuxPaste('sab-worker', 'delegated work', { ...tmux, run })
      .then(() => null, error => error)
    assert.ok(failure, `${failing} must reject`)
    assert.notEqual(failure.inputNotDelivered, true, `${failing} may follow a provider-visible write`)
    const operations = tmux.calls.map(args => args[0])
    assert.equal(operations.filter(operation => operation === 'paste-buffer').length, 1)
    assert.equal(operations.filter(operation => operation === 'send-keys').length, failing === 'send-keys' ? 1 : 0)
    assert.equal(tmux.buffers.size, 0, 'the staged buffer is always released')
  }
})

test('tmux load-buffer receives the payload on stdin and reports tmux errors', async () => {
  const children = []
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdin.end = text => { child.written = text; setImmediate(() => child.emit('close', child.exitCode)) }
    Object.assign(child, { command, args, options, exitCode: children.length === 0 ? 0 : 1 })
    if (child.exitCode) setImmediate(() => child.stderr.emit('data', Buffer.from('no server running on /tmp/tmux-1/default\n')))
    children.push(child)
    return child
  }
  const payload = 'Ä→ '.repeat(10_000)
  await tmuxLoadBuffer('sab-inject-1-1', payload, { spawnProcess })
  assert.equal(children[0].command, 'tmux')
  assert.deepEqual(children[0].args, ['load-buffer', '-b', 'sab-inject-1-1', '-'])
  assert.equal(children[0].written, payload)
  await assert.rejects(tmuxLoadBuffer('sab-inject-1-2', payload, { spawnProcess }),
    /tmux load-buffer exited 1: no server running/)
})

const tmuxBinary = spawnSync('tmux', ['-V'], { encoding: 'utf8' })
test('a real tmux server accepts the maximum delegated task that set-buffer rejected', {
  skip: tmuxBinary.status === 0 ? false : 'tmux is not installed',
}, async () => {
  // A private socket directory keeps this away from any developer tmux server.
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-tmux-'))
  const env = { ...process.env, TMUX_TMPDIR: tmpdir }
  delete env.TMUX
  const tmux = args => spawnSync('tmux', args, { env, encoding: 'utf8' })
  try {
    assert.equal(tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'probe', 'sleep 30']).status, 0)
    const { prompt } = maximumDelegatedPrompt()
    const legacy = tmux(['set-buffer', '-b', 'legacy', prompt])
    assert.notEqual(legacy.status, 0, 'tmux must reject the payload as a command argument')
    assert.match(legacy.stderr, /command too long/)

    await tmuxLoadBuffer('sab-inject-test', prompt, {
      spawnProcess: (command, args, options) => spawn(command, args, { ...options, env }),
    })
    const stored = spawnSync('tmux', ['show-buffer', '-b', 'sab-inject-test'], { env })
    assert.equal(stored.status, 0)
    assert.equal(Buffer.compare(stored.stdout, Buffer.from(prompt)), 0, 'the staged buffer must be byte-exact')
  } finally {
    tmux(['kill-server'])
    fs.rmSync(tmpdir, { recursive: true, force: true })
  }
})
