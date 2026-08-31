# Architecture

Slack Agent Bridge currently runs as one macOS daemon connecting one trusted
Slack owner to local Claude Code, Codex, and Pi sessions. Providers have
separate adapters and native conversation identities; Slack, state, tmux,
terminal viewports, artifacts, and lifecycle coordination are shared.

The accepted multi-node direction separates the sole Slack-facing coordinator
from enrolled execution nodes without changing `/sab-*`. The current runtime is
the compatible all-in-one deployment: its execution node is implicitly
`local`. An authenticated node listener is available only when explicitly
configured, and enrolled nodes cannot receive provider work yet. See
[Multi-node coordinator architecture](docs/multi-node-architecture.md).

## System shape

```text
Slack Socket Mode
       │
       ▼
daemon/daemon.mjs ─────────────── ~/.config/ccs/state.json
       │                           atomic durable state
       ├── provider adapters ───── daemon/providers.mjs
       ├── automation API ──────── daemon/automation*.mjs
       ├── artifact API ────────── daemon/artifacts.mjs
       ├── session teams ───────── daemon/team-{auth,files,http}.mjs + teams.mjs
       ├── terminal API ────────── daemon/terminal-{http,control}.mjs
       ├── Slack coordinator ───── daemon/{coordinator,slack-runtime}.mjs
       ├── execution routing ───── daemon/{nodes,execution-nodes}.mjs
       ├── node trust/protocol ─── daemon/node-{auth,enrollment,registry,protocol}.mjs
       ├── optional node WSS ───── daemon/node-{runtime,transport}.mjs
       │
       ▼
detached-capable tmux session ─── bin/sab __run <provider>
       │                           scripts/run-session.sh
       ├── Claude + MCP Channel + hooks
       ├── Codex TUI + App Server commentary proxy + hooks
       └── Pi + explicitly loaded SAB extension

optional Ghostty process ──────── tmux attach-session
```

The daemon is the sole owner of the Slack Socket Mode token. Never run two
daemon processes against the same Slack app: Slack events will race between
them.

## Components

- `bin/sab` is the only public local executable. It dispatches `new`,
  `terminal`, `account`, `upload`, `team`, `automation`, and `node`. Its private `__run`
  subcommand is used only inside tmux.
- `scripts/run-session.sh` is the provider runner. A local `sab new` creates and
  attaches to tmux; daemon-created sessions start tmux detached. It configures
  the Claude MCP Channel, Codex event proxy/fallback, or Pi extension before
  executing the provider CLI.
- `daemon/daemon.mjs` owns Slack ingress/egress, hooks, state adoption,
  session/channel correlation, resurrection, settings, permission decisions,
  switching, and managed Pi coordination.
- `daemon/slack-runtime.mjs` constructs the sole direct Slack API and Socket Mode
  clients for the compatible all-in-one deployment. `daemon/coordinator.mjs`
  owns prompt acknowledgement and serialized startup of that sole ingress;
  future node routing happens behind this boundary rather than opening another
  Socket Mode connection.
- `daemon/providers.mjs` is the provider boundary: labels, command parsing,
  provider-specific flag allowlists, defaults, resume arguments, model/effort
  validation, and update behavior.
- `channel/server.mjs` implements the Claude Channels path. Claude hooks provide
  lifecycle and stable transcript/status integration.
- `scripts/codex-event-proxy.mjs` transparently forwards the loopback App Server
  WebSocket to the Codex TUI while extracting completed semantic commentary.
  Codex hooks remain authoritative for lifecycle, permissions, and final text.
- `pi/sab-extension.ts` provides Pi lifecycle, inbound text, model/thinking
  settings, image support, usage, project trust, safe-mode permissions, and
  managed-run coordination. It is loaded explicitly and never installed into a
  project or global Pi configuration.
- `daemon/terminal-control.mjs` resolves authoritative active sessions and
  serializes terminal operations per tmux name. `daemon/terminal-http.mjs` and
  `scripts/sab-terminal.mjs` expose the same operations to local scripts.
- `daemon/teams.mjs` defines the bounded channel-level team and task journal.
  `daemon/team-auth.mjs` is the exact caller-identity gate;
  `daemon/team-files.mjs` owns workspace-contained private file staging; and
  `daemon/team-http.mjs` plus `scripts/sab-team.mjs` expose the loopback-only,
  JSON-safe agent mailbox. Slack membership administration and provider-final
  correlation remain in the sole daemon.
