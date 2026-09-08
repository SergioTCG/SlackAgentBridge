# Release checklist

## Repository and compatibility

- [ ] Release branch starts at the last known-good tag and is clean.
- [ ] Version, changelog, repository URLs, description, and topics agree.
- [ ] `AGENTS.md`, `CLAUDE.md`, README, architecture, security, and the 2.0
      migration guide describe the same command, terminal, and safety contract.
- [ ] `slack/app-manifest.json` is the sole manifest and contains only the 18
      documented `/sab-*` commands.
- [ ] `sab` is the sole public executable; `new`, `terminal`, `account`,
      `upload`, `team`, `automation`, and `node` subcommands work.
- [ ] The installer removes legacy launcher symlinks without deleting unrelated
      files and never creates a second daemon or LaunchAgent label.
- [ ] Old state/config/checkout/control-channel identities and missing-provider
      Claude records are covered by tests.
- [ ] No secrets, local state, logs, transcripts, or generated config are tracked.

## Automated validation

- [ ] `npm ci`
- [ ] `npm run audit` reports zero known production vulnerabilities.
- [ ] `npm test`
- [ ] `npm run check`
- [ ] `for file in daemon/*.mjs channel/*.mjs scripts/*.mjs; do node --check "$file"; done`
- [ ] `PI_OFFLINE=1 pi --extension ./pi/sab-extension.ts --list-models`
- [ ] `node scripts/smoke-pi-managed.mjs` against its disposable fixture.
- [ ] `shellcheck -S warning bin/sab scripts/run-session.sh scripts/claude-consent.sh scripts/sab-account.sh hooks/hook.sh hooks/codex-hook.sh install.sh install-codex.sh install-pi.sh`
- [ ] Installer help/provider selection passes in a clean shell.
- [ ] CI passes on the release commit.

## Installation matrix

- [ ] Upgrade an existing Claude-only 1.x installation.
- [ ] Upgrade existing Claude + Codex and all-provider installations.
- [ ] Fresh Claude-only, Codex-only, Pi-only, `both`, and `all` installations.
- [ ] Re-running each installer is idempotent.
- [ ] `install-codex.sh` and `install-pi.sh` do not reload or rewrite the live
      LaunchAgent.
- [ ] A no-reload installer invoked from a different worktree fails before
      changing provider hooks, configuration, Git state, or the `sab` link.
- [ ] A piped no-reload installer with a mismatched loaded target fails before
      invoking clone, pull, or any other Git operation.
- [ ] The same no-reload fence rejects a differently rooted loaded LaunchAgent
      when its plist is missing, and allows a genuinely unloaded fresh install.
- [ ] Only `sab` is linked on `PATH`; legacy symlinks are removed.
- [ ] Historical `both` still means Claude + Codex.
- [ ] No scenario creates a second daemon, control channel, or hook entry.

## Slack manifest migration

- [ ] Back up/export the currently installed manifest.
- [ ] Apply the canonical v2 manifest to the existing Slack app.
- [ ] Reinstall the same app and confirm no token or OAuth-scope change.
- [ ] Confirm all 18 `/sab-*` commands autocomplete and old provider-prefixed
      commands are absent.
- [ ] Confirm `/sab-team` was registered without adding OAuth scopes or a second
      Slack app.
- [ ] Confirm the Home tab is enabled, Messages tab remains disabled, and
      `app_home_opened` is subscribed on the existing Socket Mode app without a
      new OAuth scope or token.

## Controlled live canary

- [ ] Back up `~/.config/ccs` with restrictive permissions.
- [ ] Record the previous release tag and rollback commands.
- [ ] Confirm no provider switch or automation launch is mid-transaction.
- [ ] Exactly one daemon connects with the production Socket Mode token.
- [ ] Existing active Claude, Codex, and Pi processes are re-adopted without a
      duplicate channel, process, prompt, or topic write.
- [ ] An in-progress turn for every provider regains its working line and
      original elapsed duration after restart.
