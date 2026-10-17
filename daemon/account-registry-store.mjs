// Immutable private revisions + atomic publish, not a daemon state migration.
// Hard-link publication is an exclusive compare-and-swap on the next revision;
// no lock can strand staging after a process crash.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  AccountRegistryError, accountRegistryDigest, compileAccountRegistry,
  normalizeAccountEnrollment, publicAccountRegistry, validateStoredAccountRegistry,
} from './account-registry.mjs'
import { accountEditSchema, editAccountRegistry } from './account-management.mjs'

const fail = code => { throw new AccountRegistryError(code) }
const rootFor = configDir => path.join(configDir, 'account-pools')
const revisionPattern = /^revision-(\d{6})\.json$/

export function readPrivateAccountFile(file, { maxBytes = 1 << 20, missing = null, json = false } = {}) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('insecure_registry_file')
    if (stat.size > maxBytes) fail('registry_input_too_large')
    const buffer = Buffer.alloc(maxBytes + 1)
    let total = 0, count
    while (total <= maxBytes && (count = fs.readSync(fd, buffer, total, buffer.length - total, null)) > 0) total += count
    if (total > maxBytes) fail('registry_input_too_large')
    const text = buffer.toString('utf8', 0, total)
    if (!json) return text
    try { return JSON.parse(text) } catch { fail('invalid_registry_file') }
  } catch (error) {
    if (error.code === 'ENOENT') return missing
    if (error instanceof AccountRegistryError) throw error
    fail(error.code === 'ELOOP' ? 'insecure_registry_file' : 'registry_read_failed')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function checkDirectory(root) {
  let stat
  try { stat = fs.lstatSync(root) }
  catch (error) { if (error.code === 'ENOENT') return false; fail('registry_read_failed') }
  if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('insecure_registry_directory')
  return true
}

export function readAccountRegistry(configDir) {
  const root = rootFor(configDir)
  if (!checkDirectory(root)) return null
  const revisions = fs.readdirSync(root).filter(name => revisionPattern.test(name)).sort()
  if (!revisions.length) return null
  if (revisions.length > 4096 || revisions.some((name, index) => Number(name.match(revisionPattern)[1]) !== index + 1)) fail('invalid_registry_history')
  const latest = revisions.at(-1)
  const value = validateStoredAccountRegistry(readPrivateAccountFile(path.join(root, latest), { json: true, maxBytes: 4 << 20 }))
  if (value.revision !== revisions.length) fail('invalid_registry_history')
  return value
}

export function stageAccountRegistry(configDir, input, { legacyAccounts = '', expectedRevision,
  acceptSourceChange = false,
  afterPrepared, afterCommitted,
} = {}) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 4096) fail('expected_revision_required')
  const spec = normalizeAccountEnrollment(input)
  const digest = accountRegistryDigest(spec)
  const sourceDigest = accountRegistryDigest(legacyAccounts)
  const existing = readAccountRegistry(configDir)
  const alreadyApplied = value => {
    const receipt = value?.receipts.find(r => r.requestId === spec.requestId)
    if (!receipt) return null
    if (receipt.digest !== digest) fail('request_id_conflict')
    if (value.sourceDigest !== sourceDigest) fail('legacy_credentials_changed')
    return { status: 'already-staged', appliedRevision: receipt.revision, registry: publicAccountRegistry(value) }
  }
  const retry = alreadyApplied(existing)
  if (retry) return retry
  if ((existing?.revision || 0) !== expectedRevision) fail('revision_conflict')
  const value = compileAccountRegistry(spec, { legacyAccounts, prior: existing, acceptSourceChange })
  const root = rootFor(configDir)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  checkDirectory(root)
  const temp = path.join(root, `.pending-${crypto.randomUUID()}.json`)
  const destination = path.join(root, `revision-${String(value.revision).padStart(6, '0')}.json`)
  let fd
  try {
    const bytes = JSON.stringify(value) + '\n'
    if (Buffer.byteLength(bytes) > (4 << 20)) fail('registry_input_too_large')
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    afterPrepared?.()
    try { fs.linkSync(temp, destination) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const winner = readAccountRegistry(configDir)
      const accepted = alreadyApplied(winner)
      if (accepted) return accepted
      fail('revision_conflict')
    }
    // File bytes precede publication; sync the directory entry where supported.
    let dir
    try { dir = fs.openSync(root, 'r'); fs.fsyncSync(dir) }
    catch (error) { if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error }
    finally { if (dir !== undefined) fs.closeSync(dir) }
    afterCommitted?.()
    return { status: 'staged', appliedRevision: value.revision, registry: publicAccountRegistry(value) }
  } catch (error) {
    if (error instanceof AccountRegistryError) throw error
    fail('registry_write_failed')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    // Only this invocation's unpredictable, exclusive temporary file is removed.
    try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw new AccountRegistryError('registry_cleanup_failed') }
  }
}

export function manageAccountRegistry(configDir, input, { legacyAccounts = '', usage = {} } = {}) {
  const parsed = accountEditSchema.safeParse(input)
  if (!parsed.success) fail('invalid_account_edit')
  const { expectedRevision, requestId } = parsed.data
  const current = readAccountRegistry(configDir)
  if (!current) fail('registry_not_staged')
  const duplicate = current.receipts.find(r => r.requestId === requestId)
  if (!duplicate && current.revision !== expectedRevision) fail('revision_conflict')
  if (expectedRevision < 1 || expectedRevision > current.revision) fail('revision_conflict')
  const base = expectedRevision === current.revision ? current : validateStoredAccountRegistry(readPrivateAccountFile(
    path.join(rootFor(configDir), `revision-${String(expectedRevision).padStart(6, '0')}.json`), { json: true, maxBytes: 4 << 20 }))
  // A retry derives the original policy bytes from its immutable base, then
  // compares the receipt digest. It never re-applies the edit to newer policy.
  const spec = editAccountRegistry(base, parsed.data, { usage: duplicate ? {} : usage })
  return stageAccountRegistry(configDir, spec, { legacyAccounts, expectedRevision })
}
