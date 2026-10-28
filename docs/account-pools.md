# Account pools and migration preparation

Status: **off by default; experimental opt-in runtime implemented**. Staging
alone never activates monitoring or changes live bindings. The default Claude
account switch remains compatible; explicit runtime modes add account-scoped
sampling, pool-aware handover, and guarded automatic selection. A controlled
native-provider canary remains required before production rotation. This
document distinguishes implemented code from live-provider proof.

| Capability | Candidate state |
|---|---|
| Group/account CRUD, membership, preferences, routing, drain/retire | Implemented; revision-guarded, no credential deletion |
| Claude/Codex isolated full login and inactive native refresh | Implemented; real new-account login/refresh canaries required |
| Usage polling, resets, sticky selection, conservative switch-back | Implemented; unknown scope/auth/usage fails closed |
| Idle native account handover | Implemented; exact-direction manual resume proof gates automatic selection |
| Instant active/delegated quota-blocked continuation | Not implemented; no safe checkpoint/background-job proof in current bridge contract |
| Live migration/activation | Not performed by development; explicit maintenance and canary required |

This is **not yet an unrestricted unattended-rotation release**. Idle sessions
are canary candidates, not automatic permission to restart all sessions.

## First-stage commands

```bash
sab account preview
sab account preview --provider claude --json
sab account capabilities --json
sab account capabilities --probe --json
```

The public executable remains `sab`. These are local owner-machine inspection
tools, not Slack actions or daemon endpoints. The canonical Slack manifest is
unchanged. There is deliberately no `--apply` flag.

### Migration preview

The preview reads only:

- `accounts` and `state.json` under `CCS_CONFIG_DIR` (default `~/.config/ccs`);
- `~/.claude.json`, or `.claude.json` under an explicit `CLAUDE_CONFIG_DIR`;
- `auth.json` under `CODEX_HOME` (default `~/.codex`).

It does not read provider transcripts, query macOS Keychain, invoke a provider,
refresh credentials, make network requests, create configuration directories,
chmod files, or write state. Sources are limited to regular files and bounded
bytes: 1 MiB for each credential source, 4 MiB for Claude metadata, and 32 MiB
for state. Registry parsing permits at most 256 distinct aliases and 1,024
nonempty rows; output maps at most 4,096 authoritative bindings. Excess or
malformed input produces a blocking diagnostic instead of silent approval.

The JSON contract has `schemaVersion: 1`, `readOnly: true`, `canApply: false`,
and `automaticSwitching: false`. It contains:

- `accounts`: provisional provider-scoped candidates, aliases, credential
  evidence, and unverified email hints;
- `groups`: one-member candidate groups for every legacy alias and each native
  default, all with automatic switching disabled;
- `bindings`: proposed group references for exact authoritative local
  channel/session mappings; stale/standby records are omitted, and remote,
  mismatched, missing, or conflicting account bindings require review;
- `issues`: bounded fixed-code diagnostics, never raw input/error fragments;
- `summary`: named aliases, distinct stored credentials, and binding counts.

Candidate IDs are deterministic alias-based references for comparing previews,
not durable identities. A native-default candidate does not imply that a valid
login exists: file evidence may be missing, stale, overridden by environment,
or superseded by Keychain/provider settings. This is an offline snapshot, not
proof of process liveness or effective authentication.

Identical stored token bytes are grouped without printing any token bytes,
fragments, or credential-derived hashes. The original alias names still receive
separate singleton groups pointing at the same candidate. Different token
bytes may belong to the same subscription; cached matching email addresses
also do not prove a common account or independent quota. Never infer extra
capacity from the number of aliases, tokens, or groups.

Claude login metadata cannot identify an unrelated named setup token. Codex
ID-token payloads can supply an email hint but are not signature-validated or
authenticated by this command. Both remain `cached-unverified`; absent,
overridden, malformed, or API-key-only identities remain unresolved. Email
housekeeping requires provider identity proof or owner-assisted enrollment.

Reports contain private email/session/channel metadata even though they omit
credentials. Do not commit real previews, auth files, or state snapshots.

### Capability evidence

Without `--probe`, the command reports documented interfaces and explicitly
unproven capabilities. `--probe` additionally executes only:

- `claude --version` and `claude auth status --help`;
- `codex --version` and `codex app-server generate-json-schema --out …`.

Each provider runs with disposable configuration roots, a minimal environment,
bounded execution time/output, and no inherited credentials, bridge/tmux
identity, or session authority. There is no account RPC or App Server listener,
login, token refresh, inference, conversation start/resume, or live session
interruption. Generated probe files are removed afterward. Native stdout/stderr
and arbitrary error text are never forwarded into the report.

