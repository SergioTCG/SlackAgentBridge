# Release checklist

## Repository and compatibility

- [ ] Release branch starts at the last known-good tag and is clean.
- [ ] Version, changelog, repository URLs, description, and topics agree.
- [ ] `AGENTS.md`, `CLAUDE.md`, README, architecture, security, and the 2.0
      migration guide describe the same command, terminal, and safety contract.
- [ ] `slack/app-manifest.json` is the sole manifest and contains only the 17
      documented `/sab-*` commands.
- [ ] `sab` is the sole public executable; `new`, `terminal`, `account`,
      `upload`, and `automation` subcommands work.
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
- [ ] Only `sab` is linked on `PATH`; legacy symlinks are removed.
- [ ] Historical `both` still means Claude + Codex.
- [ ] No scenario creates a second daemon, control channel, or hook entry.

## Slack manifest migration

- [ ] Back up/export the currently installed manifest.
- [ ] Apply the canonical v2 manifest to the existing Slack app.
- [ ] Reinstall the same app and confirm no token or OAuth-scope change.
- [ ] Confirm all 17 `/sab-*` commands autocomplete and old provider-prefixed
      commands are absent.

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
- [ ] Codex mirrors semantic interim commentary but excludes commands, output,
      diffs, reasoning, plans, and final events; direct fallback works.
- [ ] Claude login expiry and overload failures surface promptly and deduplicate.
- [ ] `/sab-model`, `/sab-effort`, `/sab-flags`, `/sab-update`, `/sab-stop`,
      `/sab-kill`, `/sab-status`, and `/sab-usage` work for each provider.
- [ ] `/sab-update all` updates each represented provider binary once, resumes
      every idle authoritative session with unchanged settings, queues a prompt
      arriving mid-relaunch, and explicitly skips a busy turn, permission,
      switch, managed run, automation, standby leg, and stale mapping.
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
- [ ] No duplicate Slack channels appear.

## Publish

- [ ] Push the release branch and wait for CI.
- [ ] Publish `vX.Y.Z-rc.N` as a prerelease.
- [ ] Dogfood the RC before promoting the exact tested commit to `vX.Y.Z`.
- [ ] Keep the previous tag and config backup until final acceptance.
