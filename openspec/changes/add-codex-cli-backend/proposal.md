## Why

The bridge extension currently only supports Claude Code CLI as a backend. We want to also use OpenAI Codex CLI as a second "brain" — routed by model name within the same `claude-code-cli` OpenClaw provider. This eliminates the need for a separate `openai-codex` provider and unifies all CLI-based agents under one bridge.

## What Changes

- Add `CodexProcess` — an ephemeral spawn wrapper for the `codex` CLI that exposes the same interface as `ClaudeProcess`
- Route requests to Claude or Codex backend based on the `model` field in the request (matched against a configurable `codexModels` list)
- Persist session IDs (Claude sessionId / Codex threadId) to disk so sessions survive bridge restarts and can always be resumed
- Register multiple models under the `claude-code-cli` provider (both Claude and Codex models)
- Update commands (`/new`, `/status`, `/model`, `/resume`) to be backend-aware

## Capabilities

### New Capabilities
- `codex-backend`: Codex CLI process spawning, JSONL event parsing, thread-based session resume
- `session-persistence`: Disk-based persistence of session/thread IDs across bridge restarts

### Modified Capabilities
- `session-management`: SessionStore must create the correct process type based on model, and persist/restore session IDs from disk
- `command-handler`: Commands must be aware of backend type (display in `/status`, clear persisted data on `/new`)

## Impact

- **Files added**: `codex-process.ts`
- **Files modified**: `session-store.ts`, `bridge-server.ts`, `command-handler.ts`, `index.ts`, `openclaw.plugin.json`
- **Config**: `openclaw.json` gains codex models under `claude-code-cli` provider; plugin config gains `codexPath` and `codexModels`
- **Dependencies**: None new (codex CLI uses OAuth auth, no API key needed; no SQLite — JSON file for persistence)
- **No breaking changes**: Existing Claude-only usage is unaffected; codex is additive
