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

## 2.5.1

Version 2.5.1 is a compatible fix release from 2.5.0. The Slack manifest and
hooks are unchanged, and no session state is migrated. It adds optional fields
only: `session.teamPeerTurn`, `peerMessage` on a task report, and `origin` of
kind `peer` on a task reply.

What you will notice:

- **Reports carry the answer.** A coordinator gets a Claude worker's final answer
  in every generation of a task, so reports are longer and fewer tasks finish
  `completed_with_warning`.
- **Provider failures.** A provider failure the poller detects, such as an
  overload Claude Code ends with no Stop, now fails the task in later generations
  too, as it already did in the first. `sab team continue` recovers it.
- **Messages from other Claude sessions.** A worker keeps its task when one
  arrives. Until that turn ends or the coordinator speaks, gate changes and
  completion are refused with `peer_turn_denied`, and the worker's replies carry
  `origin` `peer` and wake no one.
- **Sign-in notices.** The control channel now hears about every Claude login
  whose renewal fails, including the Mac's own. A login that needs a new sign-in
  reads `needs-login`, where it used to read `credential-unavailable`, and its
  notice names the command to run.

To upgrade:

- Installations that follow `main` with the default self-update receive this code
  within six hours. The version change makes that update run
  `npm ci --omit=dev`, which also brings in the `@hono/node-server` fix.
- To upgrade deliberately, follow the controlled upgrade above, and run
  `npm ci --omit=dev` after the fast-forward because the lockfile moved.

After the upgrade:

- **A worker that already held a task.** It can keep reporting empty turns, with a
  warning, until its coordinator next messages it, because 2.5.0 could leave its
  transcript position behind the task's latest generation. Its answer stays unread
  and reaches the channel once that message arrives, or with its next turn after
  the task is released. A daemon restart while the worker is idle skips it, as it
  does any unread text.
- **The daemon log.** It moves to `~/.config/ccs/daemon.log` only when `install.sh`
  runs with a daemon reload. A self-update leaves it where it is. A checkout on an
  external disk needs that run if the LaunchAgent exits with code 78.

To roll back, stop the daemon, return the live checkout to `v2.5.0`, run
`npm ci --omit=dev` and start the daemon again. That brings back what 2.5.1 fixes,
including the renewal that loses an idle Claude profile's sign-in after one
refresh. A 2.5.0 daemon ignores the fields above, so a reply labelled `peer` reads
as `worker`, and a report flagged for another session's message can be
auto-released.

## 2.5.2

Version 2.5.2 is a compatible fix release from 2.5.1. The Slack manifest and
hooks are unchanged, and no session state is migrated. It adds optional fields
only: `launchChecks`, `waitingNotices` and `nativeIdentity` under
`accountPools`; `measured`, `move` and `waiting` on a session's
`sab account pool status`, and `launch` on each of its accounts; and `reason` on
an `account_switch_blocked` refusal.

What you will notice:

- **Automatic moves need no earlier hand-made move.** A move needs fresh
  measured capacity on the target, its verified identity, and evidence less than
  a day old that its login starts: a session start on it, a committed switch
  onto it, or SAB's own launch check. That check starts Claude with no prompt in
  a hidden `ccs-probe-*` terminal, one login at a time, and closes it again. A
  login stopped by a sign-in, terms, first-run, Chrome or permissions screen is
  reported to the owner with the command to open it.
- **Waits are reported.** A session at its account's usage limit that cannot
  move has its reason logged and shown in `/sab-account`. The owner hears once
  per account and reason: after 2 minutes when no account has capacity, with
  the time the first one regains it; after 5 minutes when a launch check has not
  passed; after 15 minutes when a safe-boundary rule blocks the move; and at
  once when usage-limit moves are halted.
- **The Mac's own login.** When `~/.claude.json` shows the Mac's own Claude
  login on another account than the one listed as `native-default`, the owner
  hears once, and new sessions start through a profile instead.
- **Turns a limit ends.** Claude Code 2.1.318's `⚠ Usage limit reached` banner
  is read as a limit. A Claude turn that a limit ends before its first spinner no
  longer reads as running: held work on an account the pool measured exhausted
  is paused for the handover or the reset, held work that Claude continues by
  itself waits for that, and any other turn ends.
- **Owner switches at a limit.** In auto mode, `/sab-account`, the account
  picker and `sab account pool switch` take the usage-limit path for a session
  stopped at its limit, instead of refusing it as busy until `/sab-kill`. Any
  other refusal names the rule it hit.
- **Automation stops.** An automation's record follows its session across
  resumes, account switches and reboots, and the boot heals stale ones. A stop
  that failed as non-exact can be repeated after the upgrade.
- **The installer.** Its staged-activation check gives its refusal, instead of
  stopping with no output, when a read of the loaded service is slow or fails.

To upgrade:

- Installations that follow `main` with the default self-update receive this
  code within six hours. The version change makes that update run
  `npm ci --omit=dev`, though no dependency moves.
- To upgrade deliberately, follow the controlled upgrade above. The lockfile
  changes only in its version, so `npm ci --omit=dev` is optional.

After the upgrade:

- **The first moves can wait for launch checks.** At first, only committed,
  identity-verified switches at the current registry revision count as
  evidence. Any other Claude login gets a launch check before work moves to it,
  so a session at its limit right after the restart can wait for that check,
  with a notice after 5 minutes. A Codex login earns evidence only from a real
  session start on it, and a legacy token never does.
- **Notices for waits already under way.** A session that is already waiting at
  the restart is reported once its delay passes, and so is the Mac's own login
  if it differs from the registry.

To roll back, stop the daemon, return the live checkout to `v2.5.1` and start the
daemon again. No dependency changed. That brings back what 2.5.2 fixes,
including automatic moves that wait without a word for an earlier hand-made move
between the same two accounts, and a Claude turn that reads as running after a
limit ended it. A 2.5.1 daemon ignores the new `accountPools` fields.
