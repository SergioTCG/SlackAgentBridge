# Migrating to 2.2

Version 2.2 is a compatible upgrade from 2.1. It retains the existing Slack
app, `/sab-*` namespace, private channels, session state, tmux names,
`~/.config/ccs`, loopback port `8877`, and historical LaunchAgent label. No
state is bulk-migrated and nothing new is activated by the upgrade.

## What changes

- **Account pools (opt-in).** `CCS_ACCOUNT_POOLS=shadow|manual|auto` adds
  account-bound quota sampling and guarded handover between Claude or Codex
  subscriptions. It stays `off` unless you set it. Full Claude logins are
  enrolled with `sab account login-claude PROFILE`, and accounts and groups are
  managed with `sab account group`, `sab account manage` and `/sab-account`.
  Follow [Account pools](account-pools.md), including its controlled canary,
  before choosing `manual` or `auto`.
- **Session teams.** New tasks use two-phase completion: a provider final is a
  worker report, and the task is released only after its declared gates clear,
  the worker declares readiness and the coordinator releases it. `sab team`
  gains `checkpoint`, `complete`, `release`, `continue` and `mutation`. Tasks
  created before the upgrade keep their historical provider-final behavior.
- **Updates.** `/sab-update claude-code`, `codex` and `pi` update one provider.
- **Automation.** `sab automation release` hands a completed bootstrap back to
  normal session maintenance, and `sab automation validate-flags` checks
  launch flags before a script relies on them.
- **Lifecycle.** A switch to Claude Code no longer rolls back when Claude
  formats its readiness reply in Markdown. Records of archived session channels
  are removed at startup and hourly. Artifact grants are redacted from all
  outbound Slack text.

Claude Code deletes conversations that stay idle longer than its
`cleanupPeriodDays` setting (30 days by default). SAB now says so when such a
channel cannot be resumed, and `/sab-switch claude new` replaces a standby
Claude leg whose conversation is gone. Raise `cleanupPeriodDays` in
`~/.claude/settings.json` if you keep channels dormant for longer.

## Slack manifest

Only the `/sab-update` usage hint changed. Re-applying
[`slack/app-manifest.json`](../slack/app-manifest.json) to the existing app is
optional and refreshes that autocomplete hint. No new OAuth scope, event, token
or Slack app is required.

## Controlled upgrade

Installations that follow `main` with the default self-update already run this
code or receive it within six hours. The daemon fast-forwards, refreshes
dependencies and restarts between turns. To upgrade deliberately instead:

1. Let critical provider turns, team dispatches and provider switches reach a
   safe boundary.
2. Record the current release tag and create a private, permission-preserving
   backup of `~/.config/ccs`.
3. Fast-forward the one checkout named by the loaded
   `si.sergej.claudeslackproxy` LaunchAgent and run `npm ci --omit=dev` there.
   Never start a second Socket Mode daemon with the same app token.
4. Restart that LaunchAgent and confirm that sessions are re-adopted.

Hook registrations and the `sab` link are unchanged, so the installer does not
need to run again.

## Rollback

First set `CCS_ACCOUNT_POOLS=off`, and move every session that runs on a full
`login-claude` or `login-codex` profile back to its native login. Version 2.1
does not know those profiles and cannot resume sessions bound to them. Then
stop the daemon, return the live checkout to `v2.1.0`, run `npm ci --omit=dev`
and start the daemon again. Restore the configuration backup only when the
newer state itself is known to be damaged.

Never run the old and new daemons concurrently.
