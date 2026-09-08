# Session teams

Session teams let one SAB channel coordinate explicit work in other SAB
channels without giving Claude Code, Codex, or Pi Slack credentials or generic
channel access. The first release is local-node only and uses a safe star:

```text
coordinator ── task/text/optional files ──▶ worker
coordinator ◀── reply/checkpoint/turn report/optional files ── worker
```

Worker-to-worker relay and arbitrary Slack history reads are not available.
Provider-native subagents remain separate from this bridge-owned workflow.

## Create and administer a team

Run these commands as the bridge owner. Start in the channel that should be the
coordinator:

```text
/sab-team create hexagonal-cleanup
/sab-team add
/sab-team status
/sab-team permissions
/sab-team drain
/sab-team resume
```

`/sab-team add` opens Slack's private-channel picker. SAB accepts only a channel
with an exact authoritative local session mapping. It stores the immutable
channel ID, while the current channel name becomes a display alias. Renaming a
Slack channel or switching its active provider does not break membership.

Text, task state, replies, turn reports, and released results are enabled by the star
topology. File relay starts off for every worker. Enable or revoke it explicitly:

```text
/sab-team permissions codex-barrique-parallel-1 files on
/sab-team permissions codex-barrique-parallel-1 files off
```

Remove one worker or close the entire team with:

```text
/sab-team remove codex-barrique-parallel-1
/sab-team close
```

Membership and permission changes are persisted before SAB acknowledges them
and are announced in affected channels. Removal or closure cancels exact queued
or active team tasks but does not stop the underlying provider sessions.
`/sab-cleanup` preserves dormant team channels until membership is removed or
the team is closed.

`/sab-team drain` is a durable queue gate: active workers may finish, while
queued tasks and automatic coordinator continuations remain parked. It does not
stop a provider or discard work. `/sab-team resume` re-enables dispatch. This is
independent of `/sab-team auto` and `/sab-team manual`, which control whether
authenticated worker events may wake the coordinator.

Applying this feature requires updating and reinstalling the existing canonical
Slack manifest so `/sab-team` is registered. It needs no new OAuth scope, no new
Slack app, and no second Socket Mode daemon.

## How agents discover their role

Roles are bridge state, not a sentence remembered by a model:

- Every owner prompt in a coordinator channel receives a concise private team
  context containing the team name, coordinator role, worker aliases, and the
  `sab team` interface.
- An ordinary owner prompt in a worker channel receives a worker context that
  explicitly says it is not delegated work.
- A delegated worker turn receives an immutable private task header with its
  task ID, team, coordinator origin, reply commands, and destination-local file
  paths.
- Every `sab team` call independently proves the exact provider process,
  process ancestry, tmux, native session, authoritative channel, and local node.
- Nested provider utilities such as `codex review` are not sessions: SAB detects
  the existing provider ancestor and denies channel registration and team tools.

This repeated injection survives compaction, long-lived sessions, model
changes, and provider switching. It does not modify `AGENTS.md`, `CLAUDE.md`,
provider memory, or a global prompt.

Only an owner-initiated coordinator turn receives bounded dispatch authority.
A collaborator prompt deliberately clears that authority. A worker receives
only the ability to reply to the one active task bound to that exact native
session. Local terminal input, session replacement, interruption, team removal,
and provider switching revoke or invalidate stale authority.

## Agent-facing CLI

The provider can use the sole public executable without constructing HTTP or
Slack payloads:

```bash
sab team context --json
sab team peers --json
sab team send --to WORKER_ALIAS --stdin
sab team send --to WORKER_ALIAS --stdin --request-id STABLE_ID
sab team inbox --after TASK_ID --limit 100 --json
sab team inbox --active --target WORKER_ALIAS --status queued,running --limit 20 --page --json
sab team inbox --since 2026-09-07T08:00:00Z --cursor OPAQUE_CURSOR --limit 20 --page --json
sab team wait --task TASK_ID --timeout 3600 --json
sab team reply --task TASK_ID --stdin
sab team checkpoint --task TASK_ID --pending tests,ci,review,merge --stdin
sab team checkpoint --task TASK_ID --pending none --stdin
sab team complete --task TASK_ID --stdin
sab team release --task TASK_ID
sab team continue --task TASK_ID --stdin
sab team message --task TASK_ID --stdin --request-id STABLE_ID
sab team replace --task TASK_ID --stdin --request-id STABLE_ID
sab team cancel --task TASK_ID --reason 'Merged elsewhere.' --request-id STABLE_ID
sab team mutation --request-id STABLE_ID --task TASK_ID
sab team mode draining
sab team mode active
sab team send-file --to WORKER_ALIAS --message 'Inspect these.' -- report.pdf
sab team send-file --task TASK_ID --message 'Interim artifact.' -- result.json
```

