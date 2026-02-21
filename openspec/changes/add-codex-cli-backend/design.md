## Context

The bridge extension (`extensions-claude-code-cli/`) currently wraps a single CLI tool — Claude Code CLI — using a persistent long-running process (`ClaudeProcess`) with the `stream-json` bidirectional protocol. OpenClaw routes all requests through this bridge via the `claude-code-cli` provider.

We want to add Codex CLI as a second backend, reachable through the same provider by varying the `model` field. The reference implementation is `arinova-bridge/src/codex/`, which spawns ephemeral `codex exec` processes per turn and uses thread IDs for session continuity.

Sessions are currently in-memory only — a bridge restart loses all session IDs. Codex's thread-based resume makes persistence essential.

## Goals / Non-Goals

**Goals:**
- Route requests to Claude or Codex CLI based on `model` in the request
- CodexProcess wrapper with same public interface as ClaudeProcess (duck typing)
- Persist session/thread IDs to disk for cross-restart resume
- All existing commands work with both backends

**Non-Goals:**
- Gemini CLI support (future)
- Formal TypeScript interface extraction (duck typing is sufficient for two backends)
- SQLite for persistence (JSON file is adequate for our session count)
- Codex-specific commands beyond what already exists

## Decisions

### 1. Ephemeral spawn model for Codex (not persistent process)

Codex CLI uses `codex exec --json` which runs a single turn and exits. Resume is via `codex exec resume <threadId>`. This is fundamentally different from Claude's persistent stdin/stdout stream.

**Decision**: CodexProcess spawns a fresh `codex` child per `sendMessage()` call, parsing JSONL events until the process exits. No persistent process.

**Alternative**: Wrapping codex in a persistent loop — rejected because codex doesn't support bidirectional streaming.

### 2. Duck-typed process interface (no formal interface/abstract class)

Both ClaudeProcess and CodexProcess expose: `start()`, `sendMessage(text, onText?)`, `isAlive()`, `isBusy()`, `abortTurn()`, `stop()`, `restart()`, `getSessionId()`, `getTotalCost()`, `getCwd()`, `getModel()`.

**Decision**: Use `ClaudeProcess | CodexProcess` union type. Both classes implement the same public methods by convention.

**Alternative**: Extract a `CliProcess` interface — adds overhead for just two implementations. Can be done later if a third backend is added.

### 3. Config-driven model routing

**Decision**: Plugin config contains a `codexModels` string array. Any model in the list routes to Codex; everything else routes to Claude. This is checked in `SessionStore.resolveBackend(model)`.

**Alternative**: Prefix-based regex (e.g., `/^(codex|gpt-|o[34])/`) — fragile as model names evolve.

### 4. JSON file for session persistence

**Decision**: Persist to `{stateDir}/bridge-sessions.json`. Structure:
```json
{
  "<conversationId>": {
    "sessionId": "thread_abc123",
    "backend": "codex",
    "model": "gpt-5.3-codex",
    "cwd": "/path/to/workspace",
    "updatedAt": "2026-02-22T10:00:00Z"
  }
}
```

Write is debounced (500ms) to avoid excessive disk I/O during rapid updates. Loaded once at startup.

**Alternative**: SQLite (arinova-bridge uses this) — overkill for <10 sessions, adds a native dependency.

### 5. Codex CLI flags

Codex spawn arguments:
- New conversation: `codex exec --json --skip-git-repo-check --full-auto [--model <m>] [--cd <cwd>] <prompt>`
- Resume: `codex exec resume --json --skip-git-repo-check --full-auto [--model <m>] <threadId> <prompt>`

Codex uses OAuth authentication — no API key env vars needed.

### 6. Auto-resume from persisted data on session create

When `createSession(convId, { model })` is called and persisted data exists for that convId with the same backend type, the threadId/sessionId is automatically passed to the new process for resume. This makes restarts transparent.

If the backend type changed (e.g., user switched from Claude to Codex via `/model`), persisted data is discarded and a fresh session starts.

## Risks / Trade-offs

- **[Codex CLI not installed]** → `resolveCodexBinary()` checks `which codex` at startup; if not found, codex models are unavailable but Claude models keep working. Log a warning.
- **[Stale thread IDs]** → Codex threads may expire server-side. If `codex exec resume` fails, auto-retry as fresh `codex exec` (same pattern as arinova-bridge).
- **[JSON file corruption]** → Wrap read in try/catch, fall back to empty state. Sessions are recoverable (just lose resume ability).
- **[Model name mismatch]** → If user sends a model not in codexModels and not a valid Claude model, Claude CLI will use its default model. This is acceptable.
