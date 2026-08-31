# Multi-node coordinator architecture

Status: **accepted; enrollment transport implemented, remote lifecycle pending**

This decision turns Slack Agent Bridge from one Slack app coupled to one Mac
into one Slack-facing coordinator that can route sessions to several enrolled
execution nodes. It does not create a second command namespace, Slack app, or
Socket Mode consumer.

The foundation keeps the existing process in all-in-one mode. The coordinator
and its local execution node still run in the same daemon, and old state has
exactly the same meaning. One-use enrollment and authenticated heartbeat
transport are implemented behind explicit listener configuration; provider
work is not routed remotely until the remaining authorization, durable replay,
and end-to-end lifecycle tests described here are complete.

## Decision

```text
                              one Socket Mode connection
Slack workspace ──────────────────────────────────────────────────┐
                                                                  ▼
                                                        SAB coordinator
                                                        Slack API + routing
                                                        roles + durable journal
                                                           │           │
                                             authenticated │           │ authenticated
                                               outbound WSS│           │ outbound WSS
                                                           ▼           ▼
                                                  Sergej's node   colleague's node
                                                  tmux/providers  tmux/providers
                                                  local repos     local repos
                                                  local secrets   local secrets
```

The coordinator is the only component that possesses Slack bot and app tokens,
opens Socket Mode, creates or archives channels, invites users, and calls the
Slack Web API. An execution node owns provider processes, tmux, working trees,
local hook endpoints, provider credentials, attachments at rest, and local
terminal viewports.

The current installation is the degenerate one-node deployment: the
coordinator contains an implicit node with immutable ID `local`. A missing
`session.nodeId` and missing channel-node route mean `local`. We will never
bulk-rewrite historical sessions merely to add this metadata.

There remains one canonical Slack manifest and one `/sab-*` namespace. A
session channel's immutable channel ID resolves its node and native session;
ordinary messages and session-scoped commands therefore need no node argument.
Only creation from a control channel may need a machine choice.

## Roles and authorization

Multi-node operation needs three roles instead of treating every non-owner as a
prompt-only collaborator:

- The **bridge administrator** inherits today's owner authority and may enroll,
  revoke, and inspect nodes and assign operators.
- A **node operator** may create and control sessions only on assigned nodes.
  They may answer permissions and resurrect sessions on those nodes, but cannot
  operate another person's machine.
- A **channel collaborator** keeps today's deliberately narrow role: labelled
  prompts and bound artifact returns in explicitly allowed live channels only.

The existing `SLACK_USER_ID` remains the bootstrap bridge administrator. Missing
role state preserves today's single-owner checks. Assigning a node operator is
explicit, durable, revocable, and requires the user to be a member of the same
Slack workspace. Display names are presentation only; authorization uses
immutable Slack user IDs and immutable node IDs.

`/sab-new` remains the public creation command. Its eventual node selection is:

1. an explicit `--node <id-or-unique-name>` consumed by SAB and never passed to
   a provider;
2. the caller's configured default node;
3. their sole available online node; or
4. a Slack picker when the choice is ambiguous.

After creation, `state.channels[channelId]` plus the exact channel-node binding
routes every message and command. `/sab-terminal`, `/sab-update all`, status,
and cleanup may act only on nodes assigned to the caller. The administrator can
request an explicit bridge-wide view, but a generic bulk command must not open
windows or restart sessions on a colleague's machine accidentally.

## Identity and state ownership

Node IDs are lowercase, bounded opaque identifiers. Friendly names such as
`Rade's MacBook Pro` may change and need only be unique while resolving a human
selector. A node's locally generated Ed25519 public key is pinned to its ID.

The coordinator owns:

- Slack installation and bridge-administrator identity;
- node registry, public keys, revocation, operator assignments, and user
  defaults;
- immutable channel-to-node routes and projected authoritative session state;
- Slack interaction state, invitation results, and channel prompt allowlists;
- durable outbound command and inbound event deduplication journals;
- session-team membership, directed permissions, task/mailbox state, and Slack
  audit references; and
- artifact destination grants and Slack upload completion.

Each node owns:

- native session IDs, provider metadata, cwd, PID/tmux claims, and lineage;
- provider hooks, streams, safe-mode gates, and private handoffs;
- provider accounts and credentials;
- locally downloaded Slack attachments and generated files; and
- command-result deduplication needed to survive reconnect and restart.