- `daemon/nodes.mjs` defines compatibility-safe execution-node identity and
  exact channel/session/node binding. `daemon/execution-nodes.mjs` is the
  execution boundary; the first adapter wraps existing local spawn and terminal
  primitives without changing runtime behavior.
- `daemon/node-registry.mjs` defines the implicit local node, pinned Ed25519
  enrollment records, node-scoped operators, defaults, revocation, and safe
  human-name resolution. `daemon/node-protocol.mjs` validates the bounded
  versioned control envelopes and operation/event allowlists.
- `daemon/node-auth.mjs`, `daemon/node-enrollment.mjs`, and
  `daemon/node-keys.mjs` implement one-use hashed invitations, node-local
  Ed25519 identity, short-lived signed challenges, and coordinator identity
  pinning. `daemon/node-transport.mjs` adds bounded authenticated WebSockets,
  persisted connection epochs, stale-connection fencing, heartbeats, and
  revocation. `daemon/node-runtime.mjs` keeps that listener off by default and
  requires TLS plus an explicit public WSS URL for non-loopback binds.
- `daemon/node-http.mjs`, `daemon/node-management.mjs`, and
  `scripts/sab-node.mjs` expose loopback-only administrator enrollment controls
  through `sab node`. The invitation secret is accepted by the node CLI only
  through a private file or stdin and is never stored in plaintext.
- `scripts/sab-upload.mjs`, `scripts/sab-automation.mjs`, and
  `scripts/sab-account.sh` are private implementations reached through `sab`.

## Session identity and durable state

`state.sessions[nativeSessionId]` stores the native provider identity, cwd,
provider, pid, tmux name, channel, flags, model, effort, and provider-specific
metadata. A missing `provider` is deliberately interpreted as Claude so old
state remains resumable without a bulk migration.

`state.channels[channelId]` is the authoritative active mapping. The mapped
session must point back to the same immutable channel ID. A channel name may be
changed freely in Slack and is never an identity key.

Session teams are created lazily. `state.teams[teamId]` binds one coordinator
and bounded workers by immutable channel ID with presentation aliases and
per-worker file permission. `state.teamTasks[taskId]` is the bounded,
immediately persisted delivery journal: request/payload digest, exact source and
target channel/session/provider/node identities, dispatch phase, Slack audit
timestamps, replies, stable result/error, and expiry. Plaintext task input is
removed after provider acceptance. Team membership survives provider switching
because every send/reply revalidates the channel's current active leg.

A missing `session.nodeId` and missing `state.channelNodes[channelId]` resolve to
the implicit local node. Explicit remote metadata must agree on both records;
an invalid, unknown, or mismatched route has no authority and cannot fall back
to local execution. This preserves old state without a bulk migration.

A switched channel may own one Claude, one Codex, and one Pi native leg through
lineage state. Exactly one leg is active. Standby legs preserve resumable IDs
and settings but have no channel authority or live provider process.

State writes are atomic. Replacement and restart paths fence stale hooks by
native ID, provider, process ancestry, tmux claim, channel mapping, and lineage
phase. An old process may not overwrite or mark dormant the session that
superseded it.

## Process and terminal lifecycle

tmux, not Ghostty, owns the interactive process lifetime:

1. The daemon validates cwd and flags.
2. The execution-node router selects the implicit local adapter, which calls
   `spawnSession` to create a named detached tmux session running
   `sab __run <provider>`.
3. A provider-native start event claims that tmux and binds or adopts the
   session/channel state.
4. Slack messages use the provider's inbound transport or a bounded tmux paste.
5. The provider may run indefinitely with zero attached terminal clients.

Ghostty is an optional viewport. Opening a viewport checks that the exact tmux
and provider are still alive. If a client is already attached, the bridge finds
that Ghostty process through the tmux client ancestry and focuses it. Otherwise
it starts one Ghostty process whose only job is `tmux attach-session`.

Closing a viewport calls `tmux detach-client`; it does not send input, kill
tmux, change session state, or stop the provider. `open-all` and `close-all`
derive their targets only from valid `state.channels` mappings and exclude
standby, provisional, stale, and rebound records. Operations on the same tmux
name are serialized.

