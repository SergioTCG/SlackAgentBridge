# Security

## Read this before installing

Slack Agent Bridge is **remote code execution by design**. It connects a Slack
workspace to Claude Code, Codex, and/or Pi processes running with the local
user's filesystem, network, developer credentials, and shell access.

Flagless Slack spawns default to:

- Claude Code: `--dangerously-skip-permissions`
- Codex CLI: `--dangerously-bypass-approvals-and-sandbox` (`--yolo`)
- Pi: unrestricted built-in tools (no extra dangerous-mode flag is needed)

Explicit launch flags replace those defaults. In plain terms:

> Anyone able to send an accepted Slack message as the bridge owner can cause
> arbitrary commands to run on this Mac with the owner's local privileges.

This is the intended feature. The primary security boundaries are therefore the
Slack account, Slack workspace administration, local token files, provider
accounts, and the Mac user running the daemon.

## Trust model

- One Slack user currently claims the bridge and becomes its owner. Slash
  commands, permission decisions, session resurrection, and configuration
  remain owner-only. The accepted multi-node design will retain that identity
  as bridge administrator and add explicit node-scoped operators; those roles
  are not active until the remote transport ships.
- Session channels are private. The owner may explicitly allow collaborators to
  send labelled prompts to a live session; collaborators cannot run commands,
  answer permissions, or resurrect the session. Their accepted prompts may ask
  the live agent to return generated workspace artifacts to that same channel.
- Workspace administrators may have powers that bypass ordinary private-channel
  expectations or impersonate/recover accounts. Do not use an untrusted
  workspace.
- The local Mac user can read provider credentials and bridge state and is fully
  trusted. This project is not a multi-user host isolation boundary.

## Risk-reduction measures

- **Sender allowlist:** messages from users other than the owner or an explicitly
  allowed live-session collaborator are ignored.
- **Private channels:** session and control channels are created private and are
  mapped by immutable Slack channel ID.
- **Outbound Slack connection:** Socket Mode uses an outbound WebSocket and
  requires no internet-facing listener. The local hook/channel HTTP service
  binds to loopback on port `8877`; it must not be exposed through a proxy.
- **Restricted spawning:** Slack-created working directories must resolve under
  `$HOME`. Claude, Codex, and Pi use separate remote-flag allowlists.
- **Loopback automation ownership:** the automation lifecycle API listens only
  on `127.0.0.1:8877`; possession of the local macOS account is its trust
  boundary. It rejects non-loopback Host values, browser Origin/fetch metadata,
  and simple non-JSON mutation requests so an untrusted webpage cannot drive
  the local RCE surface. It canonicalizes an existing
  working directory under `$HOME`, applies the provider flag allowlist, rejects
  Claude `--continue`, journals an exact tmux identity before launch, and
  refuses stop/archive if the provider, native session, tmux, or channel has
  been rebound. Never expose this port through SSH forwarding or an HTTP proxy.
  `sab automation validate-flags` applies that same allowlist locally without
  contacting the daemon or launching anything. Its Codex model and effort
  shorthands are strictly validated before being translated; callers still
  cannot supply arbitrary Codex configuration overrides.
  Explicit `release` is a separate owner operation for completed bootstrap
  setup. It requires the exact current local session/channel/tmux, provider-root
  proof and an absent superseded tmux; it retains the external-key receipt and
  changes no provider, channel, whitelist or prompt state. Released records are
  excluded from adoption/ownership and their stop/archive API is refused.
- **Invite before trust:** both automated collaborator setup and the manual
  status-panel picker call `conversations.invite` before changing the prompt
  allowlist. Invitation failure is visible and leaves that user untrusted;
  successful setup persists the display name with the allowlist entry.
- **Explicit session-team graph:** only the owner may create or mutate a team,
  and Slack's picker accepts only an exact authoritative private SAB channel.
  The default graph permits coordinator-to-worker tasks and exact-task replies
  back to the coordinator; it has no worker mesh or generic Slack history read.
  Agents receive neither Slack credentials nor a raw destination selector.
