#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
const manifest = JSON.parse(read('slack/app-manifest.json'))
const readme = read('README.md')
const installer = read('install.sh')
const failures = []
const requireCheck = (condition, message) => { if (!condition) failures.push(message) }

requireCheck(pkg.name === 'slack-agent-bridge', 'package name is not provider-neutral')
requireCheck(/^2\.\d+\.\d+(?:-rc\.\d+)?$/.test(pkg.version), 'package version is not a 2.x release')
requireCheck(lock.version === pkg.version && lock.packages?.['']?.version === pkg.version, 'package lock version does not match package version')
requireCheck(pkg.repository.url.endsWith('/SlackAgentBridge.git'), 'package repository URL is stale')
requireCheck(pkg.engines.node === '>=20', 'package Node minimum does not match Slack SDK requirements')
requireCheck(readme.startsWith('# Slack Agent Bridge\n'), 'README title is stale')
requireCheck(manifest.display_information.name === 'Slack Agent Bridge', 'Slack app display name is stale')
requireCheck(manifest.features.bot_user.display_name === 'Clavdivs', 'bot personality changed unexpectedly')
requireCheck(installer.includes('SergioTCG/SlackAgentBridge.git'), 'installer clone URL is stale')
requireCheck(installer.includes('.claudeslackproxy'), 'installer lost legacy checkout detection')
requireCheck(installer.includes('si.sergej.claudeslackproxy'), 'installer lost the compatible LaunchAgent label')
requireCheck(readme.includes('`sab`') && readme.includes('sab new claude') && readme.includes('sab new codex') && readme.includes('sab new pi'), 'README does not document the single CLI')
requireCheck(readme.includes('sab terminal') && readme.includes('sab upload') && readme.includes('sab automation'), 'README does not document sab subcommands')
requireCheck(fs.readdirSync(path.join(root, 'bin')).filter(name => !name.startsWith('.')).join(',') === 'sab', 'bin contains a public executable other than sab')
requireCheck(manifest.features.slash_commands.length === 18 && manifest.features.slash_commands.every(item => item.command.startsWith('/sab-')), 'manifest is not the unified 18-command namespace')
requireCheck(!fs.existsSync(path.join(root, 'spike/slack-app-manifest.yaml')), 'stale YAML manifest still exists')

for (const command of manifest.features.slash_commands.map(item => item.command)) {
  requireCheck(readme.includes(`\`${command}`), `README does not document ${command}`)
}
for (const file of ['AGENTS.md', 'CLAUDE.md', 'docs/migrating-to-1.0.md', 'docs/migrating-to-1.1.md', 'docs/migrating-to-1.2.md', 'docs/migrating-to-1.3.md', 'docs/migrating-to-1.4.md', 'docs/migrating-to-1.5.md', 'docs/migrating-to-2.0.md', 'docs/pi-feasibility.md', 'docs/release-checklist.md']) {
  requireCheck(fs.existsSync(path.join(root, file)), `missing ${file}`)
}

if (failures.length) {
  console.error(failures.map(item => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('Branding and compatibility contract checks passed.')
