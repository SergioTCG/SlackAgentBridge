# Stability policy

Slack Agent Bridge controls long-lived provider processes and a live Slack
workspace. A unit-test pass is necessary but not sufficient for release. This
policy turns the recurring production failures into explicit gates.

## Priority order

1. Preserve provider process, native conversation, cwd, model, effort, flags,
   team authority, and channel identity.
2. Deliver accepted owner prompts and provider-stable output.
3. Complete or visibly fail lifecycle operations.
4. Maintain optional views: working timers, topics, dashboards, and Ghostty.

A lower-priority operation must never delay or mutate a higher-priority one.
In particular, status `chat.update` traffic is cosmetic and may coalesce or be
dropped; provider commentary and finals are critical, bypass that queue, and
retain their provider source order across retries.

## Change classes

Every compatibility-sensitive change is assigned a class before merge:

| Class | Examples | Required evidence |
|---|---|---|
| Presentation | Block Kit, App Home, help text | Pure builder tests, stale-action tests, manifest validation |
| Provider adapter | flags, settings, hooks, final extraction | Provider-specific fixtures plus resume/update tests |
| Lifecycle | adoption, restart, switching, terminal ownership | Restart/race regression and cross-session non-mutation test |
| Durable coordination | automation, teams, node routing | Journal crash points, idempotency, exact authority, recovery test |
| Live install | installer, launchd, manifest, dependencies | Isolated install matrix and controlled canary |

Combining classes increases the release evidence; it never reduces it.

## Regression-first rule

Every production incident receives:

- a minimal failure description and authoritative source of truth;
- a test that fails on the known-bad implementation;
- a bounded fix at the owning adapter or lifecycle boundary;
- a negative test proving no unrelated channel/session/provider is mutated;
- an operational signal when the same condition can recur outside tests.

Terminal paint is evidence only where the provider has no stable event. Stable
provider hooks/extensions/App Server events, exact process ancestry, durable
state, and Slack API results remain authoritative in that order.

## Release train

1. Develop in a clean isolated worktree while the live checkout remains
   untouched.
2. Run focused regression tests after each fix.
3. Run the complete suite in `AGENTS.md` and the release checklist.
4. Create a release-candidate commit and automated review. Adjudicate findings:
   implement correctness/security issues, reject speculative churn, and file
   independent follow-ups rather than expanding the candidate.
5. During a declared maintenance window, record a rollback tag and private
   configuration backup, then roll exactly one daemon.
6. Run the provider/session/status/App Home canary in
   `docs/release-checklist.md`. Active tmux providers must survive daemon
   replacement.
7. Dogfood the exact candidate long enough to cover daemon restart, provider
   update, simultaneous turns, team delegation, and Slack rate limiting.
8. Promote that exact commit to a final semantic-version tag. Any code change
   creates a new candidate and restarts the affected gates.

No-reload provider staging is still a live-install mutation. Run it only from
the checkout recorded in the LaunchAgent; an isolated worktree must be refused
before hooks, configuration, Git state, or the public executable can change.

## Stop-the-line conditions

Do not promote or continue adding features when any of these occurs:

- an accepted prompt or stable provider response is missing;
- Slack and the authoritative provider disagree about active/idle state;
- requested model/effort is silently replaced in durable resume settings;
- a stale control can act on a rebound session, channel, node, or provider leg;
- daemon restart duplicates a prompt, provider process, channel, or team task;
- installer activation points hooks or the public executable at a disposable
  worktree;
- a bulk command touches an ineligible session;
- the complete validation suite or controlled rollback rehearsal is incomplete.

Fix and prove the incident first. Resume feature work only after the release
candidate passes the affected canary again.

## Operational checks

- `/sab-health` reports daemon/session counts and current status-queue pressure.
- `/sab-status` reports authoritative provider/session state and exact controls.
- `sab terminal list --json` proves provider/tmux liveness independently of a
  Ghostty viewport.
- Daemon logs are diagnostic evidence, not the state authority. Secret-bearing
  configuration, transcripts, and provider auth files must never enter logs,
  issues, or test fixtures.

The detailed command-by-command gates and rollback sequence live in
[`release-checklist.md`](release-checklist.md).