- **Turn-scoped lateral authority:** persistent team membership is insufficient
  to dispatch work. `sab team` proves provider-process ancestry, exact PID/tmux,
  native session, authoritative channel mapping, and the implicit local node on
  every call. Only a current owner-initiated coordinator turn receives a
  bounded dispatch budget and exact-task control. Collaborator and unrelated
  terminal turns fail closed. A coordinator may cancel/replace only its queued
  work and may message only the exact active task/session it created; the
  message is journaled before visible Slack and provider delivery, and an
  uncertain provider attempt is never replayed. A worker may reply only while
  its exact native session owns the exact
  journaled task. Such an authenticated task-bound reply proves prompt
  acceptance if the provider omitted its lifecycle marker, but never substitutes
  for a stable turn report or explicit task release. Stop, kill, session
  death/replacement, switch, removal,
  close, and expiry revoke or invalidate stale authority.
- **Root-provider process claims:** a nested provider utility may inherit SAB
  environment variables and live under the same tmux pane, but another matching
  provider process in its ancestry proves it is a child job. SAB rejects that
  claim before channel registration, team calls, or artifact delivery.
- **Journaled, auditable team delivery:** request identities and payload digests
  deduplicate retries. The daemon persists `queued` before Slack/provider side
  effects, posts the bounded task and status in both linked channels, and
  persists one atomic target/task/session claim with `startedAt` before
  injection. Availability derives from that durable active task, not a separate
  optimistic session flag. A restart may deliver a
  queued task but never retries an uncertain dispatch. Persisted worker replies
  prevent already-accepted work from being misclassified as uncertain; stable
  provider finals can report only their bound task/session. New tasks keep that
  exact worker reserved until bounded gates are clear, the worker declares
  readiness, and the coordinator releases it. Accepted coordinator messages
  fence readiness/release until exact provider delivery, and task-local work
  generations are durably attached to the accepted native turn so delayed
  earlier finals cannot satisfy newer work by sampling current task state.
  Repeated live exact-process idle
  proof may close a hookless Codex turn only as a warning-bearing report;
  boot-time idle lacks that proof and fails closed for legacy running work.
  Report and completion posts have durable,
  idempotent delivery claims; input/file delivery is serialized in-process and
  failed queued envelopes are removed before reconnect; missing audit-card
  updates are reported without suppressing the stable result; queue, reply,
  message, and lifetime limits fail visibly. Pending deliveries cannot be
  pressure-pruned, and pruning is persisted before staged bytes are removed.
- **Separate team-file boundary:** team transfer never reuses an artifact grant.
  It requires per-worker file permission, validates paths against the exact
  source workspace with the existing count/size/realpath rules, hashes content,
  copies bytes into a mode-restricted private task directory, uploads an audit
  copy to the fixed linked channel, and injects only the private copy. A retry
  cannot change content or destination. Cross-node file relay remains disabled.
- **Provider isolation:** `/sab-*` resolves provider-specific behavior from the
  channel's authoritative session. `/sab-new` and `/sab-switch` require an
  explicit provider, and provider-incompatible commands or flags are rejected
  before mutation.
- **Execution-node isolation:** missing node metadata means only the historical
  implicit local node. Explicit remote metadata must agree across the immutable
  channel and session binding. Unknown, offline, or mismatched nodes fail closed
  rather than executing locally. The optional node listener is disabled unless
  `SAB_NODE_LISTEN` is explicitly configured. A non-loopback bind requires TLS,
  an explicit WSS public URL, and a mode-0600 private key. This listener is
  separate from the loopback RCE API on port 8877, which must never be exposed.
- **One-use node enrollment:** the administrator's loopback-only `sab node`
  API rejects browser-originated mutation, verifies the intended operator with
  Slack before minting an invitation, stores only a token hash, and returns the
  raw secret exactly once. The node reads it only from stdin or a mode-0600
  regular file, generates a mode-0600 Ed25519 key locally, and sends only the
  public key. Authentication uses a one-use 30-second signed challenge;
  persisted connection epochs fence older sockets, heartbeat expiry closes
  abandoned peers, and revocation closes only that node. Nodes never receive
  Slack credentials, and the coordinator never receives provider credentials.
