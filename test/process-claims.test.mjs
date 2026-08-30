import test from 'node:test'
import assert from 'node:assert/strict'
import { isNestedProviderClaim } from '../daemon/process-claims.mjs'

test('a provider rooted directly in the SAB tmux pane is authoritative', () => {
  const rows = [
    { pid: 120, ppid: 110, comm: 'codex-aarch64-apple-darwin' },
    { pid: 110, ppid: 100, comm: 'bash' },
  ]
  assert.equal(isNestedProviderClaim(rows, 120, [100], 'codex'), false)
  assert.equal(isNestedProviderClaim([{ pid: 120, ppid: 100, comm: 'claude' }], 120, [120], 'claude'), false)
})

test('nested Codex utilities cannot register as independent SAB sessions', () => {
  const rows = [
    { pid: 160, ppid: 150, comm: 'codex-aarch64-apple-darwin' },
    { pid: 150, ppid: 140, comm: 'zsh' },
    { pid: 140, ppid: 110, comm: 'codex-aarch64-apple-darwin' },
    { pid: 110, ppid: 100, comm: 'bash' },
  ]
  assert.equal(isNestedProviderClaim(rows, 160, [100], 'codex'), true)
})

test('incomplete ancestry and unknown providers fail closed', () => {
  assert.equal(isNestedProviderClaim([{ pid: 2, ppid: 99, comm: 'codex' }], 2, [1], 'codex'), true)
  assert.equal(isNestedProviderClaim([{ pid: 2, ppid: 1, comm: 'other' }], 2, [1], 'unknown'), true)
})
