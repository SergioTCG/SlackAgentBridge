import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  removeTeamTaskFiles, stageTeamFiles, teamFilesRoot, teamSourceFileMetadata,
} from '../daemon/team-files.mjs'

test('team files are workspace-contained, hashed, copied privately, and exactly removable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-team-files-'))
  try {
    const config = path.join(root, 'config')
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    const source = path.join(workspace, 'report.txt')
    fs.writeFileSync(source, 'bounded report')
    const expectedHash = crypto.createHash('sha256').update('bounded report').digest('hex')

    const metadata = teamSourceFileMetadata(workspace, [source])
    assert.equal(metadata[0].sha256, expectedHash)
    const staged = stageTeamFiles(config, workspace, [source], 'task_example')
    assert.equal(staged[0].sha256, expectedHash)
    assert.equal(fs.readFileSync(staged[0].path, 'utf8'), 'bounded report')
    assert.equal(fs.statSync(staged[0].path).mode & 0o777, 0o600)

    const reply = stageTeamFiles(config, workspace, [source], 'reply_example')
    removeTeamTaskFiles(config, { id: 'task_example', replies: [{ id: 'reply_example' }] })
    assert.equal(fs.existsSync(staged[0].path), false)
    assert.equal(fs.existsSync(reply[0].path), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('team file staging rejects escaped paths, symlink escapes, and forged identities', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sab-team-files-'))
  try {
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(workspace)
    const outside = path.join(root, 'outside.txt')
    fs.writeFileSync(outside, 'secret')
    fs.symlinkSync(outside, path.join(workspace, 'escape.txt'))
    assert.throws(() => stageTeamFiles(path.join(root, 'config'), workspace, [outside], 'task_one'),
      error => error.code === 'path_outside_workspace')
    assert.throws(() => stageTeamFiles(path.join(root, 'config'), workspace, [path.join(workspace, 'escape.txt')], 'task_one'),
      error => error.code === 'path_outside_workspace')
    assert.throws(() => teamFilesRoot(path.join(root, 'config'), '../../escape'),
      error => error.code === 'invalid_file_identity')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