- **Viewport/process separation:** providers live in detached-capable tmux,
  independently of Ghostty. Terminal list/open/close resolves only authoritative
  active channel mappings, verifies the exact live tmux/provider, and serializes
  operations. Closing detaches the exact tmux client; it never sends agent
  input, kills a process, or changes session authority. Standby and provisional
  legs are excluded from bulk actions.
- **Transactional provider switch:** only the owner can confirm a switch. The
  source remains authoritative until a target-native readiness turn succeeds;
  target failure or daemon restart restores the source. Exact tmux/provider
  claims fence stale and standby hooks from racing the active leg.
- **Private, bounded handoffs:** provider handoffs exclude chain-of-thought,
  credentials, tokens, complete transcripts, and large source dumps. They are
  capped at 64 KiB, integrity checked, stored under `~/.config/ccs/handoffs`
  with restrictive modes, and retained for two generations.
- **Reviewed instruction changes:** automatic preflight reads only root
  `AGENTS.md` and `CLAUDE.md`, never global provider memory. The auxiliary
  provider runs in a private neutral directory without Slack or bridge
  credentials and returns bounded document sections; it does not author patch
  syntax. The bridge creates the patch deterministically. Proposed patches are
  read-only until owner approval and are constrained by hashes, Git-root paths,
  regular-file/symlink checks, binary/rename/mode rules, temporary apply
  validation, `git apply --check`, and the Codex instruction-size budget.
- **Capability-bound file egress:** an accepted Slack prompt creates an opaque,
  one-use upload grant lasting at most two hours. It is bound to that sender,
  message, provider, live process/tmux session, channel, and canonical workspace.
  The agent cannot select another Slack destination. Realpath checks reject
  traversal and symlink escapes; only regular files are accepted, with ten-file
  and 100 MiB aggregate limits. Successful grants cannot be replayed, and all
  outstanding grants disappear when the daemon restarts. A committed provider
  switch also revokes grants issued to the source leg; queued owner messages
  receive new target-bound grants after commit.
- **Explicit Codex hook trust:** setup never bypasses Codex's hash-based hook
  review. Changed hooks require local review through `/hooks`.
- **Failure-safe permission relay:** if Codex cannot obtain a Slack verdict, the
  hook returns no decision and Codex falls back to its local approval policy.
- **Bounded Claude question relay:** only a Claude `PreToolUse` event whose exact
  tool name is `AskUserQuestion` may contribute structured question content.
  Question, option, description, and preview fields are type-checked, escaped,
  length-capped, and converted to fixed-destination Slack blocks; arbitrary tool
  inputs are ignored. Answers still travel only to the authoritative session's
  existing tmux identity.
- **Bounded Codex App Server relay:** the per-session App Server and transparent
  event proxy bind only to random loopback ports. The proxy forwards every frame
  unchanged to the TUI but submits only completed `agentMessage` commentary,
  one `final_answer` after its exact successful `turn/completed`, and a typed
  root `thread/started` identity to port `8877`. That identity can bootstrap
  only an exact pending automation after cwd, tmux, provider-root ancestry, and
  lifecycle checks; child threads, ordinary sessions, and stopped or rebound
  automations are no-ops or fail closed.
  Stop and App Server completion share one durable native-turn claim, so a late
  hook cannot duplicate the final. The daemon independently
  canonicalizes a retained npm App Server launcher only to its direct matching
  native child, then requires that exact Codex process, tmux, native session,
  active channel, and lineage state before posting. Command lines, command
  output, diffs, plans, reasoning, and partial deltas never enter either
  endpoint. Accepted commentary and finals are serialized in App Server source
  order before loopback delivery; a delayed earlier event therefore cannot be
  made stale by a later final. Shutdown interrupts commentary backoff, closes
  WebSocket ingress, and follows the latest accepted stable-final tail to
  quiescence before the proxy exits. A queued completion frame therefore cannot
  appear after a stale one-time shutdown snapshot;
  final retries remain spaced during shutdown so transient pressure cannot be
  collapsed into a lossy burst;
  the correlated App Server stays alive until that drain completes so ancestry
  proof remains possible. Drain exhaustion is explicit rather than silent.
  The runner propagates that exhaustion as a nonzero failure and prints only a
  bounded proxy diagnostic; it never claims clean delivery after losing its
  final retry path.
  Private transition finals resolve only their exact waiter and never enter
  Slack.
