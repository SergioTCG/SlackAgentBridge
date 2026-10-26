# Slack Agent Bridge

Control local [Claude Code](https://claude.com/claude-code),
[Codex CLI](https://developers.openai.com/codex/cli/), and
[Pi](https://github.com/earendil-works/pi) sessions from Slack. Each native
session gets a private Slack channel where prompts, responses, progress, and
attachments flow both ways.

Version 2 has one command language everywhere: `sab` in a shell and `/sab-*`
in Slack. The active Slack channel selects its provider; only creation and
provider switching need an explicit `claude`, `codex`, or `pi` target.

Provider processes live in detached-capable tmux sessions. Ghostty is an
optional viewport, not a process-lifetime requirement: close every terminal and
the agents continue running; open or focus one later without resuming or
duplicating the native conversation.

> [!WARNING]
> **This is remote code execution by design.** Slack-spawned Claude sessions
> default to `--dangerously-skip-permissions`; Slack-spawned Codex sessions
> default to `--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Pi's
> built-in tools are unrestricted by default; SAB's optional `--safe` flag adds
> fail-closed Slack approval per tool call. Anyone able to act as the bridge
> owner can steer processes with that Mac user's privileges. Read
> [SECURITY.md](SECURITY.md) before installing.

> [!NOTE]
> The daemon currently targets macOS and launchd. Ghostty is needed only when
> terminal viewports are wanted. Claude uses its Channels API; Codex uses hooks,
> tmux, and a loopback App Server event proxy; Pi uses an explicitly loaded
> native extension.

> [!NOTE]
> Multi-machine support is being built around one Slack-facing coordinator and
> enrolled execution nodes, without duplicating the app or `/sab-*` commands.
> The current foundation can securely enroll and authenticate a node when an
> operator explicitly enables its separate WSS listener, but it does not yet
> route provider sessions to that node. Existing installs open no new listener
> and remain local-only. See
> [the accepted multi-node architecture](docs/multi-node-architecture.md).

## Capabilities

| Capability | Claude Code | Codex CLI | Pi |
|---|---:|---:|---:|
| Private channel per native session | ✓ | ✓ | ✓ |
| Slack prompts and attachments | ✓ | ✓ | ✓ |
| Return generated files to Slack | ✓ | ✓ | ✓ |
| Final responses and live working status | ✓ | ✓ | ✓ |
| Selected interim progress | ✓ | ✓ | managed runs |
| Model and effort controls | ✓ | ✓ | ✓ |
| Remote permission decisions | ✓ | ✓ | `--safe` |
| Token and cost usage | `ccusage` | `ccusage` | native ledger |
| Provider handoff in one channel | ✓ | ✓ | ✓ |
| Cross-session team delegation | ✓ | ✓ | ✓ |
| Persistent plans, goals, and review | — | — | adaptive `/sab-run` |
| Claude subscription switching | ✓ | — | — |
| Chrome integration | `--chrome` | no counterpart | no counterpart |

While a turn runs, its status and elapsed timer remain the newest channel item.
Daemon restarts re-adopt active turns and their original duration. Codex's
loopback event proxy mirrors completed semantic commentary and uses a completed
App Server turn as an exact final-answer fallback when Codex omits its Stop
hook. It excludes commands, output, diffs, plans, reasoning, and deltas; Stop
and App Server completion share a durable turn-level deduplication claim.
For a newly launched automation only, the typed root `thread/started` event also
supplies the native identity when that Codex release defers `SessionStart`; SAB
still requires the exact pending automation cwd, tmux, and provider-process
ancestry before adopting it. Child threads and ordinary sessions are ignored.
The Codex runner keeps the correlated App Server alive through the proxy's
bounded shutdown drain so a closing TUI cannot invalidate the final's ancestry
proof before delivery.
If Codex rejects a submitted turn because its selected model is at capacity,
SAB replaces the working timer with that actionable failure instead of leaving
the channel apparently busy. The detector requires the exact current TUI
warning on a stable idle input surface and ignores stale terminal scrollback.
If Codex starts a fallback model during a turn, SAB shows the actual model and
posts a warning while retaining the requested model/effort for the next
restart. A native Codex change becomes the new durable selection only when the
idle TUI renders its explicit `Model changed to …` confirmation; a plain footer
mismatch is treated as a possible capacity fallback and never changes the next
resume. Claude and Pi likewise resume with their latest known native
model/effort rather than their original launch values.
If Codex omits `UserPromptSubmit`, SAB starts tracking a bridge-injected turn at
the tmux boundary. If it also omits `Stop`, the correlated App Server
`turn/completed` final completes the exact owner or delegated turn. When neither
stable completion source arrives, two unchanged idle observations after the
grace period clear only the exact provider/task fences; a delegated task is
failed and released without replay. Replacement sessions and historical failed
tasks are never mutated. Status edits share a workspace-wide rate-safe, coalescing queue so a
long-running timer cannot starve ordinary Slack responses.
Claude `AskUserQuestion` forms use their structured hook payload, so Slack keeps
the question header, prompt, recommendation, option descriptions, and previews
separate from concise answer buttons. A bounded terminal parser remains only as
a restart/legacy fallback. Claude's explicitly configured local MCP server is
loaded with `--dangerously-load-development-channels server:slack-bridge`.
Claude Code 2.1.296 delivers a `server:` channel only that way; on `--channels`
it skips the server. Claude then asks for confirmation on every launch. SAB's
consent helper confirms only when the dialog lists exactly `server:slack-bridge`
and the affirmative row is visibly selected. When Claude asks for workspace
trust, SAB explicitly selects the affirmative row for the owner-requested
directory instead of assuming Enter is safe.
The bridge never parses Codex transcript JSONL. See
[ARCHITECTURE.md](ARCHITECTURE.md), the provider feasibility notes under
[`docs/`](docs/), and [Managed Pi runs](docs/pi-managed-runs.md).

## Prerequisites

- macOS
- Node.js 20 or later, `tmux`, `jq`, and `git`
- Optional [Ghostty](https://ghostty.org) for terminal viewports
- At least one configured Claude Code, Codex, or Pi CLI
- A Slack workspace where you may create or update an app

```bash
brew install node tmux jq git
```

## Install

Choose the provider set. A flagless install remains Claude-only for upgrades
from older releases.

```bash
# Claude only
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash

# One provider
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider codex
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider pi

# Claude + Codex, or all three
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider both
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider all
```

The installer opens a pre-filled Slack app page. Create the app, install it,
then supply the bot token (`xoxb-…`) and a Socket Mode app token (`xapp-…`,
`connections:write`). Run `/sab-claim` to bind the bridge to its owner.

The sole canonical manifest is
[`slack/app-manifest.json`](slack/app-manifest.json). A 1.x → 2.0 upgrade must
apply this manifest to the **existing Slack app** and reinstall that app once so
Slack registers `/sab-*` and removes the old provider-prefixed commands. This
does not require a second app, new tokens, or new OAuth scopes.

After upgrading to the session-team release, apply and reinstall the same
canonical manifest once more so Slack registers `/sab-team`. Existing tokens
and OAuth scopes remain valid.

The interactive-management release also enables the app's Home tab and routes
`app_home_opened` through the same Socket Mode daemon. Apply the canonical
manifest to the **existing app** and reinstall it once. No new OAuth scope,
token, callback URL, app, or daemon is required.

Fresh installs use `~/.slack-agent-bridge`. Existing
`~/.claudeslackproxy` checkouts, `~/.config/ccs` state, session channels, and the
historical `si.sergej.claudeslackproxy` LaunchAgent are retained. The installer
removes old launcher symlinks and installs only `sab` on `PATH`.

The staged `install-codex.sh` and `install-pi.sh` helpers can add provider
support without restarting the live daemon. Activation still belongs in a
controlled maintenance window. If a newly staged Pi extension meets an older
daemon, model and effort changes fail closed with a restart-required message;
they do not mutate an unverified native session. A staged activation must be
run from the checkout already named by the live LaunchAgent; invoking it from
an isolated development worktree fails before changing hooks, configuration,
Git state, or the public `sab` link.

Existing 2.2 installations should read [Migrating to
2.3](docs/migrating-to-2.3.md). Version 2.3 lets a team coordinator create
named worker automations that join its team with a first task, accepts
1M-context Claude model ids, and fixes automatic account handover for idle
Claude sessions. Nothing new is activated and no session state is migrated.

Existing 2.1 installations should read [Migrating to
2.2](docs/migrating-to-2.2.md). Version 2.2 adds opt-in account pools for
switching between Claude or Codex subscriptions, two-phase team task release,
per-provider updates, and automation release. Nothing new is activated and no
session state is migrated by the upgrade.

Existing 2.0 installations should read [Migrating to
2.1](docs/migrating-to-2.1.md). Version 2.1 adds interactive management, App
Home, durable team scheduling, and the lifecycle/delivery hardening needed for
long-running coordinator and worker sessions. It does not bulk-migrate session
state or change the historical LaunchAgent, local port, configuration path, or
Slack token set.

## Local CLI

Start a provider session in the current directory:

```bash
sab new claude --model opus --effort max --dsp --chrome
sab new codex --model gpt-5.6-sol --config 'model_reasoning_effort="xhigh"' --yolo
sab new pi --model qwen38-local/qwen3.8-27b --thinking xhigh
```

Use another working directory with `--cwd DIR`. All later arguments are passed
to the selected provider after SAB's provider-specific validation where the
daemon is involved.

Manage optional terminal viewports without changing session lifetime:

```bash
sab terminal list
sab terminal list --json
sab terminal open 01a0145c
sab terminal close 01a0145c
sab terminal open here
sab terminal close here
sab terminal open-all       # show-all is an alias
sab terminal close-all
```

`open` focuses an already attached Ghostty window. `close` detaches that exact
tmux client; it never kills the tmux session or provider. Bulk actions operate
only on authoritative active sessions, not standby or provisional provider
legs.

Other script-safe subcommands are:

```bash
sab account list
sab account add work
sab upload --grant TOKEN -- FILE_PATH...
sab team context --json
sab team send --to WORKER_ALIAS --stdin
sab team inbox --active --limit 20 --page --json
sab team checkpoint --task TASK_ID --pending ci,review --stdin
sab team complete --task TASK_ID --generation N --stdin
sab team message --task TASK_ID --stdin
sab team release --task TASK_ID
sab team continue --task TASK_ID --stdin
sab team cancel --task TASK_ID
sab team mutation --request-id REQUEST_ID --task TASK_ID
sab team mode draining
sab team wait --task TASK_ID --json
sab automation create ...
sab automation status EXTERNAL_KEY
sab automation stop EXTERNAL_KEY --archive
sab node status
sab node list
```

`sab node invite`, `enroll`, and `revoke` currently support authenticated
transport validation only. They do not make remote provider sessions available.
The coordinator listener is off unless `SAB_NODE_LISTEN` is explicitly set; a
non-loopback bind also requires `SAB_NODE_PUBLIC_URL`, `SAB_NODE_TLS_KEY`, and
`SAB_NODE_TLS_CERT`. See the multi-node architecture document before enabling
this preview surface.

There are no public `ccs*`, `sab-cc`, `sab-codex`, `sab-pi`, `sab-upload`, or
`sab-automation` executables in 2.0.

## Slack commands

A session channel always acts on its authoritative provider.

| Command | Effect |
|---|---|
| `/sab-new <claude\|codex\|pi> [folder] [flags]` | Choose a provider/project interactively, or start a headless session directly |
| `/sab-model [model]` | Choose or change this session's model |
| `/sab-effort [level]` | Choose or change reasoning/thinking effort |
| `/sab-flags [flags]` | Show or replace allowlisted launch flags |
| `/sab-update [current\|all\|claude-code\|codex\|pi]` | Choose an update interactively, or update this session, all eligible sessions, or one provider's eligible sessions directly |
| `/sab-stop` | Interrupt the current turn without ending the session |
| `/sab-switch <claude\|codex\|pi> [new]` | Hand this channel to another native provider leg |
| `/sab-kill [here\|session-id]` | End one exact provider process and keep its channel resumable |
| `/sab-status [claude\|codex\|pi]` | Show this session plus controls, or filter the control-channel list |
| `/sab-usage [provider] [days [n]\|models\|limits]` | Show provider usage |
| `/sab-run …` | Control Pi adaptive routing and managed runs |
| `/sab-account [name\|default]` | Show or change a Claude subscription |
| `/sab-terminal [list\|open\|close\|open-all\|close-all]` | Manage optional viewports |
| `/sab-team [create\|add\|status\|auto\|manual\|drain\|resume\|permissions\|remove\|close]` | Link SAB sessions for auditable delegation, bounded continuation, and queue control |
| `/sab-health` | Show daemon health |
| `/sab-cleanup` | Archive dormant session channels |
| `/sab-claim` | Claim an unowned bridge |
| `/sab-help` | Show the command list |

Ordinary messages are injected into the active native session. Attachments are
downloaded under the bridge attachment directory and their local paths are
included in the prompt. Dormant owner sessions resume headlessly; opening a
terminal is never required. A Claude wake is successful only after its exact
`SessionStart` claim; a provider that exits after briefly creating tmux is
retried once and then reported visibly while the queued message remains safe.

Archiving a session channel in Slack retires it. Once its sessions have
stopped, SAB removes the channel's records and saved handoffs within the hour
and reports this in the control channel; a team whose channels are all
archived is closed. A session still running in an archived channel continues
until it ends or you run `/sab-kill <id-prefix>` from any SAB channel.

Management commands are interactive when invoked without arguments. `/sab-model`
and `/sab-effort` show provider-valid selectors; `/sab-terminal`, `/sab-update`,
`/sab-switch`, `/sab-new`, and `/sab-team` show bounded buttons or pickers.
`/sab-status` adds a consolidated dashboard for the current session, while the
control-channel dashboard exposes bridge-wide session, terminal, update,
health, and usage controls. Parameterized forms such as `/sab-terminal open`,
`/sab-model gpt-5.6-sol`, and `/sab-update all` remain available. Use
`/sab-update current` for a non-interactive current-session update.

Every click is rechecked against the immutable channel ID, exact authoritative
session/provider, current provider catalog, transition state, and the existing
team/update safety gates. A stale control therefore fails visibly instead of
acting on a replacement leg. Session identity is held unchanged across slow
lookups, Claude's standard and 1M-context model entries carry distinct exact
provider IDs, and team buttons are tied to the exact team that rendered them.
Broad update and team-close actions require Slack
confirmation. These panels are only a presentation layer over the normal
`/sab-*` dispatcher.

Pi model and effort controls additionally require the running extension to
advertise exact-session fencing. A Pi process preserved across a daemon upgrade
may still contain the older extension; SAB refuses the mutation and asks for
`/sab-update current` instead of assuming that process understands the new
control protocol.

### App Home

Open *Slack Agent Bridge* under Slack's Apps section for a persistent owner
dashboard. It lists authoritative session channels and provides exact session,
terminal, model, effort, switch, update, team, usage, health, and new-session
controls. The new-session modal requires an explicit provider and a current
top-level project folder; launch flags pass through the existing provider
allowlist.

App Home rebuilds from authoritative state whenever it is opened or refreshed.
Results remain visible in the bridge control channel or affected session
channel rather than becoming private, unaudited Home-only state. Non-owners see
a restricted view containing no session IDs, channel IDs, folders, settings, or
actions.

`/sab-update all` is the quiet-period maintenance sweep. It considers only the
authoritative live session bound to each channel, skips any session with an
active turn, question, permission, provider switch, managed Pi run, automation
ownership, delegated worker task, or restart already in progress, and reports
every skip or failure.
Each represented provider CLI is updated once; every eligible native session is
then resumed with its existing cwd, identity, account, model, effort, and launch
flags. `/sab-update claude-code`, `/sab-update codex`, and `/sab-update pi` run
the same sweep for a single provider: only that provider's CLI is updated and
only its sessions restart, while other providers' sessions are left out of scope
entirely rather than reported as skipped. Messages arriving during the relaunch are queued for that same session.
If the provider replaces its native identity during maintenance, the queue and
restart fences follow only that verified in-place rebind. Direct input reopens
only after the shared ordered drain submits all queued prompts, including later
arrivals. Launch arguments and reconnecting provider streams never consume that
queue independently. A failed wake or startup-metadata call preserves the
queue, reports the exact recovery action, and allows a later owner message to
retry a genuinely dormant session. One-use artifact grants embedded in those
prompts follow only the verified same-provider/channel native replacement.
An idle Codex resume may not emit `SessionStart`; after a bounded hook grace
period, every update, settings change, and ordinary Slack wake recovers it only
by finding the Codex process beneath the exact replacement tmux and validating
that ancestry before repairing the PID/channel binding. Daemon restart applies
the same check to an interrupted hookless resume, so `/sab-terminal open`
becomes available again without a second Codex process or a synthetic prompt.

SAB-managed Codex TUIs disable Codex's interactive startup update check. This
prevents a detached new, resumed, automation, or provider-switch session from
waiting on a local update chooser before it can bind to Slack. Codex upgrades
remain explicit through `/sab-update` and `/sab-update all`; the internal
setting is not added to stored or user-visible launch flags.

Flagless `/sab-new claude` and `/sab-new codex` use the dangerous defaults
described above. Explicit flags replace those defaults. Operator overrides
remain available through the existing `CCS_NEW_FLAGS`, `CCS_RESUME_FLAGS`,
`CCS_CODEX_NEW_FLAGS`, `CCS_CODEX_RESUME_FLAGS`, `CCS_PI_NEW_FLAGS`, and
`CCS_PI_RESUME_FLAGS` settings. Pi's `--safe` controls tool approval; Pi's
native `--approve` separately controls project-resource trust.

### Provider switching

Run `/sab-switch <target>` from an idle session channel. The bridge captures a
private structured handoff, starts or resumes the target's own native
conversation, validates it privately, and changes the channel mapping only
after success. The source native leg is then dormant standby state; its terminal
and provider process have stopped, but its resumable native ID and settings are
preserved for a round trip. Claude Code deletes conversations idle for 30 days
by default (`cleanupPeriodDays`). When a standby Claude leg's conversation is
gone, `/sab-switch claude new` replaces it with a new native leg.

Messages arriving during the transaction are queued. Failure or daemon restart
rolls back to the source. Provider-specific model, effort, flags, and Claude
account settings are never translated. Instruction reconciliation reads only
repository-root `AGENTS.md` and `CLAUDE.md`, proposes an ordinary reviewed Git
patch, and never imports global memory or `MEMORY.md`.

### Collaborators

`/sab-status` in a session channel shows the collaborator picker. The bridge
invites a selected user to the private channel first and adds them to the prompt
allowlist only after invitation succeeds. Collaborators may send labelled
prompts to a live allowed session; they cannot run commands, answer permission
requests, or resurrect it.

### Session teams

One SAB session channel can coordinate explicitly linked worker channels without
giving an agent Slack credentials or arbitrary channel access:

```text
/sab-team create hexagonal-cleanup
/sab-team add
/sab-team permissions codex-barrique-parallel-1 files on
/sab-team status
/sab-team auto   # opt into bounded continuation; use /sab-team manual to disable
/sab-team auto-release on   # release ready, gate-free work without a coordinator turn
/sab-team drain  # finish active tasks but dispatch nothing queued; resume later
```

The owner chooses workers with Slack's private-channel picker. Team identity is
bound to immutable channel IDs and survives channel renames and provider
switching. The default topology permits coordinator → worker tasks and worker →
coordinator replies/results; worker-to-worker relay is disabled. File relay is
off per worker until explicitly enabled. Automatic mode coalesces concurrent
executor events into one coordinator wake because that wake rereads the complete
authenticated inbox. If a long-lived coordinator consumes its 20-dispatch turn
budget, a pending authenticated worker event renews one bounded continuation
budget; it does not grant unlimited dispatch. If a resumed Codex coordinator omits its completion hook,
SAB uses bounded exact-process idle confirmation to release only the stale turn
fence; prolonged legitimate waits are reported once in the coordinator channel.

Drain mode is separate from continuation mode. `/sab-team drain` lets active
workers finish while preventing every queued claim and automatic coordinator
wake; `/sab-team resume` makes queued work eligible again. It does not cancel
or stop a provider. From an authenticated coordinator turn, `sab team cancel`
and `sab team replace` control one exact queued task, while `sab team message`
adds an audited instruction or answer to the exact worker/session currently
owning an active task.

New tasks use two-phase completion. A provider final or a continuously proved
hookless idle surface creates an `awaiting_release` turn report and keeps the
worker reserved. Workers publish the complete list of unfinished gates with
`sab team checkpoint`, clear that list and declare readiness with `sab team
complete`, and only then may the coordinator use `sab team release`. A
coordinator follow-up invalidates the previous readiness declaration. If work
was already released accidentally, `sab team continue` creates a new, linked,
auditable task rather than reopening a terminal journal entry. An accepted
follow-up immediately fences completion and release until exact provider
delivery succeeds; reports are bound to the corresponding durable work
generation, so a delayed final from the preceding turn cannot release newer
work.

Eligible owner turns receive private, provider-neutral role/tool context. A
delegated worker receives an exact task header, while collaborators receive no
lateral authority. The JSON-safe `sab team` CLI supports peers, send, bounded
filtered/paginated inbox, wait, reply/checkpoint, explicit complete/release,
linked continuation, mutation receipts, queued-task cancel/replace, active-task
messaging, drain/resume, and task-bound file transfer. Tasks are atomically
journaled, visibly posted in both channels, queued only for a safe idle worker,
correlated with provider-stable turn reports, and fenced against restart/stale
leg duplication. A coordinator may wake a dormant worker only with
`sab team wake --to ALIAS`, and only while that worker holds an active task in
its team. SAB itself wakes a dormant standing worker once a pending follow-up
is waiting. `sab team schedule --every 15m` registers a bounded timer wake, and
`sab team tree --json` shows the team hierarchy for monitoring.

If an exact live Codex worker visibly returns to its idle prompt after a task
but omits the completion hook, SAB records a warning-bearing turn report; it
does not fabricate a failure, invent a final, or release the worker. An already
idle pre-upgrade task found during daemon boot has no equivalent continuous
proof and still fails closed. An `awaiting_release` task and its exact worker
binding survive daemon restart, including while the provider is dormant.
An owner message in the dormant worker channel may wake that same reserved
session without becoming unrelated provider input; any durable coordinator
follow-up is already visible in both channels and is delivered after re-adoption.
Availability and the `queued → dispatching` task claim are persisted together,
and context output includes observation time plus the last task/availability
transition reason.

Teams nest into an owner-rooted hierarchy of at most two team levels. A channel
may coordinate one team and also be a worker in one parent team. For example:
main → epic coordinators → executors. A task to a sub-team coordinator is
*standing*: it binds the exact session for replies and completion but never
reserves its turns, so its own team keeps working, and it lives 30 days past
its last activity. The turn handling that task, or a follow-up for it, carries
bounded delegated authority for the coordinator's own team. Questions travel up
with `sab team reply` and answers down with `sab team message`, one edge at a
time. `/sab-team auto-release on` lets SAB release ready work itself. A team
closes when its coordinator channel is archived. A coordinator can create a
nested coordinator with `sab automation create --team main --create-team
epic-a`.

See [Session teams](docs/session-teams.md) for the complete workflow, limits,
recovery behavior, and file boundary. Initial relay is local-node only; the
durable identities are compatible with the accepted multi-node protocol.

### Managed Pi runs

Owner prompts are adaptively routed by default. Use `/sab-run mode auto`,
`always`, or `native`; `/sab-run direct <prompt>` bypasses routing once.
`/sab-run [plan] <goal> [--minutes=N --turns=N --agents=N --reviews=N]` forces a
bounded planner/worker/reviewer run. Status and control actions are
`/sab-run status`, `approve`, `pause`, `continue`, and `cancel`.

### Script-facing automation

Use the JSON-safe client instead of constructing curl payloads:

```bash
sab automation create \
  --external-key 'github:org/repo#123' \
  --cwd /Users/example/Code/repo-worktree \
  --provider claude \
  --collaborator U0123456789 \
  --prompt-file /path/to/prompt.txt \
  -- --model opus --effort max --dsp --chrome

sab automation status 'github:org/repo#123'
sab automation stop 'github:org/repo#123' --archive
sab automation validate-flags --provider codex -- \
  --model gpt-5.6-sol --effort xhigh --yolo
```

The loopback-only API at `127.0.0.1:8877` provides
`POST /automation/sessions`, `GET /automation/sessions/:externalKey`, and
`POST /automation/sessions/:externalKey/stop`. `externalKey` is durable and
idempotent. Creation journals before launch, correlates the exact tmux/native
session/channel, invites and resolves every collaborator before whitelisting,
and injects the initial prompt at most once without an artifact grant. Exact
stop never delegates to bulk cleanup and archives only the correlated channel.
For a completed one-off bootstrap, `sab automation release EXTERNAL_KEY
--session NATIVE_ID --channel CHANNEL_ID --tmux EXACT_TMUX --request-id ID`
releases ownership without stopping the session or losing collaborators. It
requires completed invitation/prompt setup and the exact live local binding,
retains external-key idempotency, and forbids later automation stop from
touching the retained session. It is not stop/archive or a new launch.
`validate-flags` is local and side-effect free. It lets project automation
validate and canonicalize the same provider argv before allocating its own
worktrees, databases, or ports. Codex accepts both split and inline model/effort
forms; arbitrary `--config` remains forbidden, while safe effort input is
translated to Codex's native `model_reasoning_effort` override. Claude accepts
the exact 1M-context model ids, such as `--model claude-opus-5-5[1m]`.

`--channel-name NAME` creates the private channel under exactly that Slack name
(lowercase letters, digits, `-` and `_`, at most 80 characters) before anything
is launched. An existing name fails closed with `channel_name_taken`; nothing is
journaled, so the same external key may be retried with another name.

A team's coordinator can create its own workers without an owner click:

```bash
sab automation create \
  --external-key 'github:org/repo#2995' \
  --cwd /Users/example/Code/repo-2995 \
  --provider claude \
  --channel-name cc-repo-2995-holding-lines \
  --team epic-2990 --alias issue-2995 \
  --task-file /path/to/task.md \
  -- --model 'claude-opus-5-5[1m]' --effort max --dsp
```

The command must run inside the live SAB session that coordinates `epic-2990`,
during an owner or automatic-continuation turn; it consumes one dispatch from
that turn's budget, like `sab team send`. The new channel joins the team as
worker `issue-2995` (default: the channel name) in the same journal write that
binds the channel to the automation, and its provenance is recorded. With
`--task-file`, the worker's first team task is created at the same time and
delivered as its initial prompt, with the normal task header, after
collaborator setup. Only the channel that this automation call creates can
join; an existing channel is never added programmatically, and the team's
member limit still applies. `sab automation stop KEY --archive` removes that
membership again and closes any team the stopped session coordinated; task
journals and Slack audit cards remain.

### Return generated files

Ask naturally for a file in a session channel. An accepted prompt receives a
short-lived, single-use capability for `sab upload`; the destination remains
fixed by the daemon. Paths must resolve to regular files inside that session's
workspace. At most ten files and 100 MiB total may be delivered. A grant cannot
be replayed or redirected.

### Accounts and staged pools

```bash
sab account add work
sab account list
```

Use `/sab-account work` in a Claude channel or pass `--account work` to
`/sab-new claude`. Tokens remain in `~/.config/ccs/accounts` with mode `0600`
and never enter process arguments.

Account-pool preparation is available as **read-only local tooling**:

```bash
sab account preview --json
sab account capabilities --probe --json
```

The preview proposes one-member groups for existing aliases and native defaults,
coalesces identical stored Claude credentials, and maps authoritative local
session bindings without changing any file, permission, account, or session.
Cached email addresses are explicitly **unverified candidates**; they are never
used to merge accounts or infer independent quota. Names and candidate IDs in
the report are proposals, not a new registry.

`capabilities` reports documented interfaces. Optional `--probe` checks installed
Claude help and Codex public schemas in disposable configuration directories,
without credentials, login, RPC, inference, or session launch. Both commands
accept `--provider claude|codex|all`; JSON output never includes credentials,
token fragments, or credential hashes. No `--apply` operation exists.

Automatic rotation, active usage polling, email renaming, and Codex account
switching are **not enabled** by these commands.

An opt-in, **inactive metadata registry** can record owner-confirmed email
identities, credential references, groups, and exact channel restrictions:

```bash
sab account registry plan --input enrollment.json --json
sab account registry stage --input enrollment.json --expected-revision 0 --json
sab account registry status --json
sab account registry check --channel C0123456789 --provider claude --json
```

The enrollment file must be private (`0600`); `--input -` accepts JSON on stdin.
Staging writes only private, atomic metadata revisions, never credentials or
session bindings. Repeating a request ID is idempotent; conflicting requests
and stale revisions fail closed. Email is presentation/selection data; opaque
account IDs remain stable. Policy checks enforce both group membership and an
account's own channel ceiling, even when selected by a legacy alias. Their
`runtimeAllowed: false` result is deliberate: staging/checking alone never
activates runtime policy. The daemon keeps legacy behavior by default.

The experimental runtime is opt-in with `CCS_ACCOUNT_POOLS=shadow|manual|auto`
(`off` by default). Shadow mode samples subscription quotas without switching;
manual mode permits exact idle-session handovers; auto additionally requires
fresh eligible quota and a successful manual resume proof for that account
pair. `/sab-account` then shows email identities, group, and quota freshness for
Claude and Codex; `/sab-usage limits` uses the same observations. Unknown,
expired, scope-limited, or stale evidence never grants capacity. Active turns,
delegated work, questions, permissions, automations, and maintenance block
handover. No existing binding is bulk-migrated.

Shadow mode keeps legacy account switching and launch overrides unchanged.
Manual/auto pooled Codex launches deliberately use file auth storage for both
the native default and named profiles, matching the identity actually probed;
an unrelated keyring login is never counted as the verified file identity.

```bash
sab account pool status --channel C0123456789 --json
sab account pool refresh --account ACCOUNT_ID --json
sab account pool switch --channel C0123456789 --session NATIVE_ID \
  --account owner@example.test --request-id unique-owner-request --json
sab account group list --json
sab account group add owner second-claude --revision 3 --request-id add-second --json
sab account group drain-member owner second-claude --revision 4 --request-id drain-second --json
sab account login-claude second-claude
sab account login-codex second-codex
```

Owner-only maintenance of an idle Claude worker with a reported, still-reserved
task can explicitly add `--preserve-task TASK_ID` to `pool switch`. SAB keeps its
assignment, gates, reports and readiness unchanged. It refuses running turns,
pending messages, extra panes or unknown child jobs, fences task mutations
during the journaled restart, and never replays instructions or marks work
complete. This is manual maintenance, not automatic active-task failover.

These owner-machine endpoints are loopback-only and disabled in `off` mode.
Additional Claude/Codex logins can be enrolled explicitly with `sab account
login-claude PROFILE` / `login-codex PROFILE` and referenced as `claude-profile`
/ `codex-profile` credentials. Authentication is
isolated; native history/settings/resources are shared without SAB reading
transcripts. Installation and staging never log in or enable runtime modes.
A new Claude profile inherits only the native login's first-run completion
markers, so a detached launch does not stop at the theme, security-notes or
Chrome intro screens. Claude in Chrome follows the claude.ai account of the
Chrome extension: a session switched to another subscription has no browser
tools unless a browser signed in to that account is available.
Use a controlled canary before manual/automatic handover. Claude setup tokens
without profile/usage scope cannot supply automatic capacity proof. Instant
mid-tool switching or never hitting provider limits cannot be guaranteed.

`/sab-account` includes an exact-session/revision-bound email picker and usage
controls. `/sab-account groups` lists registered groups. `sab account group`
supports create/rename/remove, add/delete-member/drain-member, and provider
preferences. `sab account manage --input FILE|-` (or owner-only `/sab-account
manage <JSON>`) handles account enrollment, credential attachment, drain/retire/
enable, and channel routing. In-use removal fails closed; explicit draining
never kills a turn or deletes credentials. Isolated inactive profiles use native
provider refresh under an exclusive lease; the default machine login is never
refreshed by SAB. Full-scope enrollment and controlled native resume proofs are
still required before unattended rotation.

The enrollment schema, staged design, evidence limits, and remaining
maintenance proofs are in
[Account pools and migration preparation](docs/account-pools.md). Existing
legacy `/sab-account` behavior and the Slack manifest are unchanged by default.

## Upgrading to 2.0

Version 2 intentionally removes the provider-prefixed Slack namespaces and all
legacy terminal launchers. It preserves the data plane needed to resume
existing work:

- `~/.config/ccs`, old records with no provider, and historical tmux names;
- existing private channels and immutable channel mappings;
- existing `~/.claudeslackproxy` installations;
- port `8877`, `CCS_*` operator settings, and the historical LaunchAgent label;
- the existing Slack app and token set.

Read [Migrating to 2.0](docs/migrating-to-2.0.md) before rollout. Apply the
canonical manifest to the existing Slack app, install the release during a
maintenance window, and run the canary in
[`docs/release-checklist.md`](docs/release-checklist.md). Do not run two daemons
with the same Socket Mode token.

## Operations and development

- Config/state: `~/.config/ccs/`
- Logs: `~/.config/ccs/daemon.log`
- Disable self-update: `CCS_AUTO_UPDATE=0`
- Optional dockless Ghostty viewports: `CCS_GHOSTTY_HIDDEN=1`
- Local API: loopback port `8877`; never proxy or expose it

Required validation is defined in [`AGENTS.md`](AGENTS.md). Releases use the
[stability policy](docs/stability-policy.md) and complete
[release checklist](docs/release-checklist.md). Live Slack,
Ghostty, Claude, Codex, and Pi tests belong in a controlled maintenance window
or on a separate Slack app and token set.

## License

[MIT](LICENSE). Slack Agent Bridge is not affiliated with Anthropic, OpenAI,
Slack, or the Pi project.
