# Codex provider — feasibility study

*Investigated and implemented 2026-08-14 against Codex CLI 0.147.0 on macOS.*

## Verdict

**Feasible for the core bridge, without replacing or migrating the Claude path.**
Codex provides stable lifecycle hooks for session identity, terminal prompts,
final assistant text, and synchronous permission decisions. The existing tmux
layer already supplies the missing inbound transport and terminal control.

The safe design is a provider adapter, not a rewrite:

```text
Slack → daemon → tmux paste ─┬→ bin/sab-cc    → Claude Code
                             └→ bin/sab-codex → Codex CLI

Claude → hooks + JSONL transcript + MCP Channel SSE → daemon → Slack
Codex  → lifecycle hooks (final text included)      → daemon → Slack
```

Existing state remains valid: a session without a `provider` field is Claude.
Only new Codex sessions store `provider: "codex"`. Raw session IDs and channel
mappings retain their current shape, so activation needs no state migration.

## Capability map

| Requirement | Codex mechanism | Result |
|---|---|---|
| New session/channel | `SessionStart` hook (`session_id`, `cwd`, `model`) | Implemented |
| Terminal prompt → Slack | `UserPromptSubmit.prompt` | Implemented |
| Slack prompt → terminal | Existing bracketed tmux paste | Implemented |
| Final response → Slack | `Stop.last_assistant_message` | Implemented without parsing Codex JSONL |
| Interim progress → Slack | App Server `item/completed` for `agentMessage.phase=commentary` | Implemented through a transparent loopback proxy; tools, diffs, reasoning, plans, deltas, and final answers are excluded |
| Dormant-session resume | `codex resume <UUID>` in a new Ghostty/tmux window | Implemented |
| Approve/deny from Slack | Synchronous `PermissionRequest` hook; daemon holds the response until a Slack verdict | Implemented for non-yolo sessions; local prompt is the failure fallback |
| Interrupt turn | Launcher binds Codex `interrupt_turn` to F12; daemon sends F12, then confirms `Stop` or the idle input surface before clearing live status | Implemented |
| Model/reasoning control | Restart/resume with `--model` and `model_reasoning_effort` | Implemented |
| Model discovery | `codex debug models --bundled` | Implemented |
| File attachments | Existing Slack download + local-path prompt | Implemented |
| Live working status | Hook timing + bounded `ccusage` snapshots | Implemented with elapsed time and per-turn token deltas; no whimsical verb or TUI scraping |
| Usage/cost report | `ccusage codex` public JSON output | Implemented through `/codex-usage`, daily, and model reports |
| Per-session subscription switch | Claude OAuth-token mechanism | Not applicable; Codex uses its current machine login |

## Why hooks + tmux remain authoritative

Codex App Server provides the semantic distinction needed for useful interim
commentary, but its WebSocket transport remains experimental. SAB therefore
does not make App Server its lifecycle or input control plane. Each bridged
launch keeps hooks authoritative for session identity, permission decisions,
and final text, and keeps tmux authoritative for input, interrupt, and
resurrection. A per-session loopback proxy transparently forwards the protocol
between the visible TUI and App Server while observing only completed,
user-facing commentary events. If either sidecar cannot start, `sab-codex`
executes the prior direct TUI path instead.

Codex documents its transcript path as a convenience rather than a stable wire
format. The bridge consequently uses `Stop.last_assistant_message` and never
parses Codex JSONL directly. The bundled, independently maintained `ccusage`
adapter owns usage-file discovery and exposes normalized JSON to the bridge.
This keeps transcript independence and bounded token telemetry while adding
typed mid-turn prose without terminal scraping.

## Safety and rollout

- `bin/sab-cc`, `hooks/hook.sh`, Claude MCP Channels, and old state records keep
  their existing behavior. The historical `ccs` command remains an alias.
- Codex is selected only by `sab-codex` (or its `ccs-codex` alias),
  `/codex-new <folder>`, or
  `POST /spawn` with `provider: "codex"`.
- Slack ingress is namespaced: `/cc-*` is always Claude and `/codex-*` is
  always Codex. Provider flags in slash commands are rejected, and a command
  from the wrong namespace cannot mutate the session in that channel.
- Codex hooks are installed separately by `install-codex.sh`; the main installer
  does not alter `~/.codex`.
- The Codex installer does not restart the daemon. Activation is a deliberate
  maintenance action.
- The commentary proxy uses random loopback ports and the daemon accepts an
  event only when App Server PID, tmux, session ID, active channel, and lineage
  all agree. It never receives command output, diffs, plans, or reasoning.
- To mirror Claude's remote-control posture, flagless Slack spawns default to
  `--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Operators can replace
  it with explicit sandbox/approval flags or `CCS_CODEX_NEW_FLAGS`; the Slack
  permission relay applies when Codex is configured to request approval.
- The permission hook fails open to Codex's ordinary *local approval prompt*,
  not to automatic approval: `{}` means the bridge made no decision.
- `--dangerously-bypass-hook-trust` is not allowlisted. The operator reviews and
  trusts the exact hook definition with Codex `/hooks`, as the official flow
  requires.

Rollback is similarly narrow: stop starting Codex sessions, remove the
`sab-codex` and `ccs-codex` symlinks and the exact hook entries from
`~/.codex/hooks.json`, then restart the daemon during a safe window. Claude
sessions and state need no conversion.

## Residual risks

1. Codex hooks are versioned product surface and may evolve; pinning a minimum
   supported CLI version should be considered before a broad release.
2. Hook trust is hash-based. Updating the relay can require review again in
   `/hooks`; until trusted, hooks are skipped and no Slack channel is created.
3. `PermissionRequest` deliberately waits for Slack for up to 9.5 minutes. A
   daemon outage or timeout returns no decision and leaves approval in the TUI.
4. `SessionEnd` is advisory and may be delayed; the existing PID liveness sweep
   remains the reliable dormant-session fallback.
5. Core behavior has offline contract/syntax coverage, but a real Codex session,
   Slack channel, permission prompt, and resume should be smoke-tested only
   after the operator approves a daemon restart.
6. App Server's WebSocket transport is experimental. A Codex upgrade requires a
   controlled commentary and direct-fallback canary; existing direct sessions
   must restart or resume to gain the proxy.

## Primary references

- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Codex CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