For compatibility, `state.channels[channelId]` continues to point to the
authoritative native session ID. Remote projections additionally carry
`session.nodeId`, and `state.channelNodes[channelId]` must equal it. Any missing,
invalid, unknown, or disagreeing side of the channel/session/node triangle fails
closed. Local records omit both fields.

A native session belongs to one node for its lifetime. Provider switching stays
on that node and the target leg inherits the node ID. Moving a conversation to
another machine is not provider switching: it would also require an explicit
repository/worktree transfer contract and is outside this design.

## Enrollment and transport

Nodes initiate the connection so an execution machine needs no public inbound
listener. Production transport is `wss://`; plaintext is accepted only on
loopback in tests. TLS authenticates the coordinator endpoint. Node identity is
then proven at the application layer with a signed, coordinator-issued nonce.

Enrollment is a separate one-time ceremony:

1. The administrator creates a short-lived, one-use invitation bound to the
   intended Slack operator and friendly node name.
2. `sab node enroll` on the execution machine generates an Ed25519 keypair with
   mode `0600`, submits only its public key over the authenticated coordinator
   connection, and consumes the invitation.
3. The coordinator atomically persists the node ID, public key fingerprint,
   operator assignment, and enrollment completion before accepting work.
4. Later connections sign a fresh nonce. Revocation invalidates the node before
   closing its active connection.

Enrollment tokens are stored hashed, expire quickly, cannot be replayed, and
must never appear in logs or Slack channel history. A node never receives Slack
tokens. The coordinator never receives provider credentials, SSH keys, global
agent memory, or arbitrary files from a node.

One authenticated connection epoch may be authoritative for a node ID. A newer
valid connection advances the persisted epoch and fences the old connection;
late results or lifecycle events from an older epoch cannot mutate state.

## Wire protocol

The protocol is versioned independently of the package. Every JSON envelope is
bounded and contains:

```json
{
  "protocol": 1,
  "kind": "command | result | event | heartbeat",
  "id": "globally unique message ID",
  "nodeId": "node_rade",
  "epoch": 17,
  "sentAt": "ISO-8601 timestamp",
  "payload": {}
}
```

Coordinator commands use a durable `commandId`, operation allowlist, deadline,
and exact target identity. Initial operations are session create/input/
interrupt/stop/update/settings, terminal list/open/close, and health. A node
journals acceptance before performing a side effect and retains the bounded
result; replay returns the recorded result instead of running the operation
again.

Node events use a durable `eventId` and exact node/native-session/tmux/process
identity where applicable. Lifecycle, commentary, final output, working status,
questions, permission requests, usage, channel-binding readiness, and artifact
delivery are explicit event types. The coordinator persists event acceptance
before acknowledging it and ignores replayed IDs.

Unknown message kinds, operations, event types, fields that exceed their bounds,
expired deadlines, mismatched node IDs/epochs, and unbound session or channel
claims are rejected. Protocol negotiation is fail-closed: a node whose required
version or capability set is unsupported remains visible as incompatible but
cannot receive commands.

This produces effectively-once side effects over an at-least-once transport:
both sides may resend after losing an acknowledgement, but durable IDs prevent
duplicate launches, prompt injection, permission decisions, and uploads.

## Lifecycle flows

### Session creation

The coordinator validates the actor, selected node, provider, and provider flag
syntax, then asks the node to canonicalize and validate the cwd under its own
home directory. It journals a creation ID before sending the launch command.
The node journals its tmux identity before launch and reports native
`SessionStart`. Only then does the coordinator create/bind the private channel,
invite required users, complete authorization, and release an initial prompt.
Retries return the same creation record.

The node is the authority on filesystem existence, path containment, provider
installation, flag availability, PID ancestry, and tmux. The coordinator is the
authority on Slack identity, authorization, channel binding, and invitations.
Neither side may claim success by trusting an assertion belonging to the other.

### Messages and attachments

Slack events are acknowledged promptly by the coordinator. Accepted text gets
a durable delivery ID and is routed only to the channel's exact node/session.
When a node is temporarily disconnected, bounded owner messages may be queued
with a visible Slack notice. Collaborator messages and permission answers fail
closed while offline. Overflow is reported rather than silently dropped.

The coordinator downloads Slack attachments with its bot token and transfers
bounded bytes over the authenticated node connection. The node writes them to
its private attachment directory and injects only its own local paths. The
read-only Pi classifier still receives visible prompt text only.

### Questions and permissions

The node reports a bounded structured question or permission request with its
exact process/tmux/session identity. The coordinator revalidates the channel
route and actor before rendering Slack controls. A decision carries the
original request ID back to the same node and epoch. Disconnect or timeout sends
no synthetic approval; provider-local fail-safe behavior remains authoritative.

