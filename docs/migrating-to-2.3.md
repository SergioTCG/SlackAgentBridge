# Migrating to 2.3

Version 2.3 is a compatible upgrade from 2.2. It retains the existing Slack
app, `/sab-*` namespace, private channels, session state, tmux names,
`~/.config/ccs`, loopback port `8877`, and historical LaunchAgent label. No
state is bulk-migrated and nothing new is activated by the upgrade.

## What changes

- **Named automation channels.** `sab automation create --channel-name NAME`
  creates the private channel under exactly that Slack name before anything is
  launched. A taken name fails with `channel_name_taken`; nothing is journaled,
  so the same external key may be retried with another name. Automations
  without `--channel-name` keep the historical `<repo>-<branch>-<stamp>` name.
- **Automations that start inside a team.** From its own owner or automatic
  turn, a team's coordinator may run `sab automation create --team TEAM
  [--alias ALIAS] [--task-file FILE]`. The new channel joins the team as a
  worker, with recorded provenance, and `--task-file` becomes its first team
  task, delivered as the initial prompt after collaborator setup. The call
  consumes one dispatch and can never add an existing channel. It must run
  inside the coordinator's live SAB session, inheriting `CCS_BRIDGE`,
  `CCS_TMUX` and `CCS_PROVIDER`.
- **Stop.** `sab automation stop KEY` now also removes the stopped channel's
  team membership, cancelling only that membership's active tasks, and closes a
  team it coordinated. Task history and Slack audit cards remain.
- **Retries.** A named or team-bound automation must be retried with the
  identical request, or it fails with `external_key_conflict`. Plain
  automations keep their historical replay.
- **1M-context Claude models.** Launch flags accept the exact `[1m]` suffix,
  for example `--model 'claude-opus-5-5[1m]'` (quote it in an interactive
  shell; argv from a script needs no quoting).
- **Account pools.** An idle Claude session whose terminal shows a queued
  feedback-draft card is no longer refused an automatic handover. The card
  hides the footer that SAB's idle check looked for. A handover refused before
  teardown is retried after 15 minutes, doubling up to four hours, instead of
  on every monitor tick. Its single notice names the cause. Explicit
  `/sab-account` switches are unaffected.

## Slack manifest

Unchanged. No new command, OAuth scope, event, token or Slack app.

## Controlled upgrade

Installations that follow `main` with the default self-update receive this
code within six hours. To upgrade deliberately instead:

1. Let provider switches, team dispatches and automation launches reach a safe
   boundary.
2. Record the current release tag and create a private, permission-preserving
   backup of `~/.config/ccs`.
3. Fast-forward the one checkout named by the loaded
   `si.sergej.claudeslackproxy` LaunchAgent. `package.json` dependencies did
   not change.
4. Restart that LaunchAgent and confirm that sessions are re-adopted.

## Rollback

Stop or finish any team-bound automation that is still being created before
rolling back. A 2.2 daemon ignores the new optional fields. It would deliver a
held bootstrap task without waiting for collaborator setup, and it does not
count worker reservations toward the member limit.

Then stop the daemon, return the live checkout to `v2.2.0`, run
`npm ci --omit=dev` and start the daemon again. Restore the configuration
backup only when the newer state itself is known to be damaged.

Never run the old and new daemons concurrently.
