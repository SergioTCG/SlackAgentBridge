import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { handleCodexBootstrapHttp } from '../daemon/codex-bootstrap-http.mjs'

const bootstrap = {
  threadId: '01a-bootstrap', cwd: '/Users/test/Code/worktree',
  model: 'gpt-5.6-sol', effort: 'xhigh',
}

async function withServer(dependencies, run) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!(await handleCodexBootstrapHttp(req, res, url, dependencies))) {
      res.writeHead(404); res.end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('Codex bootstrap accepts one exact pending automation through the fenced hook path', async () => {
  const calls = []
  const lifecycle = {
    async acceptCodexBootstrap(identity, tmux, accept) {
      calls.push(['candidate', identity, tmux])
      await accept({ flags: ['--model=gpt-5.6-sol', '--config', 'model_reasoning_effort="xhigh"'] })
      return 'accepted'
    },
  }
  await withServer({
    lifecycle,
    resolveAgentPid: async value => Number(value),
    codexAppServerProcessPid: async value => value,
    validProviderRootClaim: async (pid, tmux, provider) => pid === 42 && tmux === 'sab-auto-one' && provider === 'codex',
    acceptHook: async (...args) => calls.push(['hook', ...args]),
  }, async base => {
    const response = await fetch(`${base}/codex/bootstrap?ppid=42&tmux=sab-auto-one`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ccs-provider': 'codex' },
      body: JSON.stringify(bootstrap),
    })
    assert.equal(response.status, 202)
  })
  assert.deepEqual(calls[0], ['candidate', bootstrap, 'sab-auto-one'])
  assert.deepEqual(calls[1], ['hook', {
    hook_event_name: 'SessionStart', session_id: bootstrap.threadId, cwd: bootstrap.cwd,
    model: bootstrap.model, effort: bootstrap.effort, source: 'automation-app-server',
  }, 42, 'sab-auto-one', '--model=gpt-5.6-sol --config model_reasoning_effort="xhigh"', null, 'codex'])
})

test('Codex bootstrap fails closed on a mismatched process and treats unrelated sessions as no-op', async () => {
  let mode = 'ignore'
  let accepted = false
  const lifecycle = {
    async acceptCodexBootstrap(_identity, _tmux, accept) {
      if (mode === 'ignore') return 'ignore'
      await accept({ flags: [] })
      return 'accepted'
    },
  }
  await withServer({
    lifecycle,
    resolveAgentPid: async value => Number(value),
    codexAppServerProcessPid: async value => value,
    validProviderRootClaim: async () => false,
    acceptHook: async () => { accepted = true },
  }, async base => {
    const request = () => fetch(`${base}/codex/bootstrap?ppid=42&tmux=sab-auto-one`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ccs-provider': 'codex' },
      body: JSON.stringify(bootstrap),
    })
    assert.equal((await request()).status, 204)
    mode = 'accept'
    assert.equal((await request()).status, 403)
  })
  assert.equal(accepted, false)
})
