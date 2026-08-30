import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readNodeListenerConfiguration } from '../daemon/node-runtime.mjs'

test('node listener stays disabled unless explicitly configured', () => {
  assert.deepEqual(readNodeListenerConfiguration({}), { enabled: false })
})

test('loopback node listener permits plaintext and derives its private URL', () => {
  assert.deepEqual(readNodeListenerConfiguration({ SAB_NODE_LISTEN: '127.0.0.1:8878' }), {
    enabled: true,
    host: '127.0.0.1',
    port: 8878,
    publicUrl: 'ws://127.0.0.1:8878/nodes',
    tls: null,
  })
})

test('non-loopback node listener requires TLS, an explicit WSS URL, and private key permissions', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-node-runtime-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const key = path.join(temp, 'key.pem')
  const cert = path.join(temp, 'cert.pem')
  fs.writeFileSync(key, 'key', { mode: 0o600 })
  fs.writeFileSync(cert, 'cert', { mode: 0o644 })
  const base = {
    SAB_NODE_LISTEN: '0.0.0.0:8878',
    SAB_NODE_PUBLIC_URL: 'wss://studio.example.test:8878/nodes',
    SAB_NODE_TLS_KEY: key,
    SAB_NODE_TLS_CERT: cert,
  }
  const configured = readNodeListenerConfiguration(base)
  assert.equal(configured.publicUrl, base.SAB_NODE_PUBLIC_URL)
  assert.equal(configured.tls.key.toString(), 'key')
  assert.equal(configured.tls.cert.toString(), 'cert')

  assert.throws(() => readNodeListenerConfiguration({ SAB_NODE_LISTEN: '0.0.0.0:8878' }), /requires TLS/)
  assert.throws(() => readNodeListenerConfiguration({
    SAB_NODE_LISTEN: '0.0.0.0:8878', SAB_NODE_TLS_KEY: key, SAB_NODE_TLS_CERT: cert,
  }), /PUBLIC_URL/)
  fs.chmodSync(key, 0o644)
  assert.throws(() => readNodeListenerConfiguration(base), /mode 0600/)
})

test('listener configuration rejects paths, credentials, invalid ports, and mismatched transport', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-node-runtime-invalid-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const key = path.join(temp, 'key.pem')
  const cert = path.join(temp, 'cert.pem')
  fs.writeFileSync(key, 'key', { mode: 0o600 })
  fs.writeFileSync(cert, 'cert')
  assert.throws(() => readNodeListenerConfiguration({ SAB_NODE_LISTEN: '127.0.0.1:99999' }), /invalid/)
  assert.throws(() => readNodeListenerConfiguration({ SAB_NODE_LISTEN: '127.0.0.1:8878/path' }), /invalid/)
  assert.throws(() => readNodeListenerConfiguration({
    SAB_NODE_LISTEN: '0.0.0.0:8878', SAB_NODE_PUBLIC_URL: 'ws://studio.test:8878/nodes',
    SAB_NODE_TLS_KEY: key, SAB_NODE_TLS_CERT: cert,
  }), /must use wss/)
})
