import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn('bin/sab', ['automation', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

test('sab automation creates JSON without shell interpolation and encodes status keys', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-automation-cli-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const prompt = 'Line one\nquotes: "hello"; shell text: $(touch /tmp/must-not-run)\n'
  const promptFile = path.join(temp, 'prompt.txt')
  fs.writeFileSync(promptFile, prompt)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
    res.setHeader('content-type', 'application/json')
    if (req.method === 'POST') res.end(JSON.stringify({ ok: true, created: true, externalKey: requests.at(-1).body.externalKey, tmux: 'sab-auto-test', status: 'pending' }))
    else res.end(JSON.stringify({ ok: true, externalKey: 'github:org/repo#1', status: 'pending' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const env = { ...process.env, SAB_AUTOMATION_URL: `http://127.0.0.1:${server.address().port}` }

  const create = await runCli([
    'create', '--external-key', 'github:org/repo#1', '--cwd', temp, '--provider', 'claude',
    '--collaborator', 'U098WAUUX5M', '--prompt-file', promptFile, '--',
    '--model', 'opus', '--effort', 'max', '--dsp', '--chrome',
  ], env)
  assert.equal(create.status, 0, create.stderr)
  assert.equal(JSON.parse(create.stdout).externalKey, 'github:org/repo#1')
  assert.deepEqual(requests[0].body, {
    externalKey: 'github:org/repo#1', cwd: temp, provider: 'claude',
    flags: ['--model', 'opus', '--effort', 'max', '--dsp', '--chrome'],
    collaborators: ['U098WAUUX5M'], initialPrompt: prompt,
  })

  const status = await runCli(['status', 'github:org/repo#1'], env)
  assert.equal(status.status, 0, status.stderr)
  assert.equal(requests[1].url, `/automation/sessions/${encodeURIComponent('github:org/repo#1')}`)
  const released = await runCli(['release', 'project:person/name', '--session', 'native', '--channel', 'CWORK', '--tmux', 'sab-current', '--request-id', 'release-once'], env)
  assert.equal(released.status, 0, released.stderr)
  assert.equal(requests[2].url, `/automation/sessions/${encodeURIComponent('project:person/name')}/release`)
  assert.deepEqual(requests[2].body, { sessionId: 'native', channelId: 'CWORK', tmux: 'sab-current', requestId: 'release-once' })
})

test('sab automation validates and normalizes provider flags without contacting the daemon', async () => {
  const result = await runCli([
    'validate-flags', '--provider', 'codex', '--',
    '--model', 'gpt-5.6-sol', '--effort', 'xhigh', '--yolo',
  ], { ...process.env, SAB_AUTOMATION_URL: 'http://127.0.0.1:1' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    provider: 'codex',
    flags: [
      '--model=gpt-5.6-sol', '--config', 'model_reasoning_effort="xhigh"',
      '--dangerously-bypass-approvals-and-sandbox',
    ],
  })

  const invalid = await runCli([
    'validate-flags', '--provider', 'codex', '--', '--effort', 'extreme',
  ], process.env)
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /invalid Codex effort/)
})

test('sab automation create binds a team worker from the calling coordinator session', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-automation-team-cli-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const taskFile = path.join(temp, 'task.md')
  fs.writeFileSync(taskFile, 'Implement issue 2995.\n')
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, provider: req.headers['x-ccs-provider'], body: JSON.parse(body) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, created: true, externalKey: 'k', tmux: 'sab-auto', status: 'pending' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = { ...process.env, SAB_AUTOMATION_URL: `http://127.0.0.1:${server.address().port}` }
  for (const key of Object.keys(base)) if (key.startsWith('CCS_')) delete base[key]
  const session = { ...base, CCS_BRIDGE: '1', CCS_TMUX: 'sab-auto-coordinator', CCS_PROVIDER: 'codex' }
  const args = [
    'create', '--external-key', 'github:barrique#2995', '--cwd', temp, '--provider', 'claude',
    '--task-file', taskFile, '--channel-name', 'cc-barrique-2995-vivian-holding-lines',
    '--team', 'epic-2995', '--alias', 'issue-2995', '--', '--model', 'claude-opus-5-5[1m]',
  ]
  const created = await runCli(args, session)
  assert.equal(created.status, 0, created.stderr)
  const url = new URL(requests[0].url, 'http://127.0.0.1')
  assert.equal(url.pathname, '/automation/sessions')
  assert.equal(url.searchParams.get('tmux'), 'sab-auto-coordinator')
  assert.match(url.searchParams.get('ppid'), /^\d+$/)
  assert.equal(requests[0].provider, 'codex')
  assert.deepEqual(requests[0].body, {
    externalKey: 'github:barrique#2995', cwd: temp, provider: 'claude',
    flags: ['--model', 'claude-opus-5-5[1m]'], collaborators: [], initialPrompt: '',
    channelName: 'cc-barrique-2995-vivian-holding-lines',
    team: { name: 'epic-2995', alias: 'issue-2995', task: 'Implement issue 2995.\n' },
  })

  // Outside a bridged session a team worker cannot be requested at all.
  const outside = await runCli(args, base)
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /inside the live Slack Agent Bridge session/)
  for (const [bad, message] of [
    [['--prompt-file', taskFile, '--task-file', taskFile, '--team', 'epic'], /only one of --prompt-file or --task-file/],
    [['--task-file', taskFile], /--task-file requires --team/],
    [['--prompt-file', taskFile, '--alias', 'x'], /--alias requires --team/],
    [['--prompt-file', taskFile, '--channel-name', 'Bad Name'], /--channel-name must be/],
  ]) {
    const result = await runCli(['create', '--external-key', 'k', '--cwd', temp, '--provider', 'claude', ...bad], session)
    assert.equal(result.status, 2, result.stdout)
    assert.match(result.stderr, message)
  }
  // A plain named channel needs no session identity.
  const named = await runCli(['create', '--external-key', 'k2', '--cwd', temp, '--provider', 'claude',
    '--prompt-file', taskFile, '--channel-name', 'cc-named'], base)
  assert.equal(named.status, 0, named.stderr)
  assert.equal(new URL(requests.at(-1).url, 'http://127.0.0.1').search, '')
  assert.equal(requests.at(-1).body.channelName, 'cc-named')
  assert.equal(requests.length, 2)
})
