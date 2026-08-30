# Agent and contributor guide

This file is the canonical set of repository instructions for humans and coding
agents. Provider-specific instruction files may add constraints, but they must
not copy or contradict this contract.

## Product contract

Slack Agent Bridge connects trusted Slack operators to interactive coding agent
sessions on explicitly assigned execution nodes. Claude Code, Codex, and Pi are
separate provider adapters over shared Slack coordination and node-local state,
tmux, optional Ghostty viewports, and lifecycle infrastructure. The compatible
default is one all-in-one coordinator plus its implicit local node; remote-node
mode must remain gated until its authenticated transport is complete.

These public interfaces are compatibility-sensitive:

- `/sab-*` is the sole public Slack command namespace. Commands in a session
  channel act on its authoritative provider; `/sab-new` requires an explicit
  provider. Do not add provider-prefixed command families.
- Missing `session.provider` means Claude. Never bulk-migrate old state merely
  to make provider fields explicit.
- Missing `session.nodeId` and a missing channel-node route mean the implicit
  local execution node. Never bulk-migrate old state merely to make node fields
  explicit. An explicit remote route must agree on the channel and session.
- `sab` is the only public local executable. Provider launches, terminal
  viewports, accounts, artifact returns, and automation are subcommands. Do not
  restore the pre-2.0 `ccs*` or `sab-*` launcher executables.
- `sab automation` is the JSON-safe client for the loopback
  `/automation/sessions` create/status/stop lifecycle. External keys are durable
  idempotency identities and must never be reused to launch or prompt twice.
- `sab team` is the only agent-facing cross-session interface. Team membership
  is administered through owner-only `/sab-team`; agents must never receive
  Slack credentials, raw destination selection, or arbitrary channel history.
- Historical `CCS_*` environment keys and `ccs-*` tmux names in persisted state
  remain readable. New tmux names use `sab-*`.
- Configuration and state remain in `~/.config/ccs`; the local HTTP port remains
  `8877` unless an explicit migration is designed and documented.
- The historical LaunchAgent label `si.sergej.claudeslackproxy` remains the one
  service identity. Do not load a second label during a rename or upgrade.
- Existing `~/.claudeslackproxy` checkouts and `#claude-code-bridge` control
  channels are valid. Fresh installs may use their neutral replacements.
- The canonical Slack manifest is `slack/app-manifest.json`. There must not be a
  hand-maintained second manifest.

## Live-installation safety

This repository may also be the installation serving a live Slack workspace.
Before changing runtime files, inspect the Git status, current branch, daemon
working directory, and launchd label. Develop in a separate worktree when the
live service points at the primary checkout.

Do not restart, unload, replace, or roll the daemon during ordinary development.
A live rollout requires an explicit maintenance step, a clean release commit,
the complete validation suite, and a known-good rollback tag. Never run two
Socket Mode daemons with the same Slack app token: they race for events.

Never commit `.env`, `state.json`, account files, tokens, logs, transcripts, or
generated MCP configuration. Do not print secrets during diagnostics.

## Architecture invariants

- One coordinator owns the sole Slack Socket Mode connection, Slack tokens, and
  coordinator state. Each execution node owns its local provider/tmux state and
  credentials. The all-in-one deployment may implement both roles in one
  daemon; two processes must never consume the same Socket Mode token.
- Route execution through the node adapter. Unknown, offline, stale-epoch, or
  mismatched channel/session/node claims fail closed and must never fall back to
  the coordinator's local machine. Follow `docs/multi-node-architecture.md` for
  the accepted state, authorization, enrollment, and delivery protocol.
- Every interactive provider process is wrapped in detached-capable tmux. tmux
  owns process lifetime and remains the terminal/control surface;
  provider-native channel/extension streams may carry inbound text. Ghostty is
  an optional viewport: opening, closing, or focusing it must never start,
  duplicate, interrupt, or stop the provider process.
- Provider utilities launched inside a bridged session (including review,
  exec, and nested CLI processes) are child jobs, not SAB sessions. They must
  not register channels or inherit agent-facing bridge authority merely because
  they share the provider environment and tmux ancestry.
- Terminal operations may target only authoritative active sessions on nodes
  assigned to the caller. Standby, provisional, stale, rebound, and mismatched
  node records must not be opened or detached by a bulk terminal action.
- A bridge-wide provider update may restart only idle authoritative active
  sessions on nodes assigned to the caller. It must skip active turns,
  questions, permissions, switches, managed Pi work, automation ownership,
  delegated team work, and sessions already waking or restarting; update each represented provider
  binary at most once per node per sweep.
- Slack channels are private and mapped by channel ID, not mutable channel name.
- A switched channel may own separate Claude, Codex, and Pi native legs, with
  exactly one active. Keep `state.channels[channel]` authoritative; only the active
  session has `session.channel`. Create lineage state lazily, never by bulk
  migration.
- Claude inbound messages use its MCP Channel server; hooks mirror lifecycle and
  outbound content. Preserve the channel consent and account-switching paths.
- Codex inbound messages use tmux; lifecycle hooks provide stable outbound final
  text and permission decisions. A transparent loopback App Server proxy may
  mirror only completed `agentMessage.phase=commentary` events; it must not take
  over lifecycle/input control or emit tools, output, diffs, plans, reasoning,
  deltas, or final answers. Preserve direct-TUI fallback. Never parse Codex
  transcript JSONL directly; usage telemetry may enter only through `ccusage`'s
  public JSON adapter.
- Pi inbound messages, lifecycle, usage, settings, and optional safe-mode tool
  decisions use the explicitly loaded `pi/sab-extension.ts`. Do not install it
  globally or parse Pi session files. Pi's native project trust remains a
  separate decision from SAB safe-mode tool approval.
