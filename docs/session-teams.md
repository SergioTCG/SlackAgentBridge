# Session teams

Session teams let one SAB channel coordinate explicit work in other SAB
channels without giving Claude Code, Codex, or Pi Slack credentials or generic
channel access. The first release is local-node only and uses a safe star:

```text
coordinator ── task/text/optional files ──▶ worker
coordinator ◀── reply/status/final/optional files ── worker
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
```

`/sab-team add` opens Slack's private-channel picker. SAB accepts only a channel
with an exact authoritative local session mapping. It stores the immutable
channel ID, while the current channel name becomes a display alias. Renaming a
Slack channel or switching its active provider does not break membership.

Text, task state, replies, and stable final results are enabled by the star
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
sab team wait --task TASK_ID --timeout 3600 --json
sab team reply --task TASK_ID --stdin
sab team send-file --to WORKER_ALIAS --message 'Inspect these.' -- report.pdf
sab team send-file --task TASK_ID --message 'Interim artifact.' -- result.json
```

`--request-id` makes a caller retry return the original task or reply instead of
creating another side effect. Without it, the CLI generates a UUID. Text input,
mailboxes, active queues, task lifetime, replies, file count, and aggregate
bytes are bounded. Agent-visible JSON contains aliases and authorized
collaboration envelopes, not raw Slack destination IDs.

The coordinator may send up to 20 tasks in one current owner turn. A team holds
at most 64 active tasks and one worker at most eight queued/running tasks. Each
task accepts at most 32 interim replies and expires after seven days. Overflow,
expiry, revocation, and identity disagreement fail visibly.

## Delivery and recovery

SAB journals a unique task and request identity atomically before any Slack or
provider side effect. It then posts the complete bounded task plus a status card
in both channels. A busy worker remains visibly queued; a dormant worker is not
resurrected by another agent. The owner may wake that session normally, after
which the task waits for a safe idle input surface.

Before injection, SAB reserves the input surface and atomically claims the exact
worker native session. It remains `dispatching` until the provider acknowledges
the immutable task marker. A daemon restart may deliver a still-queued task, but
it never retries an uncertain claim. That trades a visible failure for duplicate
work. If the claimed envelope was waiting in an in-memory provider queue, SAB
removes that exact marker before reporting failure so a later reconnect cannot
execute it.

In automatic mode, multiple executor events accumulated while the coordinator
is busy are represented by one durable wake; the coordinator always rereads the
complete authenticated inbox, so old event payloads are neither replayed nor
trusted. A resumed Codex TUI that omits lifecycle hooks is reconciled only after
two unchanged, exact-process idle observations and a grace period. SAB then
clears the stale coordinator fence and proceeds without scraping a final answer
or assigning a worker result. A genuine busy wait is reported once after one
minute and continues to retry safely.

Claude transcript completion, the Codex Stop hook, or the Pi extension supplies
the stable final result. SAB persists completion plus an idempotent Slack
delivery claim before reporting it in the coordinator channel. Restart
reconciliation either proves the original turn is still active or visibly
releases it without attributing a later final. Deleted or otherwise uneditable
status cards are reported alongside the result but never prevent result
delivery. Terminal tasks from the pre-claim journal format are recognized as
already delivered during upgrade rather than posted a second time. Pending
completion, reply, or file delivery prevents journal pruning; SAB persists a
pruned journal before deleting its private file copies.

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