- **Explicit Pi extension loading:** the bridge extension is loaded by
  `sab new pi` from the checked-out release and is not installed globally or into a
  project. Its inbound stream and permission endpoints require matching Pi
  process, tmux, session, provider, and active/provisional lineage claims.
- **Fail-closed Pi safe mode:** SAB `--safe` blocks a Pi tool call unless the
  owner approves it. Relay loss, timeout, malformed responses, and identity
  failures deny the call. This safety mode is distinct from Pi `--approve`,
  which trusts project-local settings, extensions, skills, and packages and may
  itself authorize code running with the macOS user's privileges.
- **Isolated adaptive routing:** ordinary owner prompts default to a no-tools,
  low-thinking child that receives only visible prompt text. Upload grants,
  attachment bytes, bridge/tmux identity, extensions, session state, skills,
  themes, project approval, and bridge/Slack/other-agent environment are
  withheld. Pi provider credentials may still be required to invoke the
  selected model.
  Classifier failure or ambiguity promotes to managed execution; collaborators
  never trigger it. `/sab-run mode native` disables classification for the
  session and `/sab-run direct` bypasses it once.
- **Bounded managed Pi runs:** automatic promotion and `/sab-run` are owner-only;
  managed runs carry explicit
  wall-clock, parent-turn, subagent, and review-cycle limits. Planner, scout,
  and reviewer children receive only read/search tools. Child processes have
  bridge/tmux/upload identity and Slack/other-agent environment removed. They
  load no session, extensions, skills, prompt templates, themes, or project
  approvals. Worker children are disabled
  under `--safe`, because their writes cannot traverse the parent's interactive
  Slack approval gate.
- **Local secrets:** Slack tokens and account credentials stay under
  `~/.config/ccs` with restrictive permissions and are ignored by Git.
- **Conservative self-update:** the updater fast-forwards only a clean checkout
  with no unpublished local commits. Set `CCS_AUTO_UPDATE=0` to require manual
  review and deployment. SAB-managed Codex TUIs disable the provider's native
  interactive startup update check; Codex binary changes remain explicit
  `/sab-update` maintenance rather than an unattended session-start side
  effect.
- **Live-checkout staging fence:** no-reload provider activation compares its
  checkout with both the loaded historical LaunchAgent job and the on-disk
  plist before any mutation. Missing, moved, malformed, or contradictory
  service metadata fails closed; the check runs before even clone or pull in a
  piped install, so a development worktree cannot silently replace provider
  hooks, configuration, Git state, or the public executable used by the live
  daemon.
- **Fail-closed session sweeps:** `/sab-update all` operates only on exact
  authoritative live mappings and skips interactive, transitional, managed,
  automation-owned, delegated-team, waking, or restarting sessions. It never touches dormant
  or standby legs, never runs the bulk cleanup path, and revalidates each target
  immediately before stopping it. Provider update failure does not prevent a
  safely stopped session from being resumed.
- **Fail-closed interactive management:** Block Kit controls are owner-only and
  bind the exact session identity that rendered them. Every click rechecks the
  immutable channel/session/node binding, authoritative provider, current
  catalog, and normal command gates. A stale, rebound, switched, or
  cross-channel control reports an error and performs no mutation. Model and
  effort values are validated again at action time; broad update and team-close
  actions require Slack confirmation. Pi model/effort controls also carry the
  expected native session into the extension, which rejects the control before
  mutation if Pi has changed conversations. The daemon first requires the live
  Pi stream to advertise that exact-session capability, so a preserved legacy
  extension cannot silently ignore the fence after a daemon-only rollout. A
  staged extension likewise rejects a mutable control from an older daemon that
  cannot provide the identity. Both mixed-version directions fail closed with
  an explicit activation instruction. Once any provider maintenance restart is
  reserved, overlapping lifecycle or setting mutations are rejected while owner
  prompts queue and status, usage, and terminal-view operations remain available.
  A verified native identity replacement carries the queue and fences forward;
  exact-bound artifact grants follow only that provider/channel replacement.
  Direct input remains closed until one shared ordered drain has delivered all
  queued prompts in arrival order; launch arguments and reconnecting streams
  are never independent queue consumers. Startup failures preserve the queue,
  release only stale maintenance ownership, and expose an exact-session retry.
