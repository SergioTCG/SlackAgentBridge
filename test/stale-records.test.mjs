import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { archivedTeams, dormantChannelCandidates, orphanSessionIds } from '../daemon/stale-records.mjs'

const daemon = fs.readFileSync(new URL('../daemon/daemon.mjs', import.meta.url), 'utf8')
const alive = session => Boolean(session?.pid)

const fixture = () => ({
  control: 'CCTRL',
  sessions: {
    ctl: { id: 'ctl', channel: 'CCTRL' },
    stopped: { id: 'stopped', channel: 'C1' },
    running: { id: 'running', channel: 'C2', pid: 1 },
    claude: { id: 'claude', channel: 'C3' },
    codex: { id: 'codex', channel: null, pid: 2 },
    switching: { id: 'switching', channel: 'C4' },
    target: { id: 'target', channel: null },
    worker: { id: 'worker', channel: 'C5' },
    owned: { id: 'owned', channel: 'C6' },
    released: { id: 'released', channel: 'C7' },
    handover: { id: 'handover', channel: 'C8' },
    handedOver: { id: 'handedOver', channel: 'C9' },
    standby: { id: 'standby', channel: null },
    orphan: { id: 'orphan', channel: null },
    staleChannel: { id: 'staleChannel', channel: 'C1' },
    liveOrphan: { id: 'liveOrphan', channel: null, pid: 3 },
  },
  channels: {
    CCTRL: 'ctl', C1: 'stopped', C2: 'running', C3: 'claude', C4: 'switching', C5: 'worker',
    C6: 'owned', C7: 'released', C8: 'handover', C9: 'handedOver', C10: 'missing',
  },
  lineages: {
    C3: { legs: { claude: 'claude', codex: 'codex', pi: null }, transition: null },
    C4: { legs: { claude: 'switching', codex: null, pi: null }, transition: { source: { sid: 'switching' }, target: { sid: 'target' } } },
    C9: { legs: { claude: 'handedOver', codex: 'standby', pi: null }, transition: null },
  },
  teams: {},
  teamTasks: {
    done: { id: 'done', status: 'completed', sourceChannel: 'C1', targetChannel: 'C1', targetSessionId: 'orphan' },
    open: { id: 'open', status: 'awaiting_release', sourceChannel: 'CX', targetChannel: 'C5', targetSessionId: 'worker' },
  },
  automations: {
    owner: { status: 'active', channelId: 'C6', sessionId: 'owned' },
    gone: { status: 'released', channelId: 'C7', sessionId: 'released' },
  },
  accountPools: { switches: { C8: { phase: 'interrupted' }, C9: { phase: 'committed' } } },
})

test('only channels whose every session is stopped and unused are archive candidates', () => {
  const candidates = dormantChannelCandidates(fixture(), { alive })
  // Not CCTRL (control), C2 (running), C3 (live standby Codex leg), C4
  // (switching), C5 (active team task), C6 (owning automation) or C8
  // (uncertain account handover). A mapping to a missing record also qualifies.
  assert.deepEqual(candidates, ['C1', 'C7', 'C9', 'C10'])
})

test('a team closes only when Slack reports every one of its channels archived', () => {
  const state = {
    teams: {
      gone: { id: 'gone', members: { C1: {}, C2: {} } },
      partly: { id: 'partly', members: { C1: {}, C3: {} } },
      closed: { id: 'closed', closedAt: '2026-10-25T00:00:00.000Z', members: { C1: {} } },
      empty: { id: 'empty', members: {} },
    },
    teamTasks: {},
  }
  assert.deepEqual(archivedTeams(state, new Set(['C1', 'C2'])).map(team => team.id), ['gone'])
})

test('stopped records nothing can reach are orphans', () => {
  // `standby` is a lineage leg, `target` a provider switch's target, `worker`
  // and `owned` are held by an active task and automation, and `liveOrphan`
  // still runs. A record that lost its channel mapping is unreachable.
  assert.deepEqual(orphanSessionIds(fixture(), { alive }), ['orphan', 'staleChannel'])
})

test('the daemon drops archived channels only after rechecking them, and spares open teams', () => {
  const sweep = /async function sweepArchivedChannels\(\) \{([\s\S]*?)\n\}\n/.exec(daemon)?.[1] || ''
  assert.match(sweep, /nodeIdForSession\(session\) !== LOCAL_NODE_ID\) return true \} catch \{ return true \}/)
  assert.match(sweep, /await tmuxAlive\(session\.tmux\)\) liveTmux\.add\(session\.tmux\)/)
  assert.match(sweep, /liveTmux\.has\(session\.tmux\) \|\|\s*resurrectInFlight\.has\(session\.id\) \|\| restarting\.has\(session\.id\)/)
  assert.match(sweep, /web\.conversations\.info\(\{ channel \}\)[\s\S]*?info\.channel\?\.is_archived/)
  assert.match(sweep, /const stillDormant = new Set\(dormantChannelCandidates\(state, \{ alive \}\)\)/)
  assert.match(sweep, /archivedTeams\(state, archived\)[\s\S]*?closeTeam\(state, team\.id\)[\s\S]*?activeTeamForChannel\(state, channel\)\) continue \} catch \{ continue \}\s*deleteLineage\(state, channel\)\s*deleteHandoffs\(CONFIG_DIR, channel\)/)
  assert.match(sweep, /orphanSessionIds\(state, \{ alive \}\)\s*for \(const sid of orphans\) delete state\.sessions\[sid\]/)
  assert.match(daemon, /setTimeout\(\(\) => sweepArchivedChannels\(\)[\s\S]{0,120}2 \* 60000\)/)
  assert.match(daemon, /setInterval\(\(\) => sweepArchivedChannels\(\)[\s\S]{0,120}60 \* 60000\)/)
})

test('/sab-cleanup drops the records of a channel already archived in Slack', () => {
  assert.match(daemon, /if \(e\?\.data\?\.error !== 'already_archived'\) \{ log\('archive failed'[\s\S]{0,80}continue \}\s*\}\s*deleteLineage\(state, s\.channel\)/)
})