A dormant native session is different from a closed terminal. If its provider
process is gone, an owner Slack message runs the provider-native resume form in
a new detached tmux session and queues the message until the start event safely
rebinds it. No terminal needs to be visible.

Codex has one bounded lifecycle exception: an idle `codex resume` may expose a
ready TUI without emitting `SessionStart`. Update readiness first allows the
native hook to claim the replacement. If it remains absent, the bridge walks
only the exact replacement tmux's descendant process tree, prefers its Codex
App Server identity, repeats the tmux ancestry and channel-authority checks,
and then performs the same durable PID/channel completion. A racing native hook
and this fallback share one tmux-keyed completion claim, so announcements and
queued prompts remain exactly once. Boot recovery applies the same fail-closed
correlation to an interrupted hookless resume; it never searches for or adopts
an unrelated Codex process.

`/sab-update all` derives its candidates from the same exact authoritative
channel/session mapping. Before each stop it revalidates the PID, tmux, and
authority and rejects active turns, question forms, permission decisions,
provider transitions, private maintenance turns, managed Pi activity,
automation ownership, delegated team work, and concurrent wake/restart work. Eligible sessions are
grouped by provider: all selected sessions in a group stop, that provider's CLI
updates once, and every stopped session resumes even when the update check
fails. Incoming prompts during this bounded relaunch are held in the existing
per-session queue. Standby, provisional, stale, dormant, and rebound records are
never bulk-restarted.

The only exception is a provider-local trust surface that cannot be decided
remotely. The bridge opens the provisional target's terminal automatically and
reports the required local action in Slack.

## Slack command routing

The canonical manifest exposes one namespace:

```text
/sab-new  /sab-model  /sab-effort  /sab-flags  /sab-update
/sab-stop /sab-switch /sab-kill    /sab-status /sab-usage
/sab-run  /sab-account /sab-terminal
/sab-team /sab-health /sab-cleanup /sab-claim /sab-help
```

`/sab-new` requires the provider. In a session channel, the authoritative
session selects provider-specific behavior for every other provider operation.
From the control channel, `/sab-status` and `/sab-usage` may take a provider
filter. `/sab-update all` is bridge-wide and may be run from the control channel
or a session channel. `/sab-run` rejects non-Pi sessions and `/sab-account`
rejects non-Claude sessions before mutation.

The parser accepts old provider-prefixed slash commands only as an unadvertised
upgrade shim while the owner replaces a 1.x manifest. No old command appears in
the canonical manifest, help, or public launcher surface.

## Session teams

`/sab-team` is owner-only administration over a provider-neutral, local-node
collaboration graph. Team creation makes the current authoritative private SAB
channel the coordinator. The Block Kit picker accepts only another exact
authoritative private SAB channel. Membership and permission changes are
persisted before acknowledgement and reported in affected channels. The first
topology is a star: coordinator-to-worker tasks and worker-to-coordinator
replies/status/finals. Worker mesh is absent; files are denied until explicitly
enabled for that worker.

The agent surface is `sab team`, never Slack Web API access. Its loopback request
derives the source from process ancestry and requires exact PID, tmux, provider,
native session, active channel mapping, and local node. Agent-visible peers and
tasks contain aliases and authorized envelopes rather than raw destination
IDs. A short-lived bounded `session.teamTurn` gives only a current
owner-initiated coordinator turn dispatch authority; collaborator and local
terminal turns clear it. A delegated worker task is narrower still: only its
exact assigned live session may reply.

The process claim also requires the provider to be the root provider process
under the SAB tmux pane. Nested utilities such as `codex review` inherit the
parent environment but are rejected before SessionStart registration and before
any team or artifact authority check, so one-off child work cannot create ghost
channels or masquerade as the interactive session.

Task delivery is journal-first:

1. Revalidate source authority, owner turn, team edge, target mapping, and
   request identity; stage any approved files from the source workspace.
2. Atomically persist a unique queued task, then publish its complete bounded
   payload and idempotent status cards in both Slack channels.
3. Wait while the target is dormant, busy, switching, asking a question,
   awaiting permission, under maintenance, or owned by managed Pi work.
4. Reserve the worker input surface, atomically change `queued → dispatching`,
   and bind the exact target native session before provider injection. A restart
   never retries an uncertain dispatch claim.