`--request-id` makes a caller retry return the original mutation instead of
creating another side effect. Without it, the CLI generates a UUID. Every
successful mutation returns the persisted receipt. If the client times out,
the printed request ID and `sab team mutation` lookup distinguish an
accepted operation from a pre-acceptance failure without guessing. Text input,
mailboxes, active queues, task lifetime, replies, file count, and aggregate
bytes are bounded. Agent-visible JSON contains aliases and authorized
collaboration envelopes, not raw Slack destination IDs.

The modern inbox cursor walks older results and is returned only with `--page`;
each result includes the original bounded instruction, lifecycle version,
replies, coordinator messages, and known timestamps. `--active`, `--target`,
`--status`, and `--since` may be combined. The historical `--after TASK_ID`
form still returns newer tasks for compatibility, but cannot be mixed with the
new filters or cursor.

Task control is coordinator-only and turn-scoped. `replace` and `cancel` apply
only while the exact task is still queued. `message` applies only to the exact
active task and journals the operation before posting it visibly in both
channels and injecting it into the same authoritative worker session. Retries
need the same request ID and content. Delivery is rejected while the worker has
an open question or permission prompt, because that is not a safe text-input
surface. An uncertain provider-side message is reported and never replayed.
If Pi has no connected input stream, no provider write has occurred: the
message remains pending and the reconciler submits it once after the exact
authoritative stream reconnects.

## Completion and release

New tasks are not complete merely because one provider turn ends. Their
lifecycle is:

```text
queued → dispatching → running → awaiting_release → completed
```

While working, the worker uses `checkpoint` to publish the complete current set
of unfinished gates. Typical names are `tests`, `ci`, `runtime`, `review`, and
`merge`; names are opaque bounded labels, so SAB does not pretend it can infer
external CI or deployment truth. `complete` is rejected while any gate remains.
After the worker clears all gates, it calls `complete` with a summary and then
finishes its provider turn. The resulting report is delivered to the
coordinator, but the exact worker session remains reserved until `release`.
`sab team wait` therefore continues waiting while a task is
`awaiting_release`; the coordinator should inspect `releaseReady`, reports, and
pending gates in the inbox.

The coordinator may use `message` for questions or amendments while the task is
reserved. Any such follow-up invalidates the previous completion declaration;
after confirmed delivery the task returns to `running` and the worker must
declare completion again. If a terminal task needs more work, `continue`
creates a new task linked through `parentTaskId`; terminal history is immutable.

Tasks created by older bridge releases do not contain a completion policy and
retain their historical provider-final completion behavior. This deliberate
compatibility boundary prevents a daemon update from changing the meaning of
an already-running task.

The coordinator may send up to 20 tasks in one current owner or automatic
continuation budget. When that budget is exhausted, automatic mode can renew one
bounded budget only by atomically claiming pending authenticated worker events
for the same team. It cannot renew from a collaborator, another team, stale
local input, or no event. A team holds at most 64 active tasks and one worker at
most eight active tasks, only one of which may hold its session binding. Each
task accepts at most 32 interim replies and
32 idempotent control operations; terminal cancellation remains available if the
control journal is full. Tasks expire after seven days. Overflow, expiry,
revocation, and identity disagreement fail visibly.

## Delivery and recovery

SAB journals a unique task and request identity atomically before any Slack or
provider side effect. It then posts the complete bounded task plus a status card
in both channels. A busy worker remains visibly queued; a dormant worker is not
resurrected by another agent. The owner may wake that session normally, after
which the task waits for a safe idle input surface.

Before injection, SAB reserves the input surface and atomically claims the exact
worker native session and the exact instruction revision already visible on
both Slack audit cards. Concurrent replacements serialize those card updates;
a changed or partly audited revision cannot be claimed. That same persisted mutation binds
`session.teamActiveTaskId` and populates `startedAt`, so status cannot report the
worker ready while its task is `dispatching`. It remains `dispatching` until the provider acknowledges
the immutable task marker or that exact process journals a task-bound `sab team
reply`. The latter proves that work was accepted when a prompt hook is missing,
restores Codex status tracking, and survives restart; it never substitutes for
a stable turn report. A daemon restart may deliver a still-queued task, but it never
retries a genuinely uncertain claim. That trades a visible failure for duplicate
work. If the claimed envelope was waiting in an in-memory provider queue, SAB
removes that exact marker before reporting failure so a later reconnect cannot
execute it.

