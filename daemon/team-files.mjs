import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveArtifactFiles } from './artifacts.mjs'
import { TeamError } from './teams.mjs'

const FILE_ID_RE = /^(?:task|reply)_[A-Za-z0-9_-]+$/

export function teamFilesRoot(configDir, id) {
  if (!FILE_ID_RE.test(String(id || ''))) {
    throw new TeamError('invalid_file_identity', 'Invalid team file identity.')
  }
  return path.join(configDir, 'team-files', id)
}

function fileSha256(filename) {
  const digest = crypto.createHash('sha256')
  const fd = fs.openSync(filename, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (!read) break
      digest.update(buffer.subarray(0, read))
    }
  } finally { fs.closeSync(fd) }
  return digest.digest('hex')
}

export function teamSourceFileMetadata(workspaceRoot, requestedPaths) {
  return resolveArtifactFiles(workspaceRoot, requestedPaths)
    .map(file => ({ ...file, sha256: fileSha256(file.path) }))
}

export function stageTeamFiles(configDir, workspaceRoot, requestedPaths, id) {
  if (!requestedPaths?.length) return []
  const source = teamSourceFileMetadata(workspaceRoot, requestedPaths)
  const directory = teamFilesRoot(configDir, id)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(directory, 0o700) } catch {}
  try {
    return source.map((file, index) => {
      const destination = path.join(directory, `${String(index + 1).padStart(2, '0')}-${file.filename}`)
      fs.copyFileSync(file.path, destination)
      fs.chmodSync(destination, 0o600)
      if (fs.statSync(destination).size !== file.size || fileSha256(destination) !== file.sha256) {
        throw new TeamError('source_file_changed', 'A team file changed while SAB was staging it. Retry after the file is stable.', 409)
      }
      return {
        path: destination, filename: file.filename, size: file.size, sha256: file.sha256,
      }
    })
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function removeTeamFiles(configDir, id) {
  fs.rmSync(teamFilesRoot(configDir, id), { recursive: true, force: true })
}

export function removeTeamTaskFiles(configDir, task) {
  removeTeamFiles(configDir, task.id)
  for (const reply of task.replies || []) removeTeamFiles(configDir, reply.id)
}