5. Accept `running` only when the provider acknowledges the injected immutable
   task marker. Claude's
   completed transcript path, Codex's Stop hook, or Pi's extension final event
   may complete only the same task/session binding.
6. Persist completion and a delivery claim before updating both audit cards and
   idempotently posting the stable result in the coordinator channel. A missing
   or uneditable audit card is reported with the result but cannot suppress it;
   reconciliation retries incomplete result delivery before releasing bounded
   state. Only fully delivered terminal records are eligible for TTL or journal
   pressure pruning, and the pruned journal is persisted before file cleanup.

Interim provider commentary remains in the worker channel; a worker explicitly
uses `sab team reply` to put selected progress in the source mailbox. Questions
and permissions stay on the worker's normal Slack surface. Interrupt, kill,
session death, team removal/closure, and expiry produce visible task failure or
cancellation. Bulk updates skip active worker tasks and cleanup preserves
dormant team channels.

Team file relay is separate from artifact grants. It applies the artifact
realpath/regular-file/count/aggregate-size validator to the exact source
workspace, hashes content for retry conflict detection, writes mode-0600 copies
under `~/.config/ccs/team-files`, uploads the copies to the linked Slack channel,
and injects only destination-private paths. Staged content and terminal task
metadata expire under the bounded journal.

Remote-node dispatch is deliberately not enabled. Task records already carry
node identities so the accepted authenticated command/event/file transport can
replace the local delivery adapter later without changing `/sab-team` or `sab
team`. See [Session teams](docs/session-teams.md).

## Provider adapters

### Claude Code

Claude inbound messages use the MCP Channel server. Hooks mirror lifecycle and
outbound final content; its transcript and statusline support live progress,
account usage, and topic metadata. `AskUserQuestion` uses the bounded structured
`PreToolUse.tool_input.questions` payload for Slack text, descriptions,
previews, and concise buttons, while tmux key input remains the answer transport.
A pane parser handles only restart recovery, legacy Claude versions, and
post-Stop approval screens; a live structured form cannot be overwritten by its
width-dependent terminal rendering. Claude keeps consent and account-switching
paths. Remote flagless sessions default to
`--dangerously-skip-permissions`; `--dsp` normalizes to that flag. `--chrome`
is Claude-specific.

### Codex

Codex inbound text and interrupts use tmux. Hooks provide native IDs, stable
final assistant text, turn boundaries, and permission decisions. The App Server
proxy is a bounded supplementary egress path: it forwards every protocol frame
unchanged but submits only completed `agentMessage` values explicitly marked
`commentary`. It never emits commands, command output, diffs, plans, reasoning,
deltas, or final answers. Before applying the exact-process fence, the daemon
canonicalizes npm's persistent App Server launcher to its direct matching
native child—the identity emitted by lifecycle hooks—and then revalidates that
child against the exact tmux. If either sidecar cannot start, the runner falls
back to the direct TUI. Transcript JSONL is never parsed; `ccusage` is the
public usage adapter. One bounded TUI exception handles Codex's fixed model
capacity rejection, which can return to idle without emitting `Stop`: only the
exact warning in the visible terminal tail, on a proven idle input surface and
across two consecutive live observations, may replace the working timer with a
failure. Startup recovery applies the same exact current-tail check to a
persisted orphan turn. Stale scrollback and conversational mentions never
qualify. Every SAB-managed Codex TUI receives the fixed internal
`check_for_update_on_startup=false` override so its detached startup cannot be
captured by the native update chooser; provider binaries are updated only by
the explicit SAB maintenance path. The override is not persisted as a user
launch flag. A legacy chooser that still appears during provider switching is
recognized as an immediate actionable startup failure. Remote flagless
sessions default to Codex's canonical dangerous flag (`--yolo`).

### Pi

The SAB extension owns Pi's bridge-facing lifecycle and streams. Built-in tools
are unrestricted by default; SAB `--safe` adds a fail-closed Slack decision per
tool call. Pi `--approve` is separate project-resource trust.

Ordinary owner prompts use persisted adaptive routing. A no-tools classifier
receives only visible prompt text and fails toward managed execution.
Collaborator prompts remain native. `/sab-run` can force a bounded
planner/worker/independent-reviewer state machine with wall-clock, parent-turn,
subagent, and review budgets. Read-only children do not inherit bridge identity,
Slack/upload capability, session state, extensions, skills, project approval,
or writable tools.

