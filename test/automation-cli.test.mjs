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
})
