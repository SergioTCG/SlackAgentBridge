# Migrating to 2.5

Version 2.5 is a compatible upgrade from 2.4. It retains the existing Slack
app, `/sab-*` namespace, private channels, session state, tmux names,
`~/.config/ccs`, loopback port `8877`, and historical LaunchAgent label. No
state is bulk-migrated. The usage-limit handling runs only with
`CCS_ACCOUNT_POOLS=auto`. With pools off, or in shadow or manual mode, sessions
behave as in 2.4 apart from the two fixes at the end of the next section.

## What changes

- **Usage-limit handover of held work.** In auto mode, a session whose account
  is exhausted by its own measured usage now moves to a ready account in its
  group even while it holds work: a standing or delegated team task, an
  automation, or the turn the limit ended. In 2.4 the monitor skipped every such
  session, so team work stalled at the limit.
  - The task stays unchanged and is journaled as account maintenance
    (`taskMaintenance.kind: "usage-limit"`).
  - The interrupted turn is re-delivered once.
  - The coordinator sees an `accountHandovers` entry in its team inbox.
  - A handover that ends uncertain halts further usage-limit handovers until
    its channel is reconciled.
- **Claude's limit chooser.** SAB closes it with one Escape and never selects
  "Switch to usage credits".
- **Background shells.** Before such a restart, SAB stops the Claude Bash-tool
  shells that are still running and names their commands to the agent, which
  can restart the ones it still needs.
- **Restarts.** In auto mode, a daemon restart keeps a turn a usage limit
  paused, with its task, instead of failing it as an unproven idle turn. The
  SessionEnd that Claude sends when a handover closes its tmux no longer fails
  the task.
- **Resume in place.** When no other account has capacity, held work resumes on
  its own account once a newer usage reading shows capacity again, at most once
  per 30 minutes and without a restart. A session the owner or a collaborator
  drives waits for their next message.
- **New sessions.** In auto mode, `/sab-new`, `/spawn` and new automations
  start on an account with capacity instead of an exhausted native login.
  `/sab-new` and `/spawn` choose from the default group among accounts without
  a channel allowlist. Codex launches stay on the native login.
- **Codex.** Codex's limit notice is recognized, a limit-ended Codex turn is
  paused instead of reported as finished, and held Codex work moves to another
  Codex account with capacity or resumes in place. Unit tests cover this path;
  no live Codex canary has run.
- **Fixes in every mode.**
  - A resume keeps a 1M-context `[1m]` model even when Claude's status line
    reports the base model id.
  - A daemon restart no longer fails an active automation whose agent works in
    a subfolder of its launch directory. A record failed that way is restored
    at the next recovery.

[Account pools](account-pools.md#usage-limit-handover-of-held-work) has the
full rules.

## Slack manifest

Unchanged. There is no new command, OAuth scope, event, token or Slack app.

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

A 2.4 daemon ignores the new optional fields `usageLimitPause`,
`usageLimitResumedAt` and `accountHandovers`. Some state then fails closed:

- It cannot verify a `usage-limit` maintenance checkpoint. A usage-limit
  handover that is prepared, restarting or interrupted when it starts is never
  reconciled, and that channel's input stays fenced.
- After it starts, it fails a running delegated task whose worker a usage
  limit paused, as an unproven idle turn.
- Its monitor again leaves sessions that hold work on an exhausted account.
  A resume can again drop `[1m]`, and a restart can again fail an automation
  that works in a subfolder.

Before rolling back, let every usage-limit handover settle. Check with
`sab account pool status --channel ID --json` that none is prepared, restarting
or interrupted, and that no running task's worker is paused at a usage limit.

Then stop the daemon, return the live checkout to `v2.4.0`, run
`npm ci --omit=dev` and start the daemon again. Restore the configuration
backup only when the newer state itself is known to be damaged.

Never run the old and new daemons concurrently.
