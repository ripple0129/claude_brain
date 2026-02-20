## Why

The bridge extension currently only exposes an OpenAI-compatible HTTP server for OpenClaw to reach Claude Code CLI. Arinova Chat now provides an official Agent SDK (`@arinova-ai/agent-sdk`) that enables direct WebSocket communication, eliminating the multi-hop A2A/JSON-RPC path. Additionally, the extension only supports a single conversation (one ClaudeProcess), which doesn't work when multiple Arinova Chat conversations or users connect concurrently.

## What Changes

- Add `@arinova-ai/agent-sdk` as a dependency and connect to Arinova Chat via WebSocket alongside the existing HTTP bridge.
- Replace the single `ClaudeProcess` with a per-conversation `SessionStore` that manages multiple `ClaudeProcess` instances with idle eviction and max session limits.
- Upgrade `ClaudeProcess` with `cwd`, `model`, `resume`, `compact` support, `isBusy()`, `abortTurn()`, and `totalCost` tracking (ported from `/Users/ripple/arinova-bridge`).
- Add a `CommandHandler` that registers slash-command skills with Arinova Chat: `/new`, `/sessions`, `/status`, `/help`, `/stop`, `/resume`, `/model`, `/cost`, `/compact`.
- Refactor the HTTP bridge to use the shared `SessionStore` (with a fixed `"debug"` conversation ID).
- Remove dead code: the bridge-server's inline `/new`/`/reset` handling is replaced by the command handler.

## Capabilities

### New Capabilities
- `arinova-agent`: WebSocket connection to Arinova Chat using the Agent SDK, with bot token auth, auto-reconnect, and skills registration.
- `session-management`: Per-conversation session store managing multiple ClaudeProcess instances with idle eviction, max session limits, and dead session tracking for resume.
- `command-handler`: Slash-command handling for `/new`, `/sessions`, `/status`, `/help`, `/stop`, `/resume`, `/model`, `/cost`, `/compact`.

### Modified Capabilities
<!-- No existing specs to modify -->

## Impact

- **Files changed**: `index.ts`, `bridge-server.ts`, `claude-process.ts` (major upgrade), plus new `arinova-agent.ts`, `session-store.ts`, `command-handler.ts`.
- **Dependencies**: New dependency on `@arinova-ai/agent-sdk`.
- **Config**: New config fields for `arinova.serverUrl`, `arinova.botToken`, `defaults.cwd`, `defaults.maxSessions`, `defaults.idleTimeoutMs`.
- **Existing HTTP bridge**: Preserved on port 18810 for debugging, but refactored to use shared SessionStore.
- **Image upload**: `image-replacer.ts` / `image-uploader.ts` retained for HTTP bridge path only (Arinova Chat handles images differently).
