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
loopback event proxy mirrors only completed semantic commentary; it excludes
commands, output, diffs, plans, reasoning, deltas, and final-answer events.
If Codex rejects a submitted turn because its selected model is at capacity,
SAB replaces the working timer with that actionable failure instead of leaving
the channel apparently busy. The detector requires the exact current TUI
warning on a stable idle input surface and ignores stale terminal scrollback.
Claude `AskUserQuestion` forms use their structured hook payload, so Slack keeps
the question header, prompt, recommendation, option descriptions, and previews
separate from concise answer buttons. A bounded terminal parser remains only as
a restart/legacy fallback.
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

Fresh installs use `~/.slack-agent-bridge`. Existing
`~/.claudeslackproxy` checkouts, `~/.config/ccs` state, session channels, and the
historical `si.sergej.claudeslackproxy` LaunchAgent are retained. The installer
removes old launcher symlinks and installs only `sab` on `PATH`.

The staged `install-codex.sh` and `install-pi.sh` helpers can add provider
support without restarting the live daemon. Activation still belongs in a
controlled maintenance window.

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
| `/sab-new <claude\|codex\|pi> [folder] [flags]` | Start a headless session |
| `/sab-model [model]` | Show or change this session's model |
| `/sab-effort [level]` | Show or change reasoning/thinking effort |
| `/sab-flags [flags]` | Show or replace allowlisted launch flags |
| `/sab-update [all]` | Update this session, or safely sweep all idle active sessions |
| `/sab-stop` | Interrupt the current turn without ending the session |
| `/sab-switch <claude\|codex\|pi> [new]` | Hand this channel to another native provider leg |
| `/sab-kill [here\|session-id]` | End one exact provider process and keep its channel resumable |
| `/sab-status [claude\|codex\|pi]` | Show this session, or filter the control-channel list |
| `/sab-usage [provider] [days [n]\|models\|limits]` | Show provider usage |
| `/sab-run …` | Control Pi adaptive routing and managed runs |
| `/sab-account [name\|default]` | Show or change a Claude subscription |
| `/sab-terminal [list\|open\|close\|open-all\|close-all]` | Manage optional viewports |
| `/sab-team [create\|add\|status\|permissions\|remove\|close]` | Link SAB sessions for auditable delegation |
| `/sab-health` | Show daemon health |
| `/sab-cleanup` | Archive dormant session channels |
| `/sab-claim` | Claim an unowned bridge |
| `/sab-help` | Show the command list |

Ordinary messages are injected into the active native session. Attachments are
downloaded under the bridge attachment directory and their local paths are
included in the prompt. Dormant owner sessions resume headlessly; opening a
terminal is never required.

`/sab-update all` is the quiet-period maintenance sweep. It considers only the
authoritative live session bound to each channel, skips any session with an
active turn, question, permission, provider switch, managed Pi run, automation
ownership, delegated worker task, or restart already in progress, and reports
every skip or failure.
Each represented provider CLI is updated once; every eligible native session is
then resumed with its existing cwd, identity, account, model, effort, and launch
flags. Messages arriving during the relaunch are queued for that same session.
An idle Codex resume may not emit `SessionStart`; after a bounded hook grace
period, the bridge recovers it only by finding the Codex process beneath the
exact replacement tmux and validating that ancestry before repairing the
PID/channel binding. Daemon restart applies the same check to an interrupted
hookless resume, so `/sab-terminal open` becomes available again without a
second Codex process or a synthetic prompt.

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
preserved for a round trip.

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
```

The owner chooses workers with Slack's private-channel picker. Team identity is
bound to immutable channel IDs and survives channel renames and provider
switching. The default topology permits coordinator → worker tasks and worker →
coordinator replies/results; worker-to-worker relay is disabled. File relay is
off per worker until explicitly enabled.

Eligible owner turns receive private, provider-neutral role/tool context. A
delegated worker receives an exact task header, while collaborators receive no
lateral authority. The JSON-safe `sab team` CLI supports peers, send, bounded
mailbox/inbox, wait, reply, and task-bound file transfer. Tasks are atomically
journaled, visibly posted in both channels, queued only for a safe idle worker,
correlated with provider-stable final output, and fenced against restart/stale
leg duplication. Dormant peers are never resurrected by another agent.

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
```

The loopback-only API at `127.0.0.1:8877` provides
`POST /automation/sessions`, `GET /automation/sessions/:externalKey`, and
`POST /automation/sessions/:externalKey/stop`. `externalKey` is durable and
idempotent. Creation journals before launch, correlates the exact tmux/native
session/channel, invites and resolves every collaborator before whitelisting,
and injects the initial prompt at most once without an artifact grant. Exact
stop never delegates to bulk cleanup and archives only the correlated channel.

### Return generated files

Ask naturally for a file in a session channel. An accepted prompt receives a
short-lived, single-use capability for `sab upload`; the destination remains
fixed by the daemon. Paths must resolve to regular files inside that session's
workspace. At most ten files and 100 MiB total may be delivered. A grant cannot
be replayed or redirected.

### Claude accounts

```bash
sab account add work
sab account list
```

Use `/sab-account work` in a Claude channel or pass `--account work` to
`/sab-new claude`. Tokens remain in `~/.config/ccs/accounts` with mode `0600`
and never enter process arguments.

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

Required validation is defined in [`AGENTS.md`](AGENTS.md). Releases also use
the complete [release checklist](docs/release-checklist.md). Live Slack,
Ghostty, Claude, Codex, and Pi tests belong in a controlled maintenance window
or on a separate Slack app and token set.

## License

[MIT](LICENSE). Slack Agent Bridge is not affiliated with Anthropic, OpenAI,
Slack, or the Pi project.
