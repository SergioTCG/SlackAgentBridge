#!/usr/bin/env node
// Private runner pipe, NOT a public command. stdout is captured only inside
// run-session.sh; do not invoke this for inspection or forward its output.
import { readLegacyClaudeToken } from '../daemon/account-credentials.mjs'
try { process.stdout.write(readLegacyClaudeToken(process.env.CCS_CONFIG_DIR, process.env.CCS_ACCOUNT)) }
catch { process.stderr.write('sab: requested account credentials are missing, conflicting, or insecure; refusing machine-login fallback.\n'); process.exitCode = 1 }
