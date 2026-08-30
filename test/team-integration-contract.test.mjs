import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const cli = fs.readFileSync(new URL('../scripts/sab-team.mjs', import.meta.url), 'utf8')
const teamModules = ['teams.mjs', 'team-auth.mjs', 'team-files.mjs', 'team-http.mjs']
  .map(file => fs.readFileSync(new URL(`../daemon/${file}`, import.meta.url), 'utf8'))
  .join('\n')

test('all provider-stable final paths complete the exact delegated team task', () => {
  for (const fn of ['finalizeTurn', 'finalizeCodexTurn', 'finalizePiTurn']) {
    const body = new RegExp(`async function ${fn}\\([\\s\\S]*?\\n}`, 'm').exec(daemon)?.[0] || ''
    assert.match(body, /finishTeamTaskForSession/, `${fn} lost team final correlation`)
  }
  assert.match(daemon, /await failTeamTaskForSession\(session, 'The worker session ended/)
  assert.match(daemon, /session\.teamActiveTaskId.*delegated team task in progress|teamActiveTaskId/s)
})

test('team tools remain provider-neutral and cannot acquire Slack credentials or history', () => {
  assert.doesNotMatch(cli, /SLACK_(?:BOT|APP)_TOKEN|channel_id/)
  assert.doesNotMatch(teamModules, /conversations\.history|SLACK_(?:BOT|APP)_TOKEN/)
  assert.match(daemon, /validTeamCallerBinding/)
  assert.match(daemon, /beginCollaboratorTeamTurn/)
  assert.match(daemon, /beginOwnerTeamTurn/)
  assert.match(daemon, /handleTeamHttp\(req, res, url, teamService\)/)
})

test('team task injection is journal-first and uncertain claims are not replayed', () => {
  const claim = daemon.indexOf('claimTeamTask(state, task.id')
  const persist = daemon.indexOf('saveStateNow(state)', claim)
  const inject = daemon.indexOf('injectText(target, prompt', claim)
  assert.ok(claim > 0 && persist > claim && inject > persist)
  assert.match(daemon, /Delivery became uncertain[\s\S]*SAB did not retry it to avoid duplicate work/)
  assert.match(daemon, /startTeamReconciler\(\) \/\/ status adoption must fence workers/)
})

test('team file relay journals an in-flight claim before every Slack upload', () => {
  for (const marker of ['task.fileDeliveryStatus = \'uploading\'', 'reply.fileDeliveryStatus = \'uploading\'']) {
    const claim = daemon.indexOf(marker)
    const persist = daemon.indexOf('saveStateNow(state)', claim)
    const upload = daemon.indexOf('await uploadTeamFiles(', claim)
    assert.ok(claim > 0 && persist > claim && upload > persist)
  }
  assert.match(daemon, /outcome became uncertain during daemon restart; SAB did not retry it to avoid duplicate delivery/g)
})
