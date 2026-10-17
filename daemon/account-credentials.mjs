import path from 'node:path'
import { readPrivateAccountFile } from './account-registry-store.mjs'

// Internal only. Token bytes may enter a provider environment or telemetry
// request, never argv, ordinary state, logs, Slack, or public inspection JSON.
export function readLegacyClaudeToken(configDir, alias) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias || '')) throw new Error('invalid_account_reference')
  const text = readPrivateAccountFile(path.join(configDir, 'accounts'), { missing: '' })
  const tokens = text.split(/\r?\n/).filter(line => line.startsWith(`${alias}=`)).map(line => line.slice(alias.length + 1))
  if (new Set(tokens).size !== 1 || typeof tokens[0] !== 'string' || !tokens[0].trim() || tokens[0].length > 65536 || /[\r\n\0]/.test(tokens[0])) throw new Error('account_credential_unavailable')
  return tokens[0]
}
