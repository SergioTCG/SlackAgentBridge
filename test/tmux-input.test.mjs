import test from 'node:test'
import assert from 'node:assert/strict'
import { tmuxPaste } from '../daemon/util.mjs'

test('concurrent tmux pastes use isolated buffers and preserve their destinations', async () => {
  const buffers = new Map()
  const deliveries = new Map()
  const enters = []
  let setCalls = 0

  const run = async (_command, args) => {
    const operation = args[0]
    const option = name => args[args.indexOf(name) + 1]
    if (operation === 'set-buffer') {
      setCalls++
      buffers.set(option('-b'), args.at(-1))
      // Force both writers to overlap at the buffer boundary which used to be
      // shared bridge-wide as `sab-inject`.
      if (setCalls === 1) await new Promise(resolve => setImmediate(resolve))
      return { stdout: '', stderr: '' }
    }
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
    tmuxPaste('sab-one', 'prompt one', { run, pause: async () => {} }),
    tmuxPaste('sab-two', 'prompt two', { run, pause: async () => {} }),
  ])

  assert.equal(deliveries.get('sab-one'), 'prompt one')
  assert.equal(deliveries.get('sab-two'), 'prompt two')
  assert.deepEqual(enters.sort(), ['sab-one', 'sab-two'])
  assert.equal(buffers.size, 0)
})