- **Owner-private App Home:** `app_home_opened` may arrive for any workspace
  user, but only the configured owner receives bridge/session metadata or
  actions. Other users receive a static restricted view. Owner actions reuse
  the normal dispatcher, provider allowlists, transition/team gates, and
  Slack-channel audit trail. The new-session modal accepts only a currently
  listed top-level project folder, and Home navigation grants no session,
  Slack, node, team, or artifact authority.
- **Hookless Codex resume fencing:** if idle Codex does not emit `SessionStart`
  after an update, settings change, or ordinary Slack wake, the bridge may
  restore the PID only from a Codex process descending from the exact recorded
  replacement tmux. It revalidates the immutable channel/session authority and
  tmux ancestry immediately before the atomic state repair. Boot recovery uses
  the same checks and cannot adopt a standby, rebound, cross-channel, or
  unrelated Codex process.
- **Hookless worker availability fencing:** an ordinary owner turn in a resumed
  Codex worker may clear its bridge-owned busy markers only after two unchanged
  idle-surface observations following the grace period. The fallback proves the
  exact session, channel, PID/tmux ancestry, and turn fingerprint, persists
  cleanup before waking queued dispatch. An exact delegated task observed
  continuously by its live poller may create only a warning-bearing turn report
  after that same proof; it does not release the task. An already-idle legacy
  task discovered during boot fails closed, while an already-reported task is
  durably re-adopted. The owner may wake that exact reserved session, but SAB
  consumes the wake message without submitting it as unrelated task input.
  Both paths preserve the journal, never replay work, and
  never release a replacement session. No fallback path fabricates a provider
  final response from terminal output.
- **Rate-safe status delivery:** live status edits use one workspace-wide,
  bounded queue, discard superseded timer text before Slack I/O, and prioritize
  end-of-turn cleanup. Provider commentary and finals do not wait on cosmetic
  status mutations. This keeps `chat.update` backoff from withholding stable
  output or leaving a completed provider turn fenced behind timer traffic.
- **Claude resume readiness:** a detached tmux appearing is not enough to revive
  a Claude session. Only the exact `SessionStart` PID/tmux claim makes it active.
  Failed attempts retain only a mode-0600 numeric exit code under the private
  runtime directory—never pane text, prompts, credentials, or transcripts—and
  clear their input and viewport claims before reporting failure.

These measures reduce accidental exposure; they do not sandbox a provider that
was deliberately launched in dangerous mode.

Managed-run budgets are circuit breakers, not a security boundary. In
unrestricted mode the parent—and an explicitly selected worker child—still has
the macOS user's filesystem, process, network, and credential access. A long
goal can consume substantial local inference time. Pause or cancel it from
Slack when its scope or progress is no longer appropriate.

## Safer operating choices

- Protect Slack and provider accounts with strong unique credentials and MFA.
- Restrict Slack app installation and private-channel access.
- Use a dedicated macOS account or host for the bridge when practical.
- Keep provider credentials scoped to the repositories and services required.
- Supply explicit safer approval/sandbox flags instead of the dangerous default
  when unattended execution is unnecessary.
- Override remote defaults through `CCS_NEW_FLAGS`, `CCS_RESUME_FLAGS`,
  `CCS_CODEX_NEW_FLAGS`, `CCS_CODEX_RESUME_FLAGS`, `CCS_PI_NEW_FLAGS`, and
  `CCS_PI_RESUME_FLAGS`. Use SAB `--safe` when Pi tool calls should require
  Slack approval.
- Review changes to the runner, hooks, the Slack manifest, and dependencies before
  enabling self-update on a security-sensitive host.