## Working status and output

Hooks start provider-specific live pollers. The daemon stores restart metadata
needed to recover an in-progress turn, finds the frozen Slack status message on
boot, re-adopts it, and continues the original elapsed duration. New channel
content re-anchors the status as the latest item without resetting it.

Final text comes only from provider-stable sources. Claude reads completed
transcript records, Codex uses the Stop hook's final field, and Pi uses its
extension event. Deduplication fences hook retries and restart races.

## Provider switching

Switching is a journaled transaction:

1. Validate the source mapping, idle state, target choice, and target flags.
2. Optionally inspect root `AGENTS.md` and `CLAUDE.md` and produce a bounded,
   hash-protected instruction proposal for owner review.
3. Capture a private source-native handoff. It is not mirrored into Slack.
4. Stop the source process and launch/resume the target in detached tmux.
5. Wait for the target's native input surface and run a private read-only
   validation turn.
6. Atomically commit the target mapping, update the topic, and release queued
   owner messages.

The source remains authoritative until commit. Any failure rolls back, reaps
the provisional target, and restores/resumes the source. A daemon restart uses
the same journal to make the rollback deterministic. Collaborators are rejected
during a switch; owner messages are bounded and queued. Artifact grants for the
source are revoked at commit and grants for queued messages are minted only for
the committed target.

## Collaborators and artifacts

The session status picker calls `conversations.invite` before modifying the
per-channel prompt allowlist. Invitation failure is shown to the owner and
leaves the user untrusted. Collaborators may prompt only a live explicitly
allowed session; they cannot run slash commands, resurrect, or answer
permissions.

Accepted owner/collaborator prompts may receive an opaque one-use artifact
grant. It binds sender, message/thread, provider, native session, pid/tmux,
channel, and canonical workspace. The agent supplies only file paths. The
daemon fixes the Slack destination and validates realpath containment, regular
file type, count, aggregate size, expiry, and replay state.

## Loopback APIs

Port `8877` binds only to loopback and carries hooks, status, provider streams,
permission decisions, artifacts, terminal control, session-team mailboxes,
legacy `/spawn`, and the automation lifecycle API. It must never be proxied or forwarded. Script-facing
mutations require JSON and reject browser Origin/fetch metadata and non-loopback
Host headers.

Terminal endpoints are:

- `GET /terminals`
- `POST /terminals/open` with `{ "selector": "…" }` or `{ "all": true }`
- `POST /terminals/close` with the same shape

Automation endpoints are:

- `POST /automation/sessions`
- `GET /automation/sessions/:externalKey`
- `POST /automation/sessions/:externalKey/stop`

Team endpoints are:

- `GET /team/context`, `/team/peers`, and `/team/inbox`
- `GET /team/tasks/:taskId`
- `POST /team/send` and `/team/reply`

Every endpoint rejects browser origins and non-loopback Host values. Team
mutations additionally require exact provider-process/tmux ancestry; no bearer
capability or Slack destination is accepted from the caller.

Automation creation atomically records its external key and deterministic tmux
identity before launch. Duplicate keys return the existing record. Native
session/channel correlation precedes collaborator invitation; all invitations
and name resolution precede whitelisting and initial-prompt injection. The
prompt is claimed at most once and receives no artifact grant. Exact stop
revalidates every binding, revokes grants and handoff state, stops only the
correlated process/tmux, and optionally archives only that immutable channel.

## Installation and updates

`install.sh` maintains one checkout and the historical
`si.sergej.claudeslackproxy` LaunchAgent label. It installs only the `sab`
symlink and removes old launcher symlinks. Existing `CCS_*`,
`~/.config/ccs`, old checkout paths, control channels, state records, and local
port remain compatible.

Self-update and release rollout must occur from a clean release commit during a
maintenance window. The prior tag and config backup remain available until
existing and new sessions for every installed provider pass the release
canary.

The multi-node foundation adds no listener by default, Slack scope, manifest
command, or second Slack daemon. Explicit listener configuration enables only
one-use enrollment and authenticated heartbeat transport. Remote provider work
remains unavailable until durable replay, node-local lifecycle, coordinator
projection, and node-scoped Slack authorization pass the remaining delivery
gates in the accepted architecture document.
