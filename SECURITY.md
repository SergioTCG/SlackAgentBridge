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
  bounded dispatch budget. Collaborator and unrelated terminal turns fail
  closed. A worker may reply only while its exact native session owns the exact
  journaled task. Such an authenticated task-bound reply proves prompt
  acceptance if the provider omitted its lifecycle marker, but never substitutes
  for a stable final. Stop, kill, session death/replacement, switch, removal,
  close, and expiry revoke or invalidate stale authority.
- **Root-provider process claims:** a nested provider utility may inherit SAB
  environment variables and live under the same tmux pane, but another matching
  provider process in its ancestry proves it is a child job. SAB rejects that
  claim before channel registration, team calls, or artifact delivery.
- **Journaled, auditable team delivery:** request identities and payload digests
  deduplicate retries. The daemon persists `queued` before Slack/provider side
  effects, posts the bounded task and status in both linked channels, and
  persists an exact target claim before injection. A restart may deliver a
  queued task but never retries an uncertain dispatch. Persisted worker replies
  prevent already-accepted work from being misclassified as uncertain; stable
  provider finals can complete only their bound task/session. Completion posts have durable,
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
- **Bounded Codex commentary egress:** the per-session App Server and transparent
  event proxy bind only to random loopback ports. The proxy forwards every frame
  unchanged to the TUI but submits only completed `agentMessage` events
  explicitly marked `commentary` to port `8877`. The daemon independently
  canonicalizes a retained npm App Server launcher only to its direct matching
  native child, then requires that exact Codex process, tmux, native session,
  active channel, and lineage state before posting. Command lines, command
  output, diffs, plans, reasoning, partial deltas, and final answers never enter
  this endpoint.
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
- **Fail-closed session sweeps:** `/sab-update all` operates only on exact
  authoritative live mappings and skips interactive, transitional, managed,
  automation-owned, delegated-team, waking, or restarting sessions. It never touches dormant
  or standby legs, never runs the bulk cleanup path, and revalidates each target
  immediately before stopping it. Provider update failure does not prevent a
  safely stopped session from being resumed.
- **Hookless Codex resume fencing:** if idle Codex does not emit `SessionStart`
  after an update, settings change, or ordinary Slack wake, the bridge may
  restore the PID only from a Codex process descending from the exact recorded
  replacement tmux. It revalidates the immutable channel/session authority and
  tmux ancestry immediately before the atomic state repair. Boot recovery uses
  the same checks and cannot adopt a standby, rebound, cross-channel, or
  unrelated Codex process.
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
- Automatic continuation is opt-in (`/sab-team auto`) and bounded. Worker
  replies create only durable event identifiers; the coordinator rereads the
  authenticated team inbox before acting. Disable with `/sab-team manual` when
  every dispatch requires human approval. Missing Codex lifecycle hooks may
  release only stale coordinator fences after repeated idle proof from the exact
  authoritative PID/tmux; the bridge does not scrape terminal answers, infer a
  worker result, retry queued provider input, or cross a session/channel rebind.
- Remember that mirrored prompts, responses, filenames, and attachments are
  stored under the Slack workspace's retention and administration policies.
- Treat artifact requests as deliberate data egress. Review collaborator access
  before asking an agent to send generated files containing proprietary data.

## Tokens and local files

`~/.config/ccs/env` contains the bot token (`xoxb`) and Socket Mode app token
(`xapp`). `~/.config/ccs/accounts` may contain Claude bearer credentials. Treat
both as password stores: never paste them into issues, logs, shell history, or
agent prompts, and never commit configuration backups.

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

Pending session-team tasks likewise place bounded plaintext prompts and private
file copies under `~/.config/ccs` until safe delivery. After provider acceptance
the journal drops task plaintext and retains its digest, identities, audit
references, replies/result, and expiry. Slack keeps the deliberately visible
task, file, reply, and result messages according to workspace retention. Do not
delegate secrets merely because both sessions run on the same machine.

## Research-preview dependencies

Claude support uses the Channels research-preview API. SAB supplies exactly one
local stdio server in its private generated MCP configuration and selects that
server through `--channels`; headless launches do not auto-accept or depend on
the interactive `--dangerously-load-development-channels` confirmation.
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
