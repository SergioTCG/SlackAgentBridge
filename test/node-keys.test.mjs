import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrCreateNodeKey, readNodeConnection, writeNodeConnection } from '../daemon/node-keys.mjs'

test('node keys are generated once, remain private, and never enter connection JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-node-key-'))
  try {
    const first = loadOrCreateNodeKey(dir)
    const second = loadOrCreateNodeKey(dir)
    assert.equal(second.publicKey, first.publicKey)
    assert.equal(second.keyFingerprint, first.keyFingerprint)
    assert.equal(fs.statSync(path.join(dir, 'node-key.pem')).mode & 0o777, 0o600)

    writeNodeConnection(dir, {
      nodeId: 'node_rade', coordinatorId: 'coordinator_sergej', coordinatorUrl: 'wss://sab.example.test/nodes',
      keyFingerprint: first.keyFingerprint,
    })
    const connection = readNodeConnection(dir)
    assert.equal(connection.nodeId, 'node_rade')
    assert.equal(connection.keyFingerprint, first.keyFingerprint)
    assert.equal(JSON.stringify(connection).includes('PRIVATE KEY'), false)
    assert.equal(fs.statSync(path.join(dir, 'node.json')).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('node connection config rejects plaintext non-loopback coordinators', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-node-config-'))
  try {
    assert.throws(() => writeNodeConnection(dir, {
      nodeId: 'node_rade', coordinatorId: 'coordinator_sergej', coordinatorUrl: 'ws://example.test/nodes',
      keyFingerprint: `sha256:${'a'.repeat(43)}`,
    }), /must use wss/)
    assert.doesNotThrow(() => writeNodeConnection(dir, {
      nodeId: 'node_rade', coordinatorId: 'coordinator_sergej', coordinatorUrl: 'ws://127.0.0.1:8878/nodes',
      keyFingerprint: `sha256:${'a'.repeat(43)}`,
    }))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
