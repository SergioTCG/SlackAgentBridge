import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const installer = fs.readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const codexInstaller = fs.readFileSync(new URL('../install-codex.sh', import.meta.url), 'utf8')
const piInstaller = fs.readFileSync(new URL('../install-pi.sh', import.meta.url), 'utf8')

test('all installer entry points expose help without side effects', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-help-'))
  try {
    const fakeBin = path.join(temp, 'fake-bin')
    const config = path.join(temp, 'config')
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(config, { recursive: true })
    for (const command of ['claude', 'codex', 'pi', 'tmux']) {
      fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    fs.writeFileSync(path.join(config, 'env'), 'SLACK_BOT_TOKEN=test\nSLACK_APP_TOKEN=test\n', { mode: 0o600 })
    const env = {
      ...process.env,
      HOME: temp,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CCS_CONFIG_DIR: config,
      CCS_BIN_DIR: path.join(temp, 'linked-bin'),
      CODEX_HOME: path.join(temp, 'codex'),
      CCS_SKIP_DEPENDENCY_INSTALL: '1',
      CCS_SKIP_GIT_REMOTE_MIGRATION: '1',
    }
    for (const script of ['install.sh', 'install-codex.sh', 'install-pi.sh']) {
      const run = spawnSync('bash', [script, '--help'], { encoding: 'utf8', env })
      assert.equal(run.status, 0, `${script}: ${run.stderr || run.stdout}`)
      assert.match(run.stdout, /Usage:/, script)
      assert.doesNotMatch(run.stdout, /Installing Slack Agent Bridge|registered .* hooks/, script)
    }
    assert.equal(fs.existsSync(path.join(temp, 'linked-bin', 'sab')), false)
    assert.equal(fs.existsSync(path.join(temp, '.claude')), false)
    assert.equal(fs.existsSync(path.join(temp, 'codex')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('installer preserves installed runtime identities', () => {
  assert.match(installer, /\.claudeslackproxy/)
  assert.match(installer, /\.config\/ccs/)
  assert.match(installer, /si\.sergej\.claudeslackproxy/)
  assert.match(installer, /SergioTCG\/SlackAgentBridge/)
  assert.match(installer, /slack\/app-manifest\.json/)
  assert.match(installer, /Node >= 20 required/)
  assert.match(installer, /bin\/sab/)
  assert.match(installer, /if \[ "\$RELOAD_DAEMON" = 1 \]; then[\s\S]*for legacy in ccs .*sab-cc sab-codex sab-pi sab-upload sab-automation/)
})

test('legacy Codex activation remains a no-restart operation', () => {
  assert.match(codexInstaller, /--provider codex --no-daemon-reload/)
  assert.doesNotMatch(codexInstaller, /launchctl/)
})

test('Pi activation remains a no-restart operation', () => {
  assert.match(piInstaller, /--provider pi --no-daemon-reload/)
  assert.doesNotMatch(piInstaller, /launchctl/)
})

test('live daemon reload retries the transient launchd bootstrap race', () => {
  assert.match(installer, /for attempt in 1 2 3; do[\s\S]*launchctl bootstrap/)
  assert.match(installer, /LaunchAgent failed to load after 3 attempts/)
})

test('staged activation refuses to redirect a live install into a disposable worktree', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-live-target-'))
  try {
    const worktree = path.join(temp, 'Code', 'SlackAgentBridge-staging')
    const liveBridge = path.join(temp, '.slack-agent-bridge')
    const fakeBin = path.join(temp, 'fake-bin')
    const config = path.join(temp, 'config')
    const linkedBin = path.join(temp, 'linked-bin')
    const codexHome = path.join(temp, 'codex')
    const launchAgents = path.join(temp, 'Library', 'LaunchAgents')
    fs.mkdirSync(path.join(worktree, 'daemon'), { recursive: true })
    fs.mkdirSync(path.join(worktree, 'bin'), { recursive: true })
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(config, { recursive: true })
    fs.mkdirSync(linkedBin, { recursive: true })
    fs.mkdirSync(launchAgents, { recursive: true })
    fs.copyFileSync(new URL('../install.sh', import.meta.url), path.join(worktree, 'install.sh'))
    fs.writeFileSync(path.join(worktree, 'daemon', 'daemon.mjs'), '// staged fixture\n')
    fs.writeFileSync(path.join(worktree, 'bin', 'sab'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    for (const command of ['codex', 'tmux']) {
      fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(config, 'env'), [
      'SLACK_BOT_TOKEN=xoxb-test',
      'SLACK_APP_TOKEN=xapp-test',
      'SLACK_TEAM_ID=TTEST',
      '',
    ].join('\n'), { mode: 0o600 })
    fs.writeFileSync(path.join(launchAgents, 'si.sergej.claudeslackproxy.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>WorkingDirectory</key>',
      `<string>${liveBridge}</string>`,
      '</dict></plist>',
      '',
    ].join('\n'))

    const run = spawnSync('bash', [path.join(worktree, 'install.sh'), '--provider', 'codex', '--no-daemon-reload'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temp,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CCS_CONFIG_DIR: config,
        CCS_BIN_DIR: linkedBin,
        CODEX_HOME: codexHome,
        CCS_SKIP_DEPENDENCY_INSTALL: '1',
        CCS_SKIP_GIT_REMOTE_MIGRATION: '1',
      },
    })
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /live installation.*staged activation|staged activation.*live installation/i)
    assert.equal(fs.existsSync(path.join(linkedBin, 'sab')), false)
    assert.equal(fs.existsSync(path.join(codexHome, 'hooks.json')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('staged activation fails closed when the live install path cannot be verified', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-unverified-target-'))
  try {
    const worktree = path.join(temp, 'Code', 'SlackAgentBridge-staging')
    const fakeBin = path.join(temp, 'fake-bin')
    const config = path.join(temp, 'config')
    const linkedBin = path.join(temp, 'linked-bin')
    const codexHome = path.join(temp, 'codex')
    const launchAgents = path.join(temp, 'Library', 'LaunchAgents')
    fs.mkdirSync(path.join(worktree, 'daemon'), { recursive: true })
    fs.mkdirSync(path.join(worktree, 'bin'), { recursive: true })
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(config, { recursive: true })
    fs.mkdirSync(linkedBin, { recursive: true })
    fs.mkdirSync(launchAgents, { recursive: true })
    fs.copyFileSync(new URL('../install.sh', import.meta.url), path.join(worktree, 'install.sh'))
    fs.writeFileSync(path.join(worktree, 'daemon', 'daemon.mjs'), '// staged fixture\n')
    fs.writeFileSync(path.join(worktree, 'bin', 'sab'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    for (const command of ['codex', 'tmux']) {
      fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(config, 'env'), 'SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n', { mode: 0o600 })
    fs.writeFileSync(path.join(launchAgents, 'si.sergej.claudeslackproxy.plist'), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>ProgramArguments</key><array><string>node</string></array>',
      '</dict></plist>',
      '',
    ].join('\n'))

    const run = spawnSync('bash', [path.join(worktree, 'install.sh'), '--provider', 'codex', '--no-daemon-reload'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temp,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CCS_CONFIG_DIR: config,
        CCS_BIN_DIR: linkedBin,
        CODEX_HOME: codexHome,
        CCS_SKIP_DEPENDENCY_INSTALL: '1',
        CCS_SKIP_GIT_REMOTE_MIGRATION: '1',
      },
    })
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /cannot verify|unable to determine/i)
    assert.equal(fs.existsSync(path.join(linkedBin, 'sab')), false)
    assert.equal(fs.existsSync(path.join(codexHome, 'hooks.json')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('staged activation verifies a loaded service even when its plist is missing', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-loaded-target-'))
  try {
    const worktree = path.join(temp, 'Code', 'SlackAgentBridge-staging')
    const liveBridge = path.join(temp, '.slack-agent-bridge')
    const fakeBin = path.join(temp, 'fake-bin')
    const config = path.join(temp, 'config')
    const linkedBin = path.join(temp, 'linked-bin')
    const codexHome = path.join(temp, 'codex')
    fs.mkdirSync(path.join(worktree, 'daemon'), { recursive: true })
    fs.mkdirSync(path.join(worktree, 'bin'), { recursive: true })
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(config, { recursive: true })
    fs.mkdirSync(linkedBin, { recursive: true })
    fs.copyFileSync(new URL('../install.sh', import.meta.url), path.join(worktree, 'install.sh'))
    fs.writeFileSync(path.join(worktree, 'daemon', 'daemon.mjs'), '// staged fixture\n')
    fs.writeFileSync(path.join(worktree, 'bin', 'sab'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    for (const command of ['codex', 'tmux']) {
      fs.writeFileSync(path.join(fakeBin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), `#!/bin/sh
if [ "$1" = print ]; then
  printf '%s\n' 'path = /missing/si.sergej.claudeslackproxy.plist'
  printf '%s\n' 'working directory = ${liveBridge}'
  printf '%s\n' 'pid = 4242'
  exit 0
fi
exit 1
`, { mode: 0o755 })
    fs.writeFileSync(path.join(config, 'env'), 'SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n', { mode: 0o600 })

    const run = spawnSync('bash', [path.join(worktree, 'install.sh'), '--provider', 'codex', '--no-daemon-reload'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temp,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CCS_CONFIG_DIR: config,
        CCS_BIN_DIR: linkedBin,
        CODEX_HOME: codexHome,
        CCS_SKIP_DEPENDENCY_INSTALL: '1',
        CCS_SKIP_GIT_REMOTE_MIGRATION: '1',
      },
    })
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /loaded service|live installation/i)
    assert.equal(fs.existsSync(path.join(linkedBin, 'sab')), false)
    assert.equal(fs.existsSync(path.join(codexHome, 'hooks.json')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('piped staged activation checks the loaded target before any clone or pull', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-piped-preflight-'))
  try {
    const scriptDir = path.join(temp, 'download')
    const destination = path.join(temp, 'staged-destination')
    const liveBridge = path.join(temp, 'live-bridge')
    const fakeBin = path.join(temp, 'fake-bin')
    const gitMarker = path.join(temp, 'git-was-called')
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.mkdirSync(liveBridge, { recursive: true })
    fs.mkdirSync(fakeBin, { recursive: true })
    const downloaded = path.join(scriptDir, 'install.sh')
    fs.copyFileSync(new URL('../install.sh', import.meta.url), downloaded)
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), `#!/bin/sh
if [ "$1" = print ]; then
  printf '%s\n' 'working directory = ${liveBridge}'
  printf '%s\n' 'pid = 4242'
  exit 0
fi
exit 1
`, { mode: 0o755 })
    fs.writeFileSync(path.join(fakeBin, 'git'), `#!/bin/sh
printf called > '${gitMarker}'
exit 99
`, { mode: 0o755 })

    const run = spawnSync('bash', [downloaded, '--provider', 'codex', '--no-daemon-reload'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temp,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CCS_HOME: destination,
      },
    })
    assert.notEqual(run.status, 0)
    assert.match(`${run.stdout}\n${run.stderr}`, /loaded service|live installation/i)
    assert.equal(fs.existsSync(gitMarker), false, 'target verification must precede every Git mutation')
    assert.equal(fs.existsSync(destination), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('provider hook installation is idempotent and no-restart is isolated', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-bridge-install-'))
  try {
    const fakeBin = path.join(temp, 'fake-bin')
    const config = path.join(temp, 'config')
    const linkedBin = path.join(temp, 'linked-bin')
    const codexHome = path.join(temp, 'codex')
    const customBridge = path.join(temp, 'custom-install')
    const customInstaller = path.join(customBridge, 'install.sh')
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.mkdirSync(config, { recursive: true })
    fs.mkdirSync(linkedBin, { recursive: true })
    fs.mkdirSync(path.join(customBridge, 'daemon'), { recursive: true })
    fs.mkdirSync(path.join(customBridge, 'bin'), { recursive: true })
    fs.copyFileSync(new URL('../install.sh', import.meta.url), customInstaller)
    fs.writeFileSync(path.join(customBridge, 'daemon/daemon.mjs'), '// isolated installer fixture\n')
    fs.writeFileSync(path.join(customBridge, 'bin/sab'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    fs.symlinkSync('/legacy/sab-cc', path.join(linkedBin, 'sab-cc'))
    for (const command of ['claude', 'codex', 'pi', 'tmux']) {
      const executable = path.join(fakeBin, command)
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    }
    fs.writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(config, 'env'), [
      'SLACK_BOT_TOKEN=xoxb-test',
      'SLACK_APP_TOKEN=xapp-test',
      'SLACK_TEAM_ID=TTEST',
      '',
    ].join('\n'), { mode: 0o600 })

    const staleCheckout = path.join(temp, 'Code', 'SlackAgentBridge-old-worktree')
    const currentClaudeHook = path.join(customBridge, 'hooks/hook.sh')
    const currentCodexHook = path.join(customBridge, 'hooks/codex-hook.sh')
    const unrelatedClaude = '/opt/example/hooks/hook.sh'
    const unrelatedCodex = '/opt/example/hooks/codex-hook.sh'
    fs.mkdirSync(path.join(temp, '.claude'), { recursive: true })
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(path.join(temp, '.claude/settings.json'), JSON.stringify({ hooks: {
      SessionStart: [
        { matcher: '.*', hooks: [{ type: 'command', command: `${staleCheckout}/hooks/hook.sh` }] },
        { matcher: '.*', hooks: [{ type: 'command', command: currentClaudeHook }] },
        { matcher: '.*', hooks: [{ type: 'command', command: currentClaudeHook }] },
        { matcher: '.*', hooks: [{ type: 'command', command: unrelatedClaude }] },
      ],
    } }))
    fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: `${staleCheckout}/hooks/codex-hook.sh`, timeout: 3 }] },
        { hooks: [{ type: 'command', command: currentCodexHook, timeout: 3 }] },
        { hooks: [{ type: 'command', command: currentCodexHook, timeout: 3 }] },
        { hooks: [{ type: 'command', command: unrelatedCodex, timeout: 3 }] },
      ],
    } }))

    const env = {
      ...process.env,
      HOME: temp,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CCS_CONFIG_DIR: config,
      CCS_BIN_DIR: linkedBin,
      CODEX_HOME: codexHome,
      CCS_SKIP_DEPENDENCY_INSTALL: '1',
      CCS_SKIP_GIT_REMOTE_MIGRATION: '1',
    }
    for (let pass = 0; pass < 2; pass++) {
      const run = spawnSync('bash', [customInstaller, '--provider', 'all', '--no-daemon-reload'], {
        encoding: 'utf8', env,
      })
      assert.equal(run.status, 0, run.stderr || run.stdout)
    }

    const claude = JSON.parse(fs.readFileSync(path.join(temp, '.claude/settings.json'), 'utf8'))
    const codex = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'))
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
      const sab = claude.hooks[event].flatMap(group => group.hooks || [])
        .filter(hook => hook.command === currentClaudeHook)
      assert.equal(sab.length, 1, `duplicate Claude ${event} hook`)
    }
    for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'PermissionRequest']) {
      const sab = codex.hooks[event].flatMap(group => group.hooks || [])
        .filter(hook => hook.command === currentCodexHook)
      assert.equal(sab.length, 1, `duplicate Codex ${event} hook`)
    }
    assert.doesNotMatch(JSON.stringify(claude), /SlackAgentBridge-old-worktree/)
    assert.doesNotMatch(JSON.stringify(codex), /SlackAgentBridge-old-worktree/)
    assert.match(JSON.stringify(claude), new RegExp(unrelatedClaude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(JSON.stringify(codex), new RegExp(unrelatedCodex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.ok(fs.lstatSync(path.join(linkedBin, 'sab')).isSymbolicLink())
    assert.equal(fs.readlinkSync(path.join(linkedBin, 'sab')), path.join(customBridge, 'bin/sab'))
    for (const legacy of ['ccs', 'ccs-codex', 'ccs-spawn', 'ccs-window', 'sab-codex', 'sab-pi', 'sab-upload', 'sab-automation']) {
      assert.equal(fs.existsSync(path.join(linkedBin, legacy)), false, `${legacy} should not be installed`)
    }
    assert.equal(fs.readlinkSync(path.join(linkedBin, 'sab-cc')), '/legacy/sab-cc', 'staged install must preserve live 1.x launchers')
    assert.equal(fs.existsSync(path.join(temp, '.pi')), false, 'installer must not modify Pi global configuration')
    assert.equal(fs.existsSync(path.join(temp, 'Library/LaunchAgents')), false)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