- Regularly inspect private-channel membership and collaborator allowlists.
- Regularly inspect `/sab-team status` and `/sab-team permissions`; close teams
  whose coordination work is finished, and leave file relay off unless needed.
- Use `/sab-team drain` before a quiet merge or review boundary when active
  workers may finish but no queued task or automatic continuation should start;
  explicitly `/sab-team resume` afterward. Drain does not cancel queued work.
- Treat provider turn completion and team-task release as separate decisions.
  Workers must declare bounded pending gates with `sab team checkpoint`, clear
  them, and call `sab team complete` with the generation from the current
  authenticated task prompt; only the exact coordinator may then call
  `sab team release`. A follow-up invalidates the prior readiness declaration.
  Until its exact provider delivery succeeds, that accepted follow-up also
  blocks a new completion declaration and release. Release additionally needs
  a provider report produced after that exact completion declaration. This
  prevents a provider final from implicitly certifying tests, CI, runtime
  proof, review, or merge state that SAB cannot independently observe. SAB
  compares the timestamp captured at the provider event boundary; delayed hook
  processing and Slack backoff cannot turn an earlier final into later proof.
- Automatic continuation is opt-in (`/sab-team auto`) and bounded. Worker
  replies create only durable event identifiers; the coordinator rereads the
  authenticated team inbox before acting. An exhausted coordinator turn can
  renew one bounded dispatch budget only by atomically claiming a pending event
  for the same automatic team; manual teams, collaborators, unrelated teams,
  and eventless retries remain denied. Disable with `/sab-team manual` when
  every dispatch requires human approval. Missing Codex lifecycle hooks may
  release stale coordinator fences after repeated idle proof from the exact
  authoritative PID/tmux. For a continuously observed delegated turn, that
  proof may record only a warning-bearing report, never a fabricated final or
  automatic task release; an idle historical legacy task found during boot
  fails closed. The bridge does not
  scrape terminal answers, retry uncertain provider input, or cross a
  session/channel rebind.
- Mutation request IDs are durable receipts, not bearer capabilities. They are
  queryable only from the same exact authenticated session/team envelope and
  make an accepted timeout safe to inspect or retry. They do not weaken PID,
  tmux, provider, channel, native-session, or owner/delegated-task checks.
- Remember that mirrored prompts, responses, filenames, and attachments are
  stored under the Slack workspace's retention and administration policies.
- Treat artifact requests as deliberate data egress. Review collaborator access
  before asking an agent to send generated files containing proprietary data.

## Tokens and local files

`~/.config/ccs/env` contains the bot token (`xoxb`) and Socket Mode app token
(`xapp`). `~/.config/ccs/accounts` may contain Claude bearer credentials. Treat
both as password stores: never paste them into issues, logs, shell history, or
agent prompts, and never commit configuration backups.

The local `sab account preview` command is an offline, read-only migration
inventory. Unlike the legacy account-list display, it prints no credential
bytes, masked prefixes/suffixes, or credential-derived hashes. Inputs and
diagnostics are bounded; invalid JSON and filesystem/provider errors are
reported as fixed codes, never raw fragments. The report still contains private
email candidates and session/channel identities: do not commit it or publish it
as a generic diagnostic attachment. Cached emails, including decoded ID-token
claims, remain unverified and grant no account or quota authority.

`sab account capabilities --probe` executes only public CLI version/help/schema
commands, in disposable configuration directories with a minimal environment.
It inherits no Slack credentials, provider credentials, bridge identity, tmux,
or native session identity, and never invokes login, refresh, account RPC, model
inference, or a session resume. No secret-bearing native diagnostics are
included in its output. These preparation commands neither modify the old
registry's mode nor create a missing registry; they do not enable account
rotation or expose an account HTTP endpoint.

`sab account registry` adds a separate opt-in **inactive metadata** store. Its
strict enrollment schema accepts owner-attested emails, workspace identities,
existing credential references, group membership, and exact channel IDs. It
rejects token fields, claimed monitoring proofs, remote-node authority, and
automatic activation. Email confirmation by the owner is not provider-auth
verification. Duplicate stored credentials must have one account owner; aliases
never bypass group membership or the account's channel ceiling. A read-only
policy result is not runtime permission: the daemon keeps legacy behavior unless
the owner explicitly enables an account-pool runtime mode.

