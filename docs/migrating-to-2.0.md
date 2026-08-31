# Migrating to 2.0

Version 2.0 deliberately consolidates the local and Slack control surfaces and
separates provider lifetime from terminal-window lifetime. It is a breaking
command-interface release, not a state reset.

## What changes

- `sab` is the only public local executable.
- Start providers with `sab new claude`, `sab new codex`, or `sab new pi`.
- Accounts, artifacts, automation, and terminals are `sab account`,
  `sab upload`, `sab team`, `sab automation`, and `sab terminal`.
- Slack uses only `/sab-*`. The provider comes from the active session channel;
  `/sab-new` and `/sab-switch` take an explicit provider.
- Sessions start headlessly in tmux. Ghostty windows are optional viewports.
  Closing a window detaches it without stopping the provider.

The installer removes symlinks for the 1.x launchers. Scripts that call `ccs`,
`ccs-codex`, `ccs-spawn`, `ccs-window`, `sab-cc`, `sab-codex`, `sab-pi`,
`sab-upload`, or `sab-automation` must be updated before rollout.

## What remains compatible

- `~/.config/ccs`, `CCS_*`, state shape, accounts, handoffs, and port `8877`
- records without a provider, which still mean Claude
- historical `ccs-*` tmux names already stored in state
- existing private channels and immutable channel IDs
- existing `~/.claudeslackproxy` checkouts
- the existing Slack app, tokens, control channel, and
  `si.sergej.claudeslackproxy` LaunchAgent label

Do not create a second Slack app or load a second LaunchAgent.

## Slack manifest migration

Apply [`slack/app-manifest.json`](../slack/app-manifest.json) to the **existing**
Slack app and reinstall that app once. The current manifest registers the 18 `/sab-*` commands
and removes the 1.x provider-prefixed commands. No new OAuth scope or token is
required.

The v2 daemon has an unadvertised parser shim for old slash-command payloads so
a short manifest/daemon ordering gap fails less abruptly. This is not a public
compatibility promise and old commands are absent from help and the canonical
manifest.

## Safe upgrade sequence

1. Update repository scripts and personal automation to use `sab` subcommands.
2. Record the current release tag and back up `~/.config/ccs` with restrictive
   permissions.
3. Ensure the release commit is clean and complete every automated item in
   [`docs/release-checklist.md`](release-checklist.md).
4. Apply the canonical manifest to the existing Slack app and reinstall it.
5. Choose a maintenance window and confirm that no provider switch or
   automation launch is in its transactional phase.
6. Roll the one historical LaunchAgent. Do not start another daemon with the
   same Socket Mode token.
7. Run the controlled canary for existing and new Claude, Codex, and Pi
   sessions, including terminal open/close and headless Slack messaging.
8. Keep the previous tag and backup until acceptance.

Existing active provider processes remain inside their current tmux sessions
through the daemon restart. On boot the v2 daemon re-adopts valid sessions and
active working timers. Existing attached terminals remain usable. Thereafter,
closing them no longer ends their providers.

## Command mapping

| 1.x | 2.0 |
|---|---|
| provider launcher | `sab new <provider>` |
| provider-specific `*-new` | `/sab-new <provider>` |
| provider-specific model/effort/flags/update/stop/status/usage/kill/help | matching `/sab-*` command in that session channel |
| update every idle active provider session | `/sab-update all` from the control channel or any session channel |
| provider-specific switch | `/sab-switch <target>` |
| Pi managed-run command | `/sab-run` |
| Claude account command | `sab account` / `/sab-account` |
| artifact helper | `sab upload` |
| automation helper | `sab automation` |
| session-team helper | `sab team` / `/sab-team` |
| window helper | `sab terminal` / `/sab-terminal` |

## Rollback

If the v2 canary fails, stop the sole daemon, restore the recorded 1.x release
and config backup, restore the 1.x Slack manifest if command access is needed,
then load the same historical LaunchAgent. Do not leave v1 and v2 daemons
running together. Closing or opening terminal viewports is not a rollback
mechanism and must not be used to terminate sessions.
