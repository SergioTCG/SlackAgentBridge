import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { waitForClaudeResumeClaim } from '../daemon/claude-resume.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const runnerPath = fileURLToPath(new URL('../scripts/run-session.sh', import.meta.url))
const runner = fs.readFileSync(runnerPath, 'utf8')

function fixture(session, overrides = {}) {
  const calls = { sleeps: 0, claims: 0 }
  return {
    calls,
    dependencies: {
      expectedTmux: 'sab-resume',
      tmuxAlive: async () => true,
      pidAlive: pid => pid === 222,
      validTmuxClaim: async (pid, tmux) => {
        calls.claims++
        return pid === 222 && tmux === 'sab-resume'
      },
      readExitCode: () => null,
      sleepFn: async () => { calls.sleeps++ },
      attempts: 3,
      intervalMs: 1,
      ...overrides,
    },
    session,
  }
}

test('Claude resurrection waits for its exact lifecycle PID/tmux claim', async () => {
  const session = { id: 'claude-session', pid: null, tmux: 'sab-resume' }
  const f = fixture(session, {
    sleepFn: async () => { f.calls.sleeps++; session.pid = 222 },
  })
  assert.deepEqual(await waitForClaudeResumeClaim(session, f.dependencies), {
    pid: 222, tmux: 'sab-resume', source: 'hook',
  })
  assert.equal(f.calls.sleeps, 1)
  assert.equal(f.calls.claims, 1)
})

test('a transient Claude tmux exit is not mistaken for successful resurrection', async () => {
  const f = fixture({ id: 'claude-session', pid: null, tmux: 'sab-resume' }, {
    tmuxAlive: async () => false,
    readExitCode: () => 1,
  })
  await assert.rejects(waitForClaudeResumeClaim(f.session, f.dependencies),
    /Claude exited before lifecycle adoption \(exit 1\)/)
})

test('Claude resurrection fails closed on timeout, rebound tmux, and unrelated PID', async () => {
  const timeout = fixture({ id: 'claude-session', pid: null, tmux: 'sab-resume' })
  await assert.rejects(waitForClaudeResumeClaim(timeout.session, timeout.dependencies),
    /did not emit SessionStart/)

  const rebound = fixture({ id: 'claude-session', pid: null, tmux: 'sab-other' })
  await assert.rejects(waitForClaudeResumeClaim(rebound.session, rebound.dependencies),
    /tmux identity changed/)

  const unrelated = fixture({ id: 'claude-session', pid: 333, tmux: 'sab-resume' })
  await assert.rejects(waitForClaudeResumeClaim(unrelated.session, unrelated.dependencies),
    /did not emit SessionStart/)
  assert.equal(unrelated.calls.claims, 0)
})

test('daemon retries Claude only after failed exact-hook adoption and reports final failure', () => {
  const resurrection = /async function resurrect\(session, text\) \{([\s\S]*?)\n\}\nconst pendingBySid/.exec(daemon)?.[1] || ''
  assert.match(resurrection, /provider === 'claude'[\s\S]*completeClaudeResumeReadiness\(session, tmuxName, startupStatusPath\)/)
  assert.match(resurrection, /Claude resume readiness failed[\s\S]*abandonResumeTmux\(tmuxName\)[\s\S]*tmuxKill\(tmuxName\)[\s\S]*continue/)
  assert.match(resurrection, /clearTeamInputReservation\(session\)/)
  assert.match(resurrection, /session\.tmux === lastTmuxName[\s\S]*session\.pid = null/)
  assert.match(resurrection, /state\.channelTmux\?\.\[session\.channel\] === lastTmuxName[\s\S]*delete state\.channelTmux\[session\.channel\]/)
  assert.match(resurrection, /The provider process did not initialize[\s\S]*message remains queued/i)
  assert.match(daemon, /abandonedResumeTmux\.has\(requestedTmux\)[\s\S]*ignored hook from abandoned resume/)
  const onHook = /async function onHook\(body,[\s\S]*?\n\}/.exec(daemon)?.[0] || ''
  assert.ok(onHook.indexOf('const sid = body.session_id') < onHook.indexOf('abandonedResumeTmux.has(requestedTmux)'),
    'the abandoned-attempt fence must be able to identify the late hook')
})

test('private runner records only a bounded numeric startup exit status', () => {
  assert.match(runner, /CCS_STARTUP_STATUS_FILE/)
  assert.match(runner, /resume-\[A-Za-z0-9_\.:-\]\+\\\.exit/)
  assert.match(runner, /printf '%s\\n' "\$status"/)
  assert.doesNotMatch(runner, /CCS_STARTUP_STATUS_FILE.*tee|tee.*CCS_STARTUP_STATUS_FILE/s)
})

test('private Claude runner records an armed startup exit without capturing terminal content', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-resume-'))
  try {
    const config = path.join(temp, 'config')
    const runtime = path.join(config, 'runtime')
    const statusFile = path.join(runtime, 'resume-sab-test.exit')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(`${statusFile}.armed`, '', { mode: 0o600 })
    fs.writeFileSync(path.join(temp, 'claude'), '#!/bin/bash\nexit 7\n', { mode: 0o755 })
    const result = spawnSync(runnerPath, ['claude', '--resume', 'session-id'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        CCS_CONFIG_DIR: config,
        CCS_NO_TMUX: '1',
        CCS_STARTUP_STATUS_FILE: statusFile,
        TMUX: '',
      },
    })
    assert.equal(result.status, 7, JSON.stringify({ error: result.error?.message, signal: result.signal, stderr: result.stderr }))
    assert.equal(fs.readFileSync(statusFile, 'utf8').trim(), '7')
    assert.equal(fs.statSync(statusFile).mode & 0o777, 0o600)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})

test('a disarmed successful Claude launch leaves no later startup status', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-claude-resume-'))
  try {
    const config = path.join(temp, 'config')
    const runtime = path.join(config, 'runtime')
    const statusFile = path.join(runtime, 'resume-sab-test.exit')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(temp, 'claude'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
    const result = spawnSync(runnerPath, ['claude', '--resume', 'session-id'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        CCS_CONFIG_DIR: config,
        CCS_NO_TMUX: '1',
        CCS_STARTUP_STATUS_FILE: statusFile,
        TMUX: '',
      },
    })
    assert.equal(result.status, 0)
    assert.equal(fs.existsSync(statusFile), false)
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
})