- [ ] Existing and fresh sessions send and receive Slack text and attachments.
- [ ] Closing Codex while commentary delivery is backing off still drains its
      accepted App Server fallback final before the proxy exits, while the
      correlated App Server remains alive for daemon ancestry validation.
- [ ] Delay an accepted Codex App Server final until a newer turn starts.
      Confirm the old final is posted exactly once without clearing the newer
      turn's poller, working line, reservation, or team lifecycle.
- [ ] A transient final-delivery rejection during shutdown observes retry
      spacing and succeeds when the loopback endpoint recovers.
- [ ] SIGTERM immediately after an App Server completion frame closes ingress
      first and still delivers the exact fallback final once before proxy exit.
- [ ] Exhausting that bounded Codex shutdown drain produces a visible nonzero
      runner failure with a bounded diagnostic rather than silent success.
- [ ] New sessions are headless; Slack interaction works with no Ghostty window.
- [ ] `/sab-terminal open` opens or focuses one exact session, `close` detaches
      without stopping it, and a Slack prompt continues afterward.
- [ ] `/sab-terminal open-all` and `close-all` affect all and only authoritative
      active sessions; standby/provisional legs remain untouched.
- [ ] `sab terminal` list/open/close/all operations match the Slack behavior.
- [ ] Topics include folder, branch, model, and effort; unchanged topics do not
      trigger restart notifications.
- [ ] A new message or real topic change re-anchors the single working status
      without resetting its timer.
- [ ] Codex mirrors semantic interim commentary and exactly one completed final
      in App Server source order, while excluding commands, output, diffs,
      reasoning, plans, deltas, and failed-turn finals; direct fallback works.
- [ ] Claude login expiry and overload failures surface promptly and deduplicate.
- [ ] `/sab-model`, `/sab-effort`, `/sab-flags`, `/sab-update`, `/sab-stop`,
      `/sab-kill`, `/sab-status`, and `/sab-usage` work for each provider.
- [ ] No-argument model, effort, terminal, update, switch, new-session, team,
      and status controls work; equivalent parameterized forms behave the same.
      A panel posted before a switch, native `/clear`, or rebind fails without
      mutating the new leg; controls from a closed team cannot affect a newly
      created team in the same channel.
- [ ] Interactive update-all and team-close require confirmation; cancellation
      has no side effect.
- [ ] Owner App Home shows fresh bridge/session state, opens exact session
      controls, and creates a default/allowlisted session. A non-owner Home
      reveals no channel, session, cwd, model, or action data.
- [ ] With several simultaneous turns, status queue pressure stays bounded,
      `/sab-health` reports it, final/commentary messages arrive before delayed
      timer cleanup, and a completed turn cannot keep an hour-old working line.
- [ ] `/sab-update all` updates each represented provider binary once, resumes
      every idle authoritative session with unchanged settings, queues a prompt
      arriving mid-relaunch, and explicitly skips a busy turn, permission,
      switch, managed run, automation, delegated worker task, standby leg, and
      stale mapping.
- [ ] A maintenance-time native `/clear` carries queued prompts and fences to
      the replacement ID; a second prompt arriving during the first paste stays
      behind it, exact artifact grants follow only that verified replacement,
      and direct input opens only after both are submitted once. Confirm resume
      argv and provider-stream reconnects cannot consume the queue separately.
- [ ] A failed wake or SessionStart metadata operation preserves queued input,
      clears stale maintenance ownership, reports `/sab-update`, and a later
      owner message retries a truly dormant session without duplication.
- [ ] A delayed failed SessionStart cannot clear a newer maintenance generation,
      including when the same session record was rebound to a new native ID.
- [ ] `/sab-account` works only for Claude and `/sab-run` only for Pi.
- [ ] Claude/Codex permission relay and Pi safe-mode/project-trust decisions work.
- [ ] Pi image input, adaptive routing, plan/approve, pause/resume, all budgets,
      failure reporting, independent review, and exactly-one final response work.