Enrollment files and revisions must be owner-owned regular files with no
group/other permissions; pool directories must be private and nonsymlinked.
Readers reject rather than repair insecure modes or symlinks. Only explicit
`stage` creates `account-pools` (`0700`) and metadata revisions (`0600`);
`plan`, `status`, and `check` never create directories. Neither path copies
tokens or edits legacy credentials, session state, grants, or tasks. Private
canonical-request and credential-source digests guard receipts/source drift but
are omitted from public reports. Treat enrollment files, revisions, and reports
as private: registered emails, aliases, and channel identities remain sensitive.
Never commit them. Keep old revisions for recovery; do not delete the newest
file to bypass a rejected policy or credential-source change.

The experimental runtime is off by default. Shadow mode only samples; manual
and automatic handovers require exact channel/group/account policy and the
ordinary maintenance fence. They never stop an active turn, delegated task,
question/permission, automation-owned session, or provider switch. Automatic
selection also requires fresh identity-bound quota and a successful manual
resume proof for that account pair/registry revision. Unknown quota, auth
failures, limited scopes, capacity banners, and provider errors are not evidence
of exhausted subscription quota. An ambiguous restart is never replayed;
disk-write failure disables further pool mutations. Requested model/effort is
never silently changed.

The sole delegated-task exception is explicit owner `--preserve-task TASK_ID`
maintenance of a local Claude worker already `awaiting_release`. An unchanged
durable task checkpoint, no pending input/messages, two stable idle surfaces
and a single-pane process tree with only the provider ancestor chain and exact
SAB channel server are required. Unknown child jobs fail closed. Task mutation
and reconciliation are fenced before teardown; gates, reports, generation and
reservation are preserved, never fabricated or released. It grants no automatic
handover proof and does not relax bulk updates, running-work or Pi/Codex guards.

An interrupted handover fences fresh/queued provider input and ordinary resume;
the next owner message cannot silently retry it. Explicit reconciliation is
bound to its exact request/native session/process/profile and fresh backend
identity, starts no process, and creates no automatic proof. A replacement whose
SessionStart a restart lost is adopted only from its journaled single-pane tmux,
as the shallowest Claude process resuming that exact native session, and must
still pass the provider-root claim. New session and
automation prompts and private provider-switch targets must satisfy their exact
channel route, not merely an earlier launch check. Scope-limited legacy tokens
are manual-only. Shadow mode cannot enforce policy or alter launch auth.

Manual/auto Codex launches pin the native default as well as named profiles to
the inspected file-auth store; a different keyring credential cannot validate
that process. This opt-in auth-store choice does not apply in off/shadow mode.

The sampler inherits no bridge, Slack, tmux, tool, or native session authority,
starts no conversation, and spends no inference tokens. Its URLs/methods are
fixed. The ordinary Codex probe receives only an access token over stdin, never
a refresh token. Claude Keychain output is captured privately. Native diagnostics
and HTTP bodies are bounded/redacted. Only isolated inactive profiles may run
native refresh under a private exclusive launch-fencing lease. The Claude
refresh token is passed privately in the documented provisioning environment,
never argv, Slack, ordinary state, or logs; Codex reads its own profile store.
SAB never refreshes the default machine login or a live profile. Ambiguous
refreshes retain a lease instead of retrying potentially rotated credentials.
Unavailable credentials cannot borrow another login's quota.

Explicit Claude/Codex profile login isolates authentication while linking an allowlist
of native history/settings/skills resources. It never copies or links
`auth.json` or `.credentials.json`. Group membership therefore authorizes that account's access to
shared workspace/history; it does not isolate project data or memory. Named
Claude launches always use their exact private credential: inherited tokens
cannot override the requested account, and missing/conflicting/insecure
credentials fail closed instead of falling back to machine login. Pool-native
launches clear auth overrides; legacy explicit native overrides remain
compatible outside pool mode.

