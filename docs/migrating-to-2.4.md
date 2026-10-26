# Migrating to 2.4

Version 2.4 is a compatible upgrade from 2.3. It retains the existing Slack
app, `/sab-*` namespace, private channels, session state, tmux names,
`~/.config/ccs`, loopback port `8877`, and historical LaunchAgent label. No
state is bulk-migrated. Existing teams, tasks and turns keep their meaning: a
task without `reservation` is exclusive, with unchanged lifecycle, reporting,
seven-day expiry and restart proof. Hierarchies, auto-release and wakes start
only when someone uses them.

## What changes

- **Agent hierarchies.** A channel may coordinate one team and be a worker in
  one parent team, up to two team levels: main, epic coordinators, executors.
  Cycles, a second parent and a third level fail closed. The owner nests with
  `/sab-team create` in a worker channel, or `/sab-team add` of a channel that
  coordinates a leaf team. A coordinator nests programmatically with
  `sab automation create --team PARENT --create-team NAME`; the sub-team
  inherits the parent's continuation and auto-release settings.
- **Standing tasks.** A task to a sub-team coordinator is standing. It binds
  the exact session for replies, checkpoints and completion, but never
  reserves or reports its provider turns. Follow-ups enter only an idle input
  surface, and the task lives 30 days after its last activity. A coordinator
  can also send one to a liaison with `sab team send --standing`.
- **Delegated authority.** The turn that handles a standing task, or a
  follow-up for it, may control the worker's own team within the usual
  bounded budget, only while that exact task is active and bound.
  Collaborator turns never gain it.
- **Auto-release (opt-in).** `/sab-team auto-release on` lets SAB release a
  task once completion is accepted, its gates are clear and the release is
  ready, then wake an automatic coordinator with the result. It is off by
  default.
- **Scheduled wakes.** `sab team schedule --every 15m|--at ISO [--note TEXT]`
  registers wakes for an automatic team: at most eight per team, 5 minutes to
  24 hours apart, for up to 30 days. Only owner and delegated turns may
  register them. `/sab-team unschedule ID` removes one, and `/sab-team manual`
  removes them all.
- **Worker wakes.** `sab team wake --to ALIAS` resumes a dormant worker that
  holds an active task in the coordinator's team, rate-limited. A dormant
  standing worker is woken once per pending coordinator follow-up. No wake, and
  no automatic continuation, resumes a session the owner ended with
  `/sab-kill` until the owner's next message.
- **Tree.** `sab team tree --json` and the owner's `/sab-team tree` show the
  hierarchy with members, roles, availability, active tasks and wakes.
- **Closing.** The hourly archive sweep now closes an active team whose
  coordinator channel is archived, even while its workers' channels remain
  open, and that coordinator leaves its parent team. An existing team whose
  coordinator channel is already archived closes at the first sweep after the
  upgrade.
- **Labelling.** A `sab team reply` written in a collaborator-started turn is
  labelled collaborator-originated. Agent-visible team JSON only adds fields.
- **New Claude sessions and restarts.** A Claude session that has not received
  its first message has no conversation to resume. Automatic account handover
  now skips it. `/sab-account`, `/sab-update`, bulk and scheduled updates and
  launch-flag changes refuse it before stopping anything, and ask for a first
  message.

## Slack manifest

Unchanged. `auto-release`, `tree` and `unschedule` are new subcommands of the
existing `/sab-team` command. Its usage hint is deliberately left as it was,
so no reinstall is needed. There is no new OAuth scope, event, token or Slack
app.

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

A 2.3 daemon ignores the new optional fields, and some of them then fail
closed:

- It refuses team commands in a channel that belongs to two active teams
  (`ambiguous_team`), so a nested coordinator can act for neither team.
- It knows neither standing tasks nor delegated turns. A standing task is
  neither delivered nor settled, and a delegated turn has no team authority.
- It ignores auto-release, scheduled wakes and the `/sab-kill` marker, so
  automatic continuations may again resume a session the owner ended.

Before rolling back, remove each nested coordinator from its parent team with
`/sab-team remove ALIAS` in the parent's channel, which cancels its standing
task. Then run `/sab-team manual` in every team that has scheduled wakes.

Then stop the daemon, return the live checkout to `v2.3.0`, run
`npm ci --omit=dev` and start the daemon again. Restore the configuration
backup only when the newer state itself is known to be damaged.

Never run the old and new daemons concurrently.