In automatic mode, every authenticated worker reply—including ordinary progress
and idempotent retries that heal a dispatch—is a wake candidate. Multiple events
accumulated while the coordinator is busy are represented by one durable wake;
the coordinator always rereads the complete authenticated inbox, so old event
payloads are neither replayed nor trusted. Events are keyed and durably
deduplicated by task, reply, and task-lifecycle version, so a hook retry cannot
produce another wake while a real later state transition still can. If the same provider turn remains
active long enough to spend its current dispatch budget, the queued event may
instead be claimed to establish the next bounded continuation budget; SAB
persists that claim before creating another task. A resumed Codex TUI that omits lifecycle hooks is reconciled only after
two unchanged, exact-process idle observations and a grace period. SAB then
clears the stale coordinator fence and proceeds without scraping a final answer
or assigning a worker result. A genuine busy wait is reported once after one
minute and continues to retry safely.

If the daemon stops after claiming a continuation but before settling it, boot
recovery accepts that wake only when the exact coordinator process and provider
turn are still live. An unprovable provider attempt is marked interrupted and
is never replayed; SAB posts an owner-actionable notice and leaves later durable
events available rather than keeping the team permanently wedged behind an
`active` journal entry. Persisted provider start timestamps alone are not live
proof: a provider-specific post-restart event must restore the in-memory turn
poller before the interrupted wake can be adopted.

The same fallback covers an ordinary owner turn in a resumed Codex worker. Once
the exact authoritative worker process has shown the unchanged idle input
surface twice, SAB clears only that worker's stale owner-turn/input fences,
persists the change, and wakes queued-task reconciliation. A delegated task,
changed PID/tmux/session, queued input, or failed historical task resets the
proof, so a fresh task is claimed at most once and old work is never replayed.

For a delegated Codex task observed continuously by the live poller, the same
stable idle proof means the injected turn ended even if Codex omitted both
acknowledgement and completion hooks. SAB records a warning-bearing turn report
and keeps the worker reserved; it neither fabricates a stable final nor
implicitly certifies task completion. Boot-time idle is deliberately different
for a legacy running task: SAB cannot prove whether a journaled dispatch reached
the old provider, so that historical task fails closed. A durable
`awaiting_release` report needs no replay and is reattached to the exact session
binding after daemon restart, including while the provider process is dormant.
An owner message in that dormant worker channel wakes the same reserved native
session but is deliberately not submitted as unrelated task input. Coordinator
follow-ups accepted during downtime remain durable, are mirrored in both team
channels, and enter the provider exactly once after re-adoption.

For Pi, a persisted turn-start timestamp is not post-restart liveness proof.
SAB waits for a new native extension status/start event before restoring its
poller or delegated-task authority; otherwise recovery releases the stale task,
poller, and input fences without replay.

Claude transcript completion, the Codex Stop hook or exact successful App Server
turn, or the Pi extension supplies a stable provider turn report. SAB persists
that report plus an idempotent Slack delivery claim before reporting it in the
coordinator channel. Explicit coordinator release later persists terminal
completion and its own delivery claim. Restart
reconciliation either proves the original turn is still active or visibly
releases it without attributing a later final. Deleted or otherwise uneditable
status cards are reported alongside the result but never prevent result
delivery. Terminal tasks from the pre-claim journal format are recognized as
already delivered during upgrade rather than posted a second time. Pending
completion, report, reply, coordinator-message, or file delivery prevents journal pruning; SAB persists a
pruned journal before deleting its private file copies.

SAB keeps the provider-owned tmux session intact throughout reporting and
release; it does not terminate the provider, a task PTY, a container, or a
background job merely because a turn ended. It can durably re-adopt the SAB
tmux/provider binding and external jobs identified by the task, but it cannot
generically resurrect arbitrary child processes after an operating-system
reboot. Long external work should therefore have a durable service/job ID and
be represented as a pending gate.

Interim commentary stays in the worker channel unless the worker deliberately
uses `sab team reply`. Questions and permission controls also remain in the
worker channel; the coordinator's audit card links to it. `/sab-stop` fails the
exact delegated turn, `/sab-kill` fails it and ends the worker session, and
`/sab-update all` skips a worker while its team task is active.

The mailbox exposes only team tasks involving the caller, correlated replies,
stable results, task state, peer availability, and explicitly transferred
files. It cannot read ordinary Slack messages, prompts from before the team,
permission decisions, question forms, or another team's envelopes.

## File relay

Team files do not reuse artifact-upload grants. SAB resolves each source path
against the exact sender session's workspace using the existing realpath,
regular-file, count, and aggregate-size rules. It rejects traversal, symlink
escapes, missing files, directories, and unapproved worker edges.

Before delivery, SAB hashes and copies each file into a mode-restricted private
team attachment directory, uploads an auditable copy to the linked destination
channel, and injects only that private copied path. Request retries compare file
name, size, and SHA-256 and cannot redirect a transfer. Staged bytes and bounded
task metadata expire together.

Cross-node byte transfer is intentionally not active yet. The team/task model
records node identities for the accepted multi-node protocol, but agent-facing
calls and selected members currently require the implicit local execution node.
See [Multi-node coordinator architecture](multi-node-architecture.md).