Management metadata is private, not a secret vault. Group/account edits require
strict bounded JSON, an expected revision, and an idempotency identity. Removal
checks all session references, including dormant/standby legs. Draining blocks
new selection; it neither kills active work nor erases credentials/history.
Changing group membership does not remove an account's independent channel
ceiling. Policy changes invalidate old quota/canary eligibility and Slack
controls. Tokens, arbitrary URLs, paths, and remote node claims are rejected.

The app-level token can open the Socket Mode event stream; the bot token can act
with the OAuth scopes declared in `slack/app-manifest.json`. Compromise of either
requires immediate rotation. State maps local sessions, processes, paths, and
Slack channel IDs and should also remain private. During a provider transition,
it temporarily journals queued owner prompts and minimal Slack-file metadata so
a daemon restart can return them to the restored or committed leg.
Pending automations also journal their initial prompt in this `0600` state file.
At the delivery boundary the bridge persists a digest and removes the plaintext
before submitting it. Do not place credentials in automation prompts merely
because the endpoint is local.

Session-team tasks place bounded plaintext instructions, coordinator messages,
replies, results, and private file copies under `~/.config/ccs` for the bounded
task-journal lifetime. After provider acceptance the mutable delivery envelope
is dropped, but the original instruction is retained so filtered inbox output
remains useful; digests, identities, lifecycle versions, audit references, and
expiry are also retained. Slack keeps the deliberately visible task, file,
message, reply, and result records according to workspace retention. Do not
delegate secrets merely because both sessions run on the same machine.

Coordinator-to-worker messages are journaled before provider delivery. A
provable pre-write rejection, such as a disconnected Pi input stream or a tmux
buffer that could not be staged, may be retried against the same exact
task/session authority. Once a provider write is
attempted and its result is uncertain, SAB fails closed and never replays it.
Messages for one task are submitted in durable acceptance order, and an
unsettled predecessor blocks later generations. Delayed provider finals without
an exact native-turn or event-time match cannot borrow the current task binding.

## Research-preview dependencies

Claude support uses the Channels research-preview API. SAB supplies exactly one
local stdio server in its private generated MCP configuration. It loads that
server with `--dangerously-load-development-channels server:slack-bridge`,
because Claude Code 2.1.296 skips a `server:` entry passed through `--channels`
as not on the approved channels allowlist. Claude then shows its
development-channel warning on every launch. The consent helper confirms it
only for SAB's own server: the dialog must list exactly `server:slack-bridge`,
and the affirmative row must be visibly selected. Any other or additional
development channel is left for a human. Workspace trust remains separate: only the exact owner-selected launch tmux is
inspected, and the helper confirms only after Claude's affirmative trust row is
visibly selected. Unknown or changed prompt rendering fails closed.
Anthropic may change or remove the Channels contract, including its allowlist or
permission behavior. Pin and test Claude Code before an unattended production
upgrade when stability matters.

Codex support uses lifecycle and permission hooks plus its App Server event
protocol for interim commentary. Hooks remain authoritative for final delivery
and the bridge deliberately avoids transcript JSONL. App Server's WebSocket
transport is documented as experimental, so controlled Codex message, resume,
permission, commentary, and fallback canaries are required after upgrades.

Pi support uses its native extension API. The bridge deliberately avoids Pi
session JSONL, but the extension surface and trust semantics may evolve. The
release extension-loading and controlled Slack canaries are mandatory after a
Pi upgrade.

## Incident response

If the bridge may be compromised:

1. Stop the local service:

   ```bash
   launchctl bootout "gui/$(id -u)/si.sergej.claudeslackproxy"
   ```

2. Revoke the Slack app-level and bot tokens in Slack immediately.
3. Revoke or rotate affected Claude, Codex, Pi/provider, Git, cloud, and local credentials.
4. Inspect Slack channel history, daemon logs, provider transcripts, Git changes,
   running processes, and shell history from a trusted environment.
5. Reinstall from a verified release before issuing replacement tokens.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow in the Security tab instead
of opening a public issue. This is a personal open-source project maintained on
a best-effort basis with no formal response SLA.