- Pi owner prompts use native-session-persistent adaptive routing by default;
  collaborators remain native. The read-only classifier must receive visible
  prompt text only—never artifact grants or attachment bytes—and must fail
  toward managed execution. Explicit `/sab-run` goals remain force-managed;
  `direct` and `native` remain deliberate bypasses.
- Managed Pi runs persist only bounded route/goal/plan/counter state in the
  native session. Child Pi processes must not inherit bridge identity,
  Slack/upload capabilities, extensions, skills, session state, or project
  approval. Keep planning, scouting, and independent review read-only; never
  bypass the parent safe-mode approval gate with a child writer.
- Generated-file delivery is provider-neutral. The daemon, not the agent,
  chooses the Slack destination from a short-lived grant tied to an accepted
  Slack message and its live session.
- Session teams are channel-level, owner-created, bounded star graphs. Only a
  current owner coordinator turn may dispatch to linked workers; collaborators
  have no lateral authority. Worker replies/finals bind to one exact task and
  authoritative native session. Journal before Slack/provider side effects,
  never retry an uncertain dispatch after restart, and keep every transfer
  visible in both affected channels. Worker-to-worker relay and arbitrary
  history access remain disabled.
- Team files use a separate task-bound permission—not artifact grants. Enforce
  source-workspace realpath containment, private copied bytes, content hashes,
  fixed linked destinations, explicit per-worker enablement, and bounded
  cleanup. Until authenticated node file transport ships, team calls and
  members are local-node only.
- A session channel's authoritative provider selects provider-specific command
  behavior. Reject flags or operations belonging to another provider before
  they can mutate a session.
- Hook handlers must remain quick, bounded, and failure-tolerant. A hook or Slack
  API error must not crash the long-running daemon.
- State writes remain atomic. Replacement processes must not be overwritten or
  marked dormant by stale hooks from the process they superseded.
- Automation creation journals its tmux identity before launch. Collaborators
  are invited before whitelisting, and the synthetic initial prompt is claimed
  only after native session/channel correlation and complete collaborator
  setup. It never receives an artifact grant. Exact automation stop must not
  delegate to bulk cleanup or mutate a rebound/unrelated session or channel.
- Provider-switch phase changes require immediate atomic persistence. Private
  handoff/alignment turns must not mirror into Slack, and a target must not
  receive the channel until its read-only readiness turn validates.

Read `ARCHITECTURE.md` before altering session lifecycle, PID adoption, channel
binding, terminal spawning, permission flow, or self-update behavior.

## Security invariants

The bridge is remote code execution by design. Flagless Slack spawns currently
default to Claude `--dangerously-skip-permissions` and Codex
`--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Pi's built-in tools are
unrestricted by default; SAB `--safe` adds fail-closed Slack tool approval,
while Pi `--approve` controls project resource trust only. Preserve explicit
operator overrides and document any change to these defaults prominently.

Only the bridge administrator or an explicitly assigned node operator may run
commands, resurrect sessions, or answer permissions, and a node operator may do
so only on their assigned nodes. Until node-role state exists, the historical
owner remains the sole operator. Collaborators may send labelled prompts only
to a live, explicitly allowed session. Spawned working directories must remain
contained under the execution node user's home directory, and remote launch
flags must use provider-specific allowlists.

Artifact uploads must require an owner or per-channel collaborator message,
live process/tmux proof, and a one-use expiring grant. Resolve every file's real
path and keep it inside the workspace captured by that grant; reject missing,
non-regular, escaped, oversized, or replayed uploads. Agents never select a
channel ID or arbitrary destination.

Team calls must additionally prove exact provider-process ancestry, PID/tmux,
native session, active channel, node, current owner turn or delegated task, and
directed team permission. Aliases are presentation only. Membership alone does
not authorize a collaborator prompt or stale provider leg to dispatch work.

Provider switching is owner-only. Queue owner prompts by channel during the
transaction, reject collaborator prompts, revoke source artifact grants on
commit, and mint new grants only when queued prompts enter the committed leg.
Automatic instruction alignment may inspect only repository-root `AGENTS.md`
and `CLAUDE.md`; never merge global/provider memory or `MEMORY.md`.

## Development workflow

1. Start from a clean branch or isolated worktree and inspect unrelated changes.
2. Add or update a regression test before changing compatibility-sensitive code.
3. Keep provider-specific behavior in `daemon/providers.mjs` or a clearly named
   adapter instead of scattering prefix checks across the daemon.
4. Use one canonical source for repeated command or identity data.
5. Update README, architecture, security, migration, manifest, and changelog when
   their contracts change.
6. Run the complete local validation suite before committing.

Required validation:

```bash
npm ci
npm run audit
npm test
npm run check
for file in daemon/*.mjs channel/*.mjs scripts/*.mjs; do node --check "$file"; done
PI_OFFLINE=1 pi --extension ./pi/sab-extension.ts --list-models
shellcheck -S warning bin/sab scripts/run-session.sh scripts/claude-consent.sh \
  scripts/sab-account.sh hooks/hook.sh hooks/codex-hook.sh \
  install.sh install-codex.sh install-pi.sh
```

For a release, also complete `docs/release-checklist.md`. Real Slack, Ghostty,
Claude, Codex, and Pi smoke tests happen only in a controlled maintenance window or
against a completely separate Slack app and tokens.

## Release rules

- Follow Semantic Versioning and Keep a Changelog.
- Release candidates use `vX.Y.Z-rc.N`; never label an untested worktree final.
- Preserve the previous release tag and configuration backup until the new
  daemon has passed Slack create/message/resume tests for all installed providers.
- Repository renames happen only after code, docs, installer migration, and old
  remote detection are ready together.
- Do not rewrite historical changelog entries merely to replace the former
  repository name; GitHub redirects preserve those release links.