Structured Codex evidence checks the actual request methods and response fields
for account email and quota utilization/reset time, plus optional multiple
buckets, explicit account binding, and backend ordinary-usage permission.
Schema support is **not** an entitlement check or a successful live query.
Claude help support likewise does not show that a setup token can reveal its
email or inspect an inactive subscription.

The documented sources are:

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex App Server account and rate-limit APIs](https://learn.chatgpt.com/docs/app-server)
- [Claude authentication and setup-token scope](https://code.claude.com/docs/en/authentication)
- [Claude status-line rate limits](https://code.claude.com/docs/en/statusline)

Claude status-line rate-limit fields are response-derived and can be absent.
Rerunning a status script or passing an expected reset time is not proof of a
fresh backend observation. Setup tokens are documented as model-request-only;
inactive-account polling and reliable identity discovery require a separate
credential/capability proof. Never spend inference tokens just to inspect quota.

## Intended architecture after proof

1. **Account identity:** an opaque stable ID with provider, verified registered
   email, workspace/organization identity, and credential references. Email is
   a display/selection value, never a shell/path identifier. Credentials stay
   node-local and separate from ordinary state, logs, and Slack.
2. **Groups:** owner-defined permitted accounts and a selection policy. A group
   can have provider-specific members; rotation never changes the session's
   provider, requested model, effort, context size, or permission posture.
   Adding an account is explicit authorization to send that group's session
   context through that account/workspace, not just additional quota.
3. **Bindings:** durable group ID plus effective and optional preferred/pinned
   account. Old alias and implicit-default references remain readable until an
   explicit, backed-up, idempotent migration is applied. Existing sessions do
   not restart merely because the registry is upgraded.
4. **Usage:** one observation per independently metered principal/workspace/
   model/bucket, with timestamp, freshness, backend permissions and reset time.
   Credential aliases and shared workspace quotas do not create capacity.
   Account-level concurrency reservations apply across every group/session.
   `ccusage` remains the transcript-derived token/cost adapter; subscription
   quota is a separate explicit provider-telemetry contract.
5. **Selection:** sticky capacity-aware assignment with headroom, applicable
   windows, observed burn rate, reset timing, concurrent reservations,
   cooldowns, and minimum-benefit thresholds. Unknown is not zero usage. Passed
   reset time triggers revalidation, not assumed recovery. Fresh explicit
   backend denials cannot be overridden by attractive percentages.
6. **Handover:** a durable exact-session account transaction around native
   restart/resume, with input fencing, startup/account verification, bounded
   failure recovery, and preserved task/turn/channel authority. It must not
   reuse generic kill as a task-release mechanism or replay uncertain work.
7. **Presentation:** extend `/sab-account`, `/sab-usage`, and App Home, preserving
   textual compatibility. Show group, verified effective email, all applicable
   windows, data age, reset time, pending switch, and reason. Routine polling
   does not produce Slack status spam.

No account may be selected outside its authorized group, node, workspace, or
model entitlement. Missing credentials fail closed, not into the machine login.
Auth expiry, transient throttling, plan exhaustion, model capacity, billing,
and provider outage are different states, not interchangeable reasons to rotate.
Do not silently downgrade models or consume paid overages/reset credits.

## Inactive registry commands

Staging records owner-confirmed identities and policy separately from activation.
It does not require every credential to support live usage monitoring, and
cannot enable rotation. Registry inspection accounts remain
`monitoring: "not-enrolled"` and `automaticEligible: false` even if individual
credentials were verified separately. Owner-confirmed email is deliberately not
labelled provider-verified.

```bash
sab account registry plan --input enrollment.json --json
sab account registry stage --input enrollment.json --expected-revision 0 --json
sab account registry status --json
sab account registry check --channel C0123456789 --provider claude --json
```

`plan` reads the supplied enrollment, legacy aliases, an optional staged
registry, and `state.json`. It never writes anything. Its output includes exact
active and validated standby native legs, permitted bindings to preserve,
required account corrections, and unresolved/nonlocal bindings to review.
It never includes prompt text, grants, model/effort fields, or task content.
This is a state snapshot, not proof of liveness. Native login references do not
prove which credentials a live process actually uses.

`stage` writes **only inactive metadata**. It does not rename the old aliases,
copy credentials, correct session bindings, restart providers, or alter grants,
tasks, native history, or model/effort. `status` and `check` are read-only and
never create a missing registry. `check` resolves provider-specific IDs, owner
keys, email selectors, and legacy aliases through the same pure policy checker;
its `runtimeAllowed: false` result means a local policy check is not activation.
An ambiguous email shared across workspaces requires an exact key, ID, or alias.
Registry operations are local-node only. Runtime owner endpoints are separate
and disabled by default; there is no new Slack command or scope.

### Enrollment format

Supply JSON through stdin (`--input -`) or an owner-owned private regular file
(`0600`, no symlinks). Never put credentials in this file. Example with fictional
identities and channel IDs:

```json
{
  "schemaVersion": 1,
  "requestId": "owner-enrollment-1",
  "accounts": [
    {
      "key": "owner-claude",
      "provider": "claude",
      "email": "owner@example.test",
      "identityConfirmed": true,
      "credentials": [{ "kind": "native-default" }]
    },
    {
      "key": "owner-codex",
      "provider": "codex",
      "email": "owner@example.test",
      "identityConfirmed": true,
      "credentials": [{ "kind": "native-default" }]
    },
    {
      "key": "client-claude",
      "provider": "claude",
      "email": "client@example.test",
      "identityConfirmed": true,
      "credentials": [{ "kind": "legacy-claude", "alias": "client" }],
      "allowedChannels": ["C0123456789"]
    }
  ],
  "groups": [
    {
      "key": "owner",
      "name": "Owner",
      "members": ["owner-claude", "owner-codex"],
      "preferred": { "claude": "owner-claude", "codex": "owner-codex" }
    },
    { "key": "client", "name": "Client", "members": ["client-claude"] }
  ],
  "routing": {
    "defaultGroup": "owner",
    "channels": { "C0123456789": "client" }
  }
}
```

The full legacy alias inventory must be covered. If two aliases have identical
stored credentials, both references must belong to the same account. The
example assumes `client` is the only named legacy alias; extend it for your
inventory. Native Claude and Codex default logins are different provider
identities, even when their emails match. `workspaceId` is optional; use it to
distinguish separately authorized workspaces, not to claim independent quota.
Reference types are native default (one per provider), existing named Claude
credentials, and `{"kind":"codex-profile","profile":"PROFILE"}` or
`{"kind":"claude-profile","profile":"PROFILE"}` for additional
Codex logins. Paths are never accepted in an enrollment.

Unknown fields are rejected, including token bytes, alleged monitoring proofs,
node overrides, and auto-enable flags. Schema version 1 permits at most 128
current accounts, 64 groups, 32 references per account, and 4,096 channel routes.
Email is a display/selection value, never a path. Keys use bounded ASCII
letters/digits plus `_ . : -` (starting with a letter/digit). Stable account and
group IDs are allocated only when staging, and survive display/group renames.
An account key cannot be reused for a different provider/email/workspace.

Channel group routing and account ceilings are separate: adding the client
account to another group must **not** let its aliases escape `allowedChannels`.
An omitted/null ceiling means no additional account-level channel restriction;
an empty array makes the account ineligible everywhere. Selection still
requires provider compatibility and membership in the channel's selected group.
Permitted existing accounts remain sticky: an enrollment's preferred account
does not by itself rebalance already-correct live bindings.

### Atomicity, retries, and private recovery history

Only explicit staging creates `~/.config/ccs/account-pools` (`0700`). Metadata
lives in immutable `revision-000001.json`, `revision-000002.json`, and so on
(`0600`). The caller must supply the last observed revision (zero initially).
The writer fsyncs private prepared bytes before exclusively publishing the next
revision. A crash before publication leaves the old registry; a crash after it
leaves the new one. Concurrent writers cannot overwrite each other. Abandoned
`.pending-*` files are ignored and never treated as revisions; there is no lock
requiring manual recovery. Staging does not delete another writer's files.

The same request ID and normalized enrollment return `already-staged`, even
after later requests, without allocating new IDs or changing current policy.
The response includes the request's `appliedRevision` and the latest registry.
A reused ID with different input returns `request_id_conflict`; a new request
with a stale expected revision returns `revision_conflict`. A changed legacy
credential source returns `legacy_credentials_changed`. After reviewing the
complete revised alias ownership, a **new** request ID plus explicit
`--accept-source-change` permits `plan`/`stage` to enroll that new source at the
expected revision. Old request IDs cannot approve credential changes; new
registry revisions invalidate runtime quota/canary eligibility. Private
receipts and source digests never enter
public JSON output. No daemon enforcement is implied by a successful stage.

Keep the private revisions for recovery and future reviewed activation. Do not
delete the newest revision to bypass validation or restore old channel policy;
there is no activation or live rollback command in this stage. Invalid latest
state, missing revision numbers, insecure modes, and symlinks fail closed, never
fall back to an earlier policy or silently chmod a file. Version 1 bounds the
history to 4,096 revisions (including permanent request receipts), 256 historical
account keys, and 128 historical group keys; exhaustion requires a designed
migration, not deleting deduplication receipts. Enrollment, staged revisions,
and reports contain private emails and channel identities: do not commit them.

## Opt-in runtime and operating boundaries

`CCS_ACCOUNT_POOLS` configures the daemon, not an individual provider process:

| Mode | Sampling | Account handover |
|---|---|---|
| `off` (default) | None; no registry I/O | Existing legacy Claude path |
| `shadow` | Account-scoped, serialized, durable | Recommendations only |
| `manual` | Same monitor | Explicit owner request, idle exact session only |
| `auto` | Same monitor | Manual behavior plus proven safe-boundary rotation |

Changing this configuration requires a controlled daemon rollout. No command
here edits the live daemon configuration automatically. Stage the registry
first, review all migration corrections, and never mistake a shadow
recommendation for a completed account change. Native resumption still uses
the latest model/effort/flags; a pool never changes provider or downgrades them.

Enabled `/sab-account` shows the channel group, current email, each provider-
compatible member's quota/freshness/status, and selection reason. An explicit
email, stable ID/key, or alias chooses a permitted account; `default` resolves
the group's provider preference, not an unrestricted machine-login bypass.
`/sab-usage limits` uses the same account-scoped view. Pi remains unaffected.
Legacy aliases stay readable as credential references rather than being
destructively renamed. Private local JSON commands are:

```bash
sab account pool status --channel C0123456789 --json
sab account pool refresh --account ACCOUNT_ID --json
sab account pool switch --channel C0123456789 --session NATIVE_ID \
  --account owner@example.test --request-id owner-switch-1 --json
```

An explicit selection for a provably dormant non-team session is saved as
`selected` without starting a provider; it applies on the next owner resume and
does not count as a successful canary. Historical PID/tmux claims must be proved
dead and rechecked against racing native adoption. Resume fails closed when its
saved account violates the exact channel policy. Named-account new-channel
launches cannot bypass that policy: create the channel, review its immutable
route, then choose a permitted account there.

`status` reports the last switch request/phase, current binding, observation
timestamps, and candidate reasons. After a switch timeout, query status before
retrying the same request ID; never invent another ID to replay an uncertain
restart. A new request with the same ID and different intent is rejected.
State receipts are bounded to 4,096; exhaustion requires a designed migration,
not silently pruning deduplication identities. Interrupted handovers block
new input, automatic handover, and ordinary resume for that channel and require
operator inspection. The next Slack prompt never silently retries them.
A handover rejected before teardown leaves the provider running. Its notice
names the cause. While the switch is still needed, SAB retries an automatic
one after 15 minutes, doubling per consecutive rejection up to four hours. An
explicit switch is never delayed.
`sab account pool reconcile --channel ID --session NATIVE_ID --request-id
ORIGINAL_ID` (or `/sab-account reconcile ORIGINAL_ID`) verifies an already-live
exact target without restarting or replaying input, and creates no automatic
proof. If a daemon restart lost the replacement's only SessionStart, it first
adopts the shallowest Claude process of the journaled single-pane replacement
tmux, and only when that process resumes the exact native session. A
dead/incorrect replacement needs an explicit new manual handover after
credential correction, not automatic resurrection. Failed
disk persistence fences further pool mutations without stopping providers.

The sampler never attaches to a live App Server, creates a conversation, spends
inference tokens, consumes reset credits, or enables overage.
Claude uses fixed profile/usage endpoints and verifies email/workspace identity.
Scope-limited setup tokens remain `scope-unavailable`; no unrelated native quota
is substituted. Native default Claude inspection supports the standard macOS
Keychain/private-file store and Linux private-file store; unrelated custom
`CLAUDE_CONFIG_DIR` defaults remain unavailable rather than guessed. Explicit
Claude profiles use their exact native config directory and directory-keyed
Keychain entry/private file. Ordinary Codex probes use account RPC in a temporary
ephemeral-storage process, with access-token-only input and no refresh token.
An isolated inactive profile may instead refresh through its native provider
under an exclusive lease. Default machine credentials and active profiles are
never refreshed by SAB. Unknown or expired credentials do not become eligible
just because a usage window reset.

Polling is serialized across accounts, deduplicated per account, and ordinarily
every five minutes with jitter. Failed reads back off to one hour. Reset time
can shorten a successful sample's next poll, never below one minute. All
available windows/buckets constrain eligibility conservatively; any backend
denial defeats attractive percentages. Unknown/stale data is never zero usage.
The current policy reserves ten percent headroom and conservatively accounts
for shared-principal live-session reservations (one percentage point per idle
session, five per busy session). These are safety margins,
not measured future token consumption or a guarantee that limits cannot be hit.

Eligible current assignments stay sticky. Confirmed exhausted headroom may
select another permitted account. Scope/auth/network/model-capacity failures
alone are not quota-exhaustion evidence and cannot trigger rotation. Preferred
switch-back requires a fresh post-reset sample, at least 20 percentage points
of benefit, and a 15-minute cooldown. Every automatic direction must first have
passed a successful explicitly requested native resume at the same registry
revision. No global login files are swapped behind live processes.

Fresh backend identity is checked before teardown and again against the exact
replacement's verified provider-root/profile binding before committing a proof.
Scope-limited legacy tokens may still switch manually, but are explicitly
unverified and never create automatic handover proof. Policies are enforced
before new-channel prompts, automation initial prompts, queued input, and
provider-switch handoff transfer. Shadow mode does not enforce these routes or
clear the legacy launch environment.

Active turns, delegated team work, questions, permissions, automation-owned
sessions, private maintenance, provider switches, dormant sessions, and another
restart are not eligible, except as described under usage-limit handover below. Neither is a Claude session that has not received its
first prompt: Claude writes no conversation until then, so `--resume` would
exit at once. An input-fenced restart is journaled before teardown
and rechecks authority/idleness after its Slack notice. The exact provider-root
PID/tmux and two unchanged native idle-surface snapshots must be verified before
teardown; absent hooks/pollers alone never prove idle. Startup must re-adopt
the same native conversation/settings and exact account binding before commit.
Boot never retries a journaled uncertain restart. This stage does **not** offer
instant mid-tool handover or speculative replay of a quota-blocked prompt.
Existing task reservations/background work are protected by refusing those
handovers, with the one exception below.

### Usage-limit handover of held work

A session whose current account is exhausted cannot run its next turn there.
Exhausted means `headroom-exhausted`, or `backend-denied` with a window at 90%
or more. For a Claude session on such an account, the monitor overrides only
the protections that exist for the held work itself:

- its team task, either a standing coordinator task or a running or reported
  delegated task;
- the ownership of a fully set-up automation;
- the turn the limit ended. Claude can leave a poller that never saw a spinner,
  but the pane shows the limit notice as its latest output.

The account must be exhausted by its own measured usage. The reservation
estimate for other sessions never moves held work. It hands the session over
to a ready account in its group. Questions,
permissions, provider switches, other maintenance, private turns, a dispatch,
and a coordinator message or report that is still being delivered keep
blocking it. Those are retried on the next tick and logged, not announced.
Every other reason to switch keeps the ordinary boundary: a preferred-account
return, a drain or a manual switch waits until the task is idle or reported.

- **Task.** The task is journaled as account maintenance (`taskMaintenance.kind:
  "usage-limit"`) and stays byte-for-byte unchanged: same ID and status, and no
  failure, completion or release. Team controls are fenced until the handover
  settles, as for reported-task maintenance. Claude sends SessionEnd when SAB
  closes its tmux. For ten minutes, hooks from the process the handover stopped
  are ignored, so they cannot fail the task or revoke the turn it resumes. While
  the handover is pending, no other path fails the task; local input still
  revokes the turn.
- **Daemon restart.** In auto mode, a daemon restart keeps a turn a usage limit
  paused, with its task, turn authority and input reservation, instead of
  failing it as an unproven idle turn.
- **Chooser.** Claude's limit chooser ends with "Switch to usage credits", which
  is paid usage on the exhausted account. SAB sends it one Escape, which cancels
  it and cannot select any option, and refuses the handover if it stays open.
- **Resume.** The same conversation resumes with the same model and effort. A
  1M-context launch keeps `[1m]` even when the status line reports the base id.
- **Re-delivery.** If the limit interrupted a turn, SAB re-delivers it exactly
  once. That is the input queued meanwhile, or otherwise the line "Your account
  was switched after a usage limit; resume your task where you left off." Team
  messages queued for the session follow it, once each.
- **Background shells.** Restarting ends the pane, so SAB stops the Claude
  Bash-tool shells that are still running. It checks each one's exact process,
  then stops its process group, and names their commands to the agent so it can
  restart the ones it still needs. Waiting for them could stall forever: they
  are often watchers that never end. Letting them survive would leave orphans
  that duplicate work once the agent restarts them. Shell commands reach only
  the agent's own prompt, never Slack or the log.
- **Announcements.** The session's channel gets a notice. The task gains an
  `accountHandovers` entry in the coordinator's team inbox, which records that
  the account moved and the task continues.
- **Automation.** An owning automation is re-pointed to the replacement
  terminal, so `sab automation stop` and `release` stay exact.
- **Capacity.** The reservation estimate only balances accounts that can all
  still work. When no account passes it, measured capacity is enough to leave
  an exhausted account.
- **Uncertain outcome.** A handover that ends uncertain halts further usage-limit
  handovers until that channel is reconciled, so a systematic failure strands
  one session, not all. The halt is read from the journal, so it survives a
  daemon restart. A handover rejected before teardown retries after 2 minutes,
  doubling up to 15, and is announced once.

- **Resume in place.** When no other account had capacity, a paused turn stays
  paused until its own account has measured capacity again. The monitor then
  resumes it there, without a restart. It closes Claude's chooser with one
  Escape and sends "Your usage limit has reset; resume your task where you left
  off."
  - **Held work only:** a team task or turn, or an automation. An owner's or
    collaborator's own session waits for their next message.
  - **Pane text alone never triggers it.** The monitor records a pause only
    while it measures that session's own account exhausted and the pane shows
    the limit as its latest output. A boot that keeps a paused turn records one
    too. Any new prompt or a handover clears it.
  - **The resume needs a newer reading** of that account showing capacity.
  - **One attempt per 30 minutes.** It is recorded before any key is sent.
  - **Re-checked before the line goes in:** queued input, maintenance, a
    question, a permission and a switch. For Codex, any live turn as well.

In auto mode, a new session starts on the account the monitor would move it to
anyway, so no launch begins on an exhausted native login. A native login with
capacity is kept. An automation uses its prepared channel's route. `/sab-new`
and `/spawn` sessions, whose channel does not exist yet, choose from the
default group among accounts without a channel allowlist. Codex launches stay
on the native login: a Codex hook reports no account, so SAB could not bind a
profile launch to the login it runs on.

Codex sessions get the same handling:
- **Notice.** Codex's limit sentences ("You've hit your usage limit…", "Usage
  limit reached…", "You're out of credits…") count only in the visible tail of
  an idle input surface.
- **Pause.** A limit-ended Codex turn is paused instead of being reported as
  finished, at boot and in the live poller. A Codex coordinator keeps its turn
  instead of being released into a continuation.
  - The live poller pauses only when the pool can act: in auto mode, with the
    session's own account measured exhausted.
  - It never pauses a task that is still being dispatched.
  - It posts a notice in the channel.
- **Halt.** A Codex handover that ends uncertain halts only Codex handovers.
- **Handover and resume.** Held work moves when the group has another Codex
  account with capacity, and otherwise resumes in place.
- **Not done for Codex.** Codex has no limit chooser. SAB does not inspect a
  Codex session's child processes before the restart, as it does for Claude's
  Bash-tool shells.
- **Testing.** Unit tests cover this path; no live Codex canary has run.

### Additional Codex login profiles

```bash
sab account login-codex second-profile
```

This explicit local login uses native Codex browser authentication and a private
`account-auth/codex/second-profile` configuration home under the SAB config root.
`auth.json` is neither copied nor linked from the primary account. An allowlist
of native sessions, archived sessions, instructions, settings, skills, plugins,
memory, and rules is shared by links so Codex itself resumes native history;
SAB never reads transcript records. Codex file auth storage is forced for this
profile in both App Server and direct-TUI fallback. API-token environment
overrides are cleared for profile launches. Add a `codex-profile` reference and
owner-confirmed email to the registry only after login, then prove resume in a
controlled canary. This authorizes access to the shared project/history; it is
not a sandbox separating that account's data or memory.

### Additional Claude full OAuth profiles and refresh

```bash
sab account login-claude second-profile
```

The native browser login writes only `account-auth/claude/second-profile` and its
directory-keyed Keychain entry. It does not run `setup-token`, copy a token, or
replace the machine login. Projects/native history, settings/hooks, skills,
agents, commands, plugins, rules, and the existing provider instruction file are
allowlisted shared resources. Authentication and global account metadata are
not linked. This preserves native project memory access, not a cross-provider
memory consolidation. Login refuses profiles referenced by durable sessions;
use a new profile name for re-enrollment while old sessions remain available.

Claude records first-run completion in each profile's own `.claude.json`. A
fresh profile would otherwise open the theme picker, the security notes and,
with `--chrome`, the Claude in Chrome intro, which a detached launch can never
answer. After a successful login, and on every profile launch, SAB copies only
`hasCompletedOnboarding`, `lastOnboardingVersion`,
`hasCompletedClaudeInChromeOnboarding` and `theme` from the native config, and
only once the native login has completed onboarding. It fills missing keys and
never overwrites one. Folder trust stays with the launch-time consent helper.

Claude in Chrome pairs with the claude.ai account the Chrome extension is
signed in to. A session switched to another subscription keeps working, but its
browser tools report that the extension is not connected unless a browser
signed in with that account is available.

Attach it to an existing owner-confirmed logical account with an
`account-credential` edit. Old legacy aliases remain readable and running
sessions keep their current auth until an explicitly requested safe handover.
Both providers need a controlled native-history resume proof. Additional Claude
setup tokens may remain for manual use, but cannot establish quota eligibility
when their profile/usage scope is unavailable.

For an expired inactive Claude profile, SAB privately reads its exact refresh
credential and invokes the documented native `claude auth login` provisioning
path, with refresh/scopes in environment rather than argv. Codex's isolated
profile probe uses native `account/read` with `refreshToken: true` and its file
store. Neither starts a turn. A private lease excludes login/refresh/launch
races; live/dormant PID and tmux checks precede refresh. Native running providers
own their own refresh lifecycle. A failed/uncertain refresh or process death
leaves `.sab-auth-operation` fenced: inspect the account and enroll a fresh
profile rather than deleting the lease and blindly reusing a rotating token.

Native refresh support is not a claim that every current credential has been
upgraded. Browser authentication for a new account is an owner action.

### Explicit maintenance of a reported task

```bash
sab account pool switch --channel C0123456789 --session NATIVE_ID \
  --account owner-claude --request-id maintain-worker-1 \
  --preserve-task TASK_ID --json
```

This narrow local-owner exception applies only to a Claude worker already
`awaiting_release`, not running or dispatching work. It keeps the assignment,
pending gates, completion declaration, reports and work generation unchanged;
no unfinished task is marked complete. SAB requires fully delivered turn proof,
no pending reply deliveries or task messages/input, two stable native idle observations and a
single-pane process tree containing only the provider ancestor chain and exact
SAB channel server. Any unknown child job is refused, not terminated.

The complete task checkpoint is journaled before restart. Team replies,
completion/release, messages and reconciliation are fenced during a prepared,
restarting or interrupted handover. A crash never replays instructions or
releases the task. A proved preflight rejection clears the maintenance fence
without teardown; it can be corrected and retried with a new request ID.
Query the original request and explicitly reconcile an exact
live replacement; a failed restart remains reserved for owner recovery. This
exception never creates automatic rotation proof. Normal/bulk updates and
automatic selection still exclude reserved workers. Decline any native quota
chooser without enabling credits before requesting maintenance.

A completed automation bootstrap must first relinquish ownership using
`sab automation release EXTERNAL_KEY --session NATIVE_ID --channel CHANNEL_ID
--tmux EXACT_TMUX --request-id ID`. This operation preserves the original
external-key receipt, session, whitelist and one-time prompt claim; it does
not stop or archive the channel. It can verify an exact native resume after
the original tmux disappeared. An automation with pending setup, a rebound
channel, unknown process or still-live superseded tmux cannot be released.

### Group/account management

`sab account list [--json]` presents registered provider/email/group identities
after staging, or legacy aliases with unresolved identity before staging. It
never prints token fragments. Legacy `remove` refuses any staged or durable
session reference; use the drain/retire lifecycle rather than stranding it.

```bash
sab account group list --json
sab account group create research "Research" --member primary-claude \
  --revision 1 --request-id create-research --json
sab account group rename research "Research team" --revision 2 --request-id rename-research
sab account group add research second-claude --revision 3 --request-id add-second
sab account group prefer research second-claude --revision 4 --request-id prefer-second
sab account group drain-member research primary-claude --revision 5 --request-id drain-primary
sab account group delete-member research primary-claude --revision 6 --request-id remove-primary
sab account group remove research --revision 7 --request-id remove-research
```

Examples illustrate separate edits, not an automatically valid migration: a
referenced account/member or routed group cannot be removed. Inspect `group
list` for the current revision and exact session references. A drain stops new
selections without killing a turn, releasing a task, deleting credentials, or
removing history. At idle boundaries the ordinary proven automatic policy may
move eligible sessions; otherwise the owner switches exact idle/dormant
bindings. Delete-member/retire is a second explicit operation after all
references, including standby/dormant records, are corrected. A preferred
account must first be replaced as provider preference before draining it.

`sab account manage --input FILE|- --json` accepts this strict envelope:

```json
{
  "requestId": "attach-full-profile",
  "expectedRevision": 8,
  "operation": {
    "type": "account-credential",
    "account": "second-claude",
    "provider": "claude",
    "profile": "second-profile"
  }
}
```

Other operations are `account-enroll` (complete enrollment account plus `group`),
`account-drain`, `account-retire`, `account-enable` (`account` selector), and
`channel-group` (`channel` ID plus `group`). Owner-only Slack supports
`/sab-account groups`, the email/usage control panel, and `/sab-account manage
<JSON>` using the same strict CAS writer. No manifest change is required.
Edits never delete credential files or start/stop a process. A timeout is queried
by inventory/registry receipts and retried with the **same** envelope; newer
policy cannot be overwritten by an old retry. Policy revisions invalidate old
quota/resume eligibility and stale Slack controls.

### Required controlled canary (not performed by unit tests)

1. From a clean reviewed release commit, back up configuration/state privately
   and record a rollback tag. Review every channel/standby correction first.
2. Roll exactly one daemon in `shadow` mode; verify existing turns/output,
   topics, and team authority remain intact. Check quota timestamps and fixed
   unavailable reasons without making an inference call just for usage proof.
3. With owner approval, select one **idle non-team** session and enable manual
   mode. Record native ID, cwd, model/effort/flags, queued input, and account.
4. Request one exact account switch and verify native adoption and a real
   owner-requested answer; check the correct channel, identity, and unchanged
   settings. Repeat the return direction. A passing unit test is not this proof.
5. Restart the daemon around a prepared/committed handover, query the request
   outcome, and prove no duplicate process, prompt, task release, or result.
6. Only after fresh usage observations exist for the candidate accounts may
   automatic mode be canaried. Never inject synthetic quota into live state.
   Additional Claude full-scope sign-ins may be deferred, but those accounts
   then remain ineligible for automatic capacity selection.
7. Keep the prior tag/backup until every installed provider's ordinary
   create/message/resume gates pass. No Slack manifest reinstall is required.

## Remaining proof gates and sequence

1. **Controlled provider proof:** verify registered identity and no-inference
   inactive usage refresh for each credential type; demonstrate credential
   isolation and native conversation resume under a different authorized
   account. Prove that native homes preserve history, hooks, MCP consent,
   settings, skills, and memory. Never swap global auth files or copy refresh
   tokens around live concurrent processes.
2. **Registry activation:** inactive owner-confirmed identities, alias
   coalescing, groups, exact policy checks, atomic staging, and private prior
   revisions are implemented. Remaining: authenticated identity enrollment,
   shared-quota proof, explicit live binding migration and rollback integration,
   and preservation of legacy resume. Staging alone does not cross this gate.
3. **Manual pooled switching:** the exact idle-session journal and shared
   restart/input fence are implemented. Native-provider canaries remain open.
   Active delegated-task/account migration is deliberately not implemented:
   preserve those reservations/jobs instead of using generic teardown.
4. **Monitoring/shadow mode:** implemented and fixture-tested. Compare against
   real resets and concurrent sessions in the canary. Unavailable scopes and
   inactive expired credentials remain explicit, not silently completed proof.
5. **Opt-in automation:** conservative safe-boundary selection and switch-back
   are implemented behind manual-resume/usage proof gates. Production rollout
   remains unapproved. Instant active-task/quota-blocked recovery requires a
   separately proven native checkpoint protocol; uncertain work is not replayed.

The implementation is provider-adapter/durable-coordination **preparation**,
not a lifecycle rollout. Regression tests cover redaction, deduplication,
bounded malformed input, exact local binding snapshots, isolated probes, legacy
command compatibility, channel ceilings, stable identities, idempotent staging,
concurrent publication, abrupt process death, quota normalization, denied/stale
capacity, shared-principal reservations, polling backoff, isolated native probes,
exact handover journals, persistence failure, and non-mutation of unrelated
sessions. Runtime state is created only in an explicitly enabled mode.
Run the complete [contributor validation](../AGENTS.md#development-workflow).
Live account/resume canaries remain subject to the
[stability policy](stability-policy.md) and an explicit maintenance window; a
schema test must never be relabelled a successful live-provider proof.

## Initial local evidence (2026-10-17)

Later read-only authenticated probes on the same date verified the default
Claude and Codex identities and returned subscription windows without inference
or credential mutation. The two additional Claude setup-token identities
returned `scope-unavailable`; they still need owner full-login enrollment.
Claude's real unused five-hour window returned `utilization: 0, resets_at: null`;
the adapter now represents that explicitly without inventing a reset, while
missing/nonzero reset evidence still fails closed. These are point-in-time
telemetry proofs, not cross-account resume or native refresh canaries.

The automated review's concrete route-bypass, interrupted-input, identity-proof,
shadow-mode, idle-reservation, and Slack-size findings were adjudicated as
correctness issues and fixed. The controlled live canary, private enrollment/
binding corrections, new full logins, and any eventual unrestricted active-task
recovery remain separate gates. No live rollout was performed during development.

The isolated public-command probe succeeded with Claude Code **2.1.302** and
Codex CLI **0.162.1**. Claude advertised its JSON authentication-status command.
Codex's generated schema advertised both account-read methods, email identity,
quota utilization/reset fields, multiple quota buckets, an explicit usage
account ID, and the backend `ordinaryUsageAllowed` permission field. A future
scheduler must respect a fresh backend denial even when a percentage or clock
would appear to permit work.

These observations involved no live credential query or conversation. They do
**not** establish inactive Claude polling, the registered identity of an opaque
setup token, or successful cross-account resume for either provider. Those
remain the next controlled proof gates, not silently completed milestones.