- [ ] Claude ↔ Codex ↔ Pi switching preserves one channel, native identities,
      settings, queued-message order, rollback, and standby legs.
- [ ] Switch trust gates open the exact target terminal and explain the required
      local action in Slack.
- [ ] Instruction proposal/apply and continue-without-alignment work; stale,
      traversal, symlink, binary, mode, and oversized proposals fail closed.
- [ ] Manual collaborator invitation precedes allowlisting; failure is visible.
- [ ] Owner and collaborator artifact delivery works through `sab upload`;
      expired/replayed grants and workspace/symlink escapes are rejected.
- [ ] Automation duplicate create launches/prompts exactly once, survives daemon
      restart, invites before whitelisting, and exact repeated stop/archive does
      not mutate any other session or channel.
- [ ] Create one session team with a coordinator and two provider-diverse
      workers. Confirm private role context, alias-only peer discovery, safe busy
      queueing, explicit interim reply, stable final return, and status cards in
      both channels.
- [ ] Confirm a dispatch claim populates `startedAt` and changes durable worker
      availability to busy in the same state write; no status read can show a
      dispatching/running task on a ready worker.
- [ ] Exercise `sab team inbox` with active/target/status/since filters and two
      opaque cursor pages. Confirm the original instruction is present and an
      unrelated channel cannot see the task.
- [ ] While one worker runs and another task is queued, enable team drain.
      Confirm active work finishes, no queued task or continuation starts, and
      resume dispatches the exact queued task once. Cancel and replace queued
      tasks idempotently, and send one audited coordinator message to an exact
      active task; a stale/rebound session and a worker showing a question or
      permission prompt must reject it. Race two replacements with dispatch and
      confirm only the exact revision visible in both audit cards is claimed.
- [ ] Suppress a Codex worker completion hook and confirm two stable live idle
      observations produce `completed_with_warning`, release the worker, and
      dispatch fresh queued work exactly once. Restart with an unproven
      historical task and confirm it fails closed without replay, while a live
      active turn is re-adopted without manual activation.
- [ ] Restart during a Pi worker turn. Confirm its persisted start timestamp
      alone does not restore worker proof or polling, a new native Pi event does,
      and an unproved historical turn releases its stale task/poller/input fences
      without replay after the recovery grace period.
- [ ] Reconnect Pi while its native input surface is already idle. Confirm the
      stale re-adopted task is released without replay and one fresh queued task
      dispatches without requiring an owner prompt.
- [ ] Disconnect Pi's input stream before a coordinator task message. Confirm
      the known-undelivered journal stays pending and delivers once after
      reconnect; an uncertain provider write remains failed and is never retried.
- [ ] Repeat ordinary and dispatch-healing worker replies. Confirm each exact
      task/reply/lifecycle version produces at most one coordinator wake and a
      later real lifecycle version still wakes once.
- [ ] Confirm a collaborator coordinator prompt cannot dispatch, a worker cannot
      address another worker, a stale/rebound leg cannot call `sab team`, and
      daemon restart neither duplicates a queued task nor retries an uncertain
      dispatch.
- [ ] Enable file relay for only one worker. Confirm source-workspace regular
      files arrive as Slack uploads/private copies and that the disabled edge,
      traversal, symlink escape, oversize, replay conflict, and raw channel
      selector all fail closed.
- [ ] Confirm `/sab-stop`, `/sab-kill`, member removal, and team closure cancel
      only the exact delegated task; `/sab-cleanup` preserves dormant team
      channels and provider switching preserves idle channel-level membership.
- [ ] No duplicate Slack channels appear.
- [ ] Rebind a session while a bulk terminal liveness check is pending. Confirm
      the predecessor operation fails closed and never opens or closes the
      replacement session's viewport.

## Publish

- [ ] Push the release branch and wait for CI.
- [ ] Publish `vX.Y.Z-rc.N` as a prerelease.
- [ ] Dogfood the RC before promoting the exact tested commit to `vX.Y.Z`.
- [ ] Keep the previous tag and config backup until final acceptance.
