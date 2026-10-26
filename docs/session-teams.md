# Session teams

Session teams let one SAB channel coordinate explicit work in other SAB
channels without giving Claude Code, Codex, or Pi Slack credentials or generic
channel access. Each team is a safe star. Stars nest at most two levels into
an owner-rooted tree (see [Agent hierarchies](#agent-hierarchies)). Teams are
local-node only:

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

## Workers created by automation

A coordinator can create a worker for its own team without an owner click. Its
`sab automation create` call names the team, an optional alias and an optional
first task:

```bash
sab automation create --external-key 'github:org/repo#2995' \
  --cwd ~/Code/repo-2995 --provider claude \
  --channel-name cc-repo-2995-holding-lines \
  --team epic-2990 --alias issue-2995 --task-file task.md -- --dsp
```

The call must run inside the coordinator's live SAB session, during an owner
or automatic-continuation turn for that team, and it consumes one dispatch of
that turn's budget. Collaborator turns, local terminal input, workers and
nested provider utilities cannot create team members. SAB proves the caller as
for `sab team`, then:

1. journals the automation and reserves the worker slot and alias, which count
   toward the 20-member bound;
2. creates the private channel, under exactly `--channel-name` if given (an
   existing name fails closed and nothing is launched);
3. in one journal write, turns the reservation into membership with recorded
   provenance and, with `--task-file`, queues the worker's first task;
4. launches the session; after collaborator invitation and input readiness,
   the team dispatcher claims that task once and delivers it as the initial
   prompt with the normal task header.

Only the channel that this call creates can join; an existing channel is never
added programmatically. Retrying the same external key returns the original
automation, and a different request under that key fails. Draining or closed
teams refuse new workers. `sab automation stop KEY --archive` removes the
worker's membership (cancelling only its active tasks) and closes any team the
stopped session coordinated. Task journals and the Slack audit trail remain.

## Agent hierarchies

A channel may coordinate one team and also be a worker in at most one other,
its parent. That gives a tree of at most two team levels, three channel levels:

```text
main (owner's conversation)          team `main`
├── epic coordinator A  ── worker in `main`, coordinator of `epic-a`
│   ├── executor 1      ── worker in `epic-a`
│   └── executor 2
└── epic coordinator B  ── worker in `main`, coordinator of `epic-b`
```

Cycles, a second parent and a third team level fail closed. The owner can nest
an existing team (`/sab-team create` in a worker channel, or `/sab-team add`
with a channel that coordinates a leaf team). A coordinator can create a nested
coordinator programmatically: `sab automation create --team main --create-team
epic-a --task-file epic.md`, during its authorized turn. A programmatic
sub-team inherits its parent's continuation mode and auto-release setting, and
records `createdVia` provenance.

### Standing tasks

A task to a worker that coordinates its own sub-team is **standing**. A
standing task:

- binds the exact native session for `reply`, `checkpoint` and `complete`, but
  never reserves its provider turns, so its own sub-team keeps working;
- is not reported from provider finals: the worker reports deliberately with
  `sab team reply` and declares the whole assignment done with
  `sab team complete`, which makes the task ready for release with no turn
  report;
- gets coordinator follow-ups (`sab team message`) as new turns, submitted only
  when the worker's input surface is idle, with the same digest provenance,
  generation fencing and exactly-once delivery as other messages;
- survives dormancy: a dormant standing worker keeps its binding, and pending
  messages wait for it;
- lives 30 days after its last authenticated activity (replies, checkpoints,
  messages, completion), instead of seven days from creation.

A worker holds at most one active standing task. Amend it with
`sab team message --task ID` rather than sending another task. Exclusive tasks
for that worker wait until the standing task ends. The coordinator may cancel
an active standing task, since it interrupts no provider turn. `sab team send
--standing` gives a plain worker, such as a liaison, a standing task
explicitly.

### Authority flows down

Dispatch authority for a team comes from three places:

- an owner turn in the coordinator's channel;
- a same-team automatic continuation (worker events or scheduled wakes);
- for a sub-team coordinator, a **delegated** turn: the turn that handles its
  standing task's prompt, or a coordinator message for it.

A delegated turn has the usual bounded budget of 20 dispatches and a 12-hour
limit. It is valid only while that standing task is active and bound to this
exact session, and it ends with the turn. Collaborator turns and local terminal
input never gain dispatch or membership authority, at any level.

Commands resolve their team unambiguously:

- `send`, `message`, `release`, `cancel`, `replace`, `continue` and `mode` act
  on the team the channel coordinates;
- `reply`, `checkpoint` and `complete` act on its task in the parent team.

`--team` names the expected team where no task ID decides it, and
`sab team inbox --team NAME` filters by team. `sab team context --json` shows
the coordinated team plus a `parentTeam` object carrying the standing task ID,
and the private prompt context describes both roles.

Questions and results flow up by explicit replies. Answers flow down by
messages:

```text
executor:  sab team reply --task T_exec      → wakes the epic coordinator
epic:      sab team reply --task T_epic      → wakes main
main:      sab team message --task T_epic    → a delegated epic turn
epic:      sab team message --task T_exec    → the executor
```

### Auto-release

`/sab-team auto-release on` (owner, per team) lets SAB perform the release
itself. It happens once a worker's completion is accepted, every declared gate
is clear and the release is ready. SAB then posts the result and wakes an
automatic coordinator with a `released` event. Nothing else changes: follow-ups
still invalidate readiness, and reports, gates, generations and exact binding
are checked as for an explicit release. It is off by default.

### Liaisons

A worker with a standing task may take prompts from its invited collaborators,
since a standing task does not reserve its turns. A `sab team reply` written
in a turn a collaborator started is labelled `origin: collaborator` in JSON
and *collaborator-originated* in Slack, so the coordinator can weigh it as a
suggestion. Collaborators still gain no dispatch or membership authority.

### Closing

A team closes when its coordinator channel is archived. The hourly archive
sweep checks every active coordinator channel. The archived coordinator also
leaves its parent team, cancelling its standing task. `sab automation stop
--archive` on a coordinator automation does the same at once. Closing a parent
team leaves its sub-teams in place as top-level teams.

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
and provider switching revoke or invalidate stale authority. Claude Code's own
background-command, subagent, and Monitor notifications are not local input.
Claude Code submits them as prompts, even mid-turn, but they neither revoke the
current turn's authority nor replace a worker's delegated turn.

## Agent-facing CLI

The provider can use the sole public executable without constructing HTTP or
Slack payloads:

```bash
sab team context --json
sab team peers --json
sab team send --to WORKER_ALIAS --stdin
sab team send --to WORKER_ALIAS --stdin --request-id STABLE_ID
sab team send --to LIAISON_ALIAS --standing --stdin
sab team inbox --after TASK_ID --limit 100 --json
sab team inbox --team PARENT_TEAM --active --limit 20 --page --json
sab team inbox --active --target WORKER_ALIAS --status queued,running --limit 20 --page --json
sab team inbox --since 2026-09-07T08:00:00Z --cursor OPAQUE_CURSOR --limit 20 --page --json
sab team wait --task TASK_ID --timeout 3600 --json
sab team reply --task TASK_ID --stdin
sab team checkpoint --task TASK_ID --pending tests,ci,review,merge --stdin
sab team checkpoint --task TASK_ID --pending none --stdin
sab team complete --task TASK_ID --generation N --stdin
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
A provider may queue a delivered message behind its running turn and submit it
minutes later. The prompt hook then still recognizes the message as the
bridge's own input, by the digest journaled for the exact task, session,
channel and current work generation, even after a daemon restart. A matching
tag alone is never trusted. An older generation is ignored, and altered or
misaddressed text remains local input.
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
After the worker clears all gates, it calls `complete` with a summary and the
exact generation shown in its current SAB task or follow-up prompt, then
finishes its provider turn. A stale or omitted generation fails closed. The
resulting later report is delivered to the
coordinator, but the exact worker session remains reserved until `release`.
SAB orders the declaration and report by the observation timestamp captured at
the provider boundary, so an older final processed late cannot certify release.
`sab team wait` returns as soon as a task becomes `awaiting_release`, because
that state requires action from the current coordinator turn. The coordinator
should inspect `releaseReady`, reports, and pending gates, then either send a
follow-up or release the task. It also returns for terminal states as before.

The coordinator may use `message` for questions or amendments while the task is
reserved. Any such follow-up invalidates the previous completion declaration;
from the moment it is accepted, it fences completion and release until exact
provider delivery. After confirmed delivery the task returns to `running` and
the worker must declare completion again. Reports and messages carry a
monotonic task-local work generation, preventing a delayed final from the
preceding turn—or a completion declaration authored before a newly delivered
follow-up—from satisfying the new instruction. Reports also carry an exact
provider-turn key, so a duplicate lifecycle path is coalesced while a later
turn in the same work generation supersedes its earlier progress report. SAB
stages that generation before provider input and promotes it to a bounded durable native-turn record
when the input is accepted; final hooks resolve the record by turn identity or
event observation time. Multiple follow-ups are delivered in their durable
acceptance order; an unsettled earlier message fences every later one. Releasing
a task persists its terminal result without generating a new worker event or
renewing coordinator dispatch authority. If a terminal task needs
more work, `continue`
creates a new task linked through `parentTaskId`; terminal history is immutable.

Tasks created by older bridge releases do not contain a completion policy and
retain their historical provider-final completion behavior. This deliberate
compatibility boundary prevents a daemon update from changing the meaning of
an already-running task.

The coordinator may send up to 20 tasks in one current owner, delegated or
automatic continuation budget. When that budget is exhausted, automatic mode can renew one
bounded budget only by atomically claiming pending authenticated worker events
for the same team. It cannot renew from a collaborator, another team, stale
local input, or no event. A team holds at most 64 active tasks and one worker at
most eight active tasks, only one of which may hold its session binding. Each
task accepts at most 256 interim replies and 256 idempotent control operations.
That is enough for a long lane with many coordinator follow-ups over its
seven-day lifetime. The last reply slot stays reserved for the checkpoint that
clears the final gate, and terminal cancellation and release remain available
if the control journal is full. The journals keep their full history for
idempotency and recovery. Task views and command responses show the latest 32
replies and coordinator messages, with total counts. Exclusive tasks expire
seven days after creation. Standing tasks expire 30 days after their last
authenticated activity. Overflow, expiry, revocation, and identity disagreement
fail visibly.

## Delivery and recovery

SAB journals a unique task and request identity atomically before any Slack or
provider side effect. It then posts the complete bounded task plus a status card
in both channels. A busy worker remains visibly queued; a dormant worker is not
resurrected by another agent. The owner may wake that session normally, after
which the task waits for a safe idle input surface.

Before injection, SAB reserves the input surface and atomically claims the exact
worker native session and the exact instruction revision already visible on
both Slack audit cards. Concurrent replacements serialize those card updates;
a changed or partly audited revision cannot be claimed. Slack cannot edit a card
to more than about 4,000 characters. A longer revision is therefore posted in
full as a new card, and the original card points to it. A card update that
keeps failing is retried with backoff from 30 seconds up to 30 minutes. That same persisted mutation binds
`session.teamActiveTaskId` and populates `startedAt`, so status cannot report the
worker ready while its task is `dispatching`. It remains `dispatching` until the provider acknowledges
the immutable task marker or that exact process journals a task-bound `sab team
reply`. The latter proves that work was accepted when a prompt hook is missing,
restores Codex status tracking, and survives restart; it never substitutes for
a stable turn report. A daemon restart may deliver a still-queued task, but it never
retries a genuinely uncertain claim. That trades a visible failure for duplicate
work. A tmux rejection before anything is pasted is not uncertain: the task
fails at once with its cause, and no later prompt can acknowledge it. If the claimed envelope was waiting in an in-memory provider queue, SAB
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
two unchanged, exact-process idle observations and a grace period. The proof
compares a digest of the visible pane, never retaining its text; changing tool
output resets it. Working timers and wrapped interrupt hints are not idle. SAB then
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
