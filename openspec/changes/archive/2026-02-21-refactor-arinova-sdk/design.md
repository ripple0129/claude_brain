## Context

The OpenClaw Claude Code CLI bridge extension (`extensions-claude-code-cli/`) currently runs a single `ClaudeProcess` behind an OpenAI-compatible HTTP server. This works for single-user OpenClaw TUI/Telegram access but cannot support Arinova Chat's multi-conversation model. The reference implementation at `/Users/ripple/arinova-bridge` already solves this with `@arinova-ai/agent-sdk`, per-conversation `SessionStore`, and a `CommandHandler` — but as a standalone app, not an OpenClaw plugin.

The extension uses TypeScript directly (no build step) and is loaded via `plugins.load.paths` in openclaw.json.

## Goals / Non-Goals

**Goals:**
- Connect to Arinova Chat via `@arinova-ai/agent-sdk` WebSocket with skills registration
- Support multiple concurrent conversations, each with its own `ClaudeProcess`
- Provide slash commands: `/new`, `/sessions`, `/status`, `/help`, `/stop`, `/resume`, `/model`, `/cost`, `/compact`
- Keep the HTTP bridge on port 18810 for debugging (using shared SessionStore)
- Port and simplify `ClaudeProcess`, `SessionStore`, `CommandHandler` from arinova-bridge

**Non-Goals:**
- Multi-provider support (only `claude` CLI)
- OAuth token management
- Config file system (use OpenClaw plugin config + env vars)
- Provider switching (`/provider` command)
- Image upload for Arinova Chat path (only HTTP bridge retains catbox upload)

## Decisions

### 1. Port ClaudeProcess from arinova-bridge (not upgrade existing)

**Decision**: Replace current `claude-process.ts` with arinova-bridge's version, which is cleaner and more feature-complete.

**Rationale**: arinova-bridge's ClaudeProcess has `cwd`, `model`, `resume`, `compact`, `isBusy()`, `abortTurn()`, `getTotalCost()`, and a prose-only strategy (no fullText tracking). Our version has extra complexity for `fullText` + tool call formatting that was only needed for image path scanning. Since image upload only applies to the HTTP bridge path, we can handle that separately.

**Alternative**: Incrementally upgrade existing ClaudeProcess. Rejected because the diff would be larger than a clean replacement and would carry dead code.

### 2. SessionStore manages all ClaudeProcess lifecycle

**Decision**: A single `SessionStore` instance owns all `ClaudeProcess` instances keyed by `conversationId`. Both the Arinova agent path and HTTP bridge path use the same store.

**Rationale**: Unified session management prevents resource leaks and enables commands like `/sessions` to show all active sessions regardless of entry point. HTTP bridge uses fixed conversation ID `"debug"`.

### 3. CommandHandler as standalone module (no provider abstraction)

**Decision**: Port `CommandHandler` from arinova-bridge but remove the provider layer. Commands operate directly on `SessionStore`.

**Rationale**: We only have one provider (claude CLI), so the provider abstraction adds no value. The command handler takes `SessionStore` + config directly.

### 4. Arinova agent as a separate OpenClaw service

**Decision**: Register the Arinova agent as a second OpenClaw service (`claude-code-cli-arinova`) alongside the existing HTTP bridge service (`claude-code-cli-bridge`). Both share the same `SessionStore`.

**Rationale**: OpenClaw plugin services have independent `start`/`stop` lifecycle. Running them as separate services means the HTTP bridge works even if Arinova credentials aren't configured, and vice versa.

### 5. Config via OpenClaw pluginConfig + env vars

**Decision**: Read `arinova.serverUrl`, `arinova.botToken`, `defaults.cwd`, `defaults.maxSessions`, `defaults.idleTimeoutMs` from `pluginConfig` with env var overrides (`ARINOVA_SERVER_URL`, `ARINOVA_BOT_TOKEN`, etc.).

**Rationale**: Consistent with how the existing `port`, `claudePath`, `timeoutMs` are resolved. No need for a separate config file system.

### 6. File structure

```
extensions-claude-code-cli/
  index.ts              — plugin entry (registers provider + 2 services)
  bridge-server.ts      — HTTP bridge (refactored to use SessionStore)
  arinova-agent.ts      — NEW: ArinovaAgent SDK wrapper + onTask handler
  claude-process.ts     — REPLACED: ported from arinova-bridge
  session-store.ts      — NEW: ported from arinova-bridge
  command-handler.ts    — NEW: ported from arinova-bridge (minus /provider)
  image-replacer.ts     — kept (HTTP bridge only)
  image-uploader.ts     — kept (HTTP bridge only)
  openclaw.plugin.json  — updated configSchema
  package.json          — add @arinova-ai/agent-sdk dependency
```

## Risks / Trade-offs

- **[Risk] SDK dependency adds a WebSocket connection** → Arinova agent service is optional; if botToken is not configured, the service logs a warning and does not start. HTTP bridge works independently.
- **[Risk] Multiple ClaudeProcess instances consume more resources** → `SessionStore` enforces `maxSessions` (default 5) and `idleTimeoutMs` (default 10 min) to evict idle sessions.
- **[Risk] Breaking change to HTTP bridge behavior** → HTTP bridge now goes through SessionStore with fixed ID `"debug"`, functionally equivalent to current single-process behavior.
- **[Trade-off] Losing fullText/tool-call formatting in ClaudeProcess** → Only affects image path scanning. Mitigated by scanning prose text in HTTP bridge path (most image references appear in prose anyway).