### Generated files

The coordinator mints the Slack-destination capability after accepting a prompt
and sends its opaque ID to the node. `sab upload` calls the node's loopback API.
The node verifies the live process/tmux/session and workspace realpath, reads
bounded regular files, and streams them with the one-use capability to the
coordinator. The coordinator revalidates sender/message/channel/node/session,
uploads to the fixed Slack destination, and atomically consumes the grant.
Neither an agent nor a node chooses a channel ID.

### Session-team collaboration

The shipped local session-team model is already channel/session/provider/node
identified, but it deliberately rejects non-local callers and members until
remote lifecycle and byte transport are complete. The coordinator remains the
authority on team membership, directed edges, owner-turn capabilities, task
identity, Slack audit records, and bounded mailbox state. A node remains the
authority on its provider's safe input surface, exact process/tmux claim,
workspace paths, private copied files, and stable final event.

Remote relay will use dedicated journaled protocol commands/events for task
offer, acceptance, progress/reply, completion/failure/cancellation, mailbox
acknowledgement, and bounded file streaming. They inherit command/event IDs,
deadlines, epoch fencing, and replay rules; generic session input and arbitrary
Slack posting are not substitutes. The coordinator persists an outbound team
delivery before sending it, while the destination node persists acceptance
before injecting it. A repeated command returns the recorded result. An
uncertain accepted/injected command is never executed again merely because the
coordinator restarted.

The source agent continues to use only aliases through `sab team`. The source
node derives and authenticates its session identity; the coordinator resolves
the immutable destination channel and node. For files, the source node validates
and hashes bytes inside its workspace, the authenticated transport carries a
bounded stream, and the destination node writes a mode-restricted private copy
before acknowledging readiness. Slack uploads remain coordinator-owned. Until
those operations and disconnect/replay tests ship, cross-node teams remain
unavailable rather than falling back to the coordinator's local filesystem.

### Terminals and updates

Ghostty exists only on the node that owns the tmux session. A channel-scoped
terminal action routes there. Bulk viewport and update operations are grouped by
node and restricted to the caller's assignments; every node independently
revalidates active-turn and exact-process fences immediately before mutation.

## Failure and recovery

- A coordinator outage leaves tmux and provider processes running. Nodes retain
  bounded outbound events and reconnect; Slack control is unavailable until the
  sole coordinator returns.
- A node outage marks its channels offline with actionable status. It does not
  affect sessions on other nodes.
- A node-daemon restart re-adopts only exact local tmux/process claims and sends
  a projection snapshot. The coordinator reconciles by node ID and epoch.
- A coordinator restart reloads node routes and command/event journals before
  accepting Socket Mode traffic. Nodes reconnect and replay unacknowledged
  messages.
- A revoked or key-mismatched node cannot reconnect. Its channel history and
  dormant records remain visible for deliberate recovery or archival.
- A protocol mismatch never falls back to local execution.

## Delivery sequence

1. **Local boundary:** add implicit local node identity, isolate sole Socket Mode
   ingress/Slack client ownership, and route spawn/terminal operations through
   an execution-node interface, with no state migration or behavior change.
2. **Coordinator extraction:** isolate Slack ingress/Web API/state projection
   from local provider lifecycle while retaining an in-process transport.
3. **Protocol and enrollment:** add bounded envelopes, durable deduplication,
   Ed25519 enrollment, outbound WSS, heartbeat, fencing, and role state.
4. **Core remote lifecycle:** node-aware creation, channel binding, messages,
   restart recovery, status, and exact stop.
5. **Parity:** attachments, questions, permissions, artifacts, terminals,
   updates, automation, usage, managed Pi, and same-node provider switching.
6. **Pilot and release:** exercise one colleague node under an RC, simulate
   disconnect/replay/restart/key revocation, run all provider canaries, and only
   then prepare the major release.

No delivery step may require a second Slack app, manifest, command namespace, or
Socket Mode connection. Until step 4 passes its security and restart tests,
multi-node mode remains unavailable to users.

Steps 1 and the enrollment/authentication portion of step 3 are implemented.
The optional listener is off by default; non-loopback use requires TLS and an
explicit public WSS URL. `sab node invite/list/revoke/enroll/status` is the only
local management surface. Step 4 has not shipped, so enrollment is currently a
transport validation facility rather than permission to run provider sessions.
Local-node session teams and their durable task identities are implemented, but
their protocol operations and cross-node file streams remain part of steps 4
and 5.
