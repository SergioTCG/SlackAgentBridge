# Migrating to 2.1

Version 2.1 is a compatible upgrade from 2.0. It retains the existing Slack
app, `/sab-*` namespace, private channels, session state, tmux names,
`~/.config/ccs`, loopback port `8877`, and historical LaunchAgent label.

## What changes

- No-argument management commands render interactive controls while their
  parameterized forms remain available.
- App Home provides an owner-only overview and exact-session controls.
- Session teams gain bounded automatic continuation, atomic dispatch, drain
  mode, queued-task cancel/replace, coordinator messages, filtered inbox pages,
  and stronger restart recovery.
- Provider model and effort settings survive update/resume, and Codex reports
  actual capacity fallbacks without silently replacing the requested settings.
- Slack response delivery, working status, Codex commentary/finals, provider
  re-adoption, and maintenance queues are independently fenced and rate-safe.
- The authenticated multi-node foundation is present but remote provider
  routing remains disabled. Existing all-in-one installations stay local.

## Slack manifest

The 2.1 manifest enables the Home tab, subscribes the existing Socket Mode app
to `app_home_opened`, and advertises the expanded `/sab-team` controls. Apply
[`slack/app-manifest.json`](../slack/app-manifest.json) to the **existing app**
and reinstall that app once when upgrading directly from 2.0.1.

No new OAuth scope, callback URL, bot token, app token, Slack app, or daemon is
required. If the interactive-management manifest was already applied and the
Home tab is visible, no second reinstall is needed.

## Controlled upgrade

1. Put automatic teams in manual or draining mode and let any critical provider
   turn reach a safe boundary.
2. Record the current release tag and create a private, permission-preserving
   backup of `~/.config/ccs`.
3. Fast-forward the one checkout named by the loaded
   `si.sergej.claudeslackproxy` LaunchAgent. Never start a second Socket Mode
   daemon with the same app token.
4. Run the installer for the already configured provider set from that live
   checkout. The installer updates hooks and the sole `sab` executable before
   replacing the daemon.
5. Apply the manifest once if App Home and its event subscription are not
   already installed.
6. Run the controlled canary in
   [the release checklist](release-checklist.md), including message/final
   delivery, timer recovery, exact terminal controls, model/effort persistence,
   and one coordinator/worker task round trip.
7. Keep the configuration backup and previous tag until acceptance.

The daemon restart does not intentionally stop provider tmux sessions. It
re-adopts their exact PID, tmux, provider, native identity, channel, and current
turn state. Busy delegated work is never bulk-updated or replayed.

## Rollback

Stop the daemon, return the live checkout to the recorded previous release, and
run that release's installer for the same provider set. Restore the private
configuration backup only when the newer state itself is known to be damaged:
blind restoration can discard channels and sessions created after the backup.

Never run the old and new daemons concurrently. The 2.1 Slack manifest is
backward-compatible with the 2.0 `/sab-*` command namespace, although App Home
controls require the 2.1 daemon.
