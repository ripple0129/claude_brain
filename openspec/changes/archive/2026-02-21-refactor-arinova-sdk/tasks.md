## 1. Dependencies & Config

- [x] 1.1 Add `@arinova-ai/agent-sdk` to `package.json`
- [x] 1.2 Update `openclaw.plugin.json` configSchema with new fields: `arinova.serverUrl`, `arinova.botToken`, `defaults.cwd`, `defaults.maxSessions`, `defaults.idleTimeoutMs`
- [x] 1.3 Add config resolver functions in `index.ts` for new config fields with env var fallbacks (`ARINOVA_SERVER_URL`, `ARINOVA_BOT_TOKEN`, `DEFAULT_CWD`, `MAX_SESSIONS`, `IDLE_TIMEOUT_MS`)

## 2. ClaudeProcess Upgrade

- [x] 2.1 Replace `claude-process.ts` with arinova-bridge's version: add `cwd`, `model`, `resumeSessionId`, `compact`, `env` options; add `isBusy()`, `abortTurn()`, `getTotalCost()`, `getCwd()`, `getModel()`; switch to prose-only strategy (drop fullText/tool-call formatting); strip `node_modules/.bin` from PATH

## 3. Session Store

- [x] 3.1 Create `session-store.ts`: port from arinova-bridge with `SessionStore` class managing per-conversationId `ClaudeProcess` instances, `createSession()`, `destroySession()`, `getSession()`, `resumeSession()`, `listSessions()`, `stopAll()`, idle sweep timer, max session eviction, dead session tracking

## 4. Command Handler

- [x] 4.1 Create `command-handler.ts`: port from arinova-bridge with `CommandHandler` class, `CommandContext` type, `handle()` routing, `getSkills()` method
- [x] 4.2 Implement commands: `/new` (with path arg, cwd override), `/sessions`, `/status`, `/help`, `/stop`, `/resume`, `/model`, `/cost`, `/compact` — all operating on SessionStore directly (no provider abstraction)

## 5. Arinova Agent Service

- [x] 5.1 Create `arinova-agent.ts`: instantiate `ArinovaAgent` with serverUrl, botToken, skills from CommandHandler; implement `onTask` handler that routes to CommandHandler first, then to SessionStore for regular messages; stream chunks and send complete; handle errors with retry
- [x] 5.2 Register `claude-code-cli-arinova` as a second OpenClaw service in `index.ts` with `start`/`stop` lifecycle; skip start if botToken is not configured

## 6. HTTP Bridge Refactor

- [x] 6.1 Refactor `bridge-server.ts` to accept a shared `SessionStore` instead of managing its own `ClaudeProcess`; use fixed conversationId `"debug"`; remove inline `/new`/`/reset` handling (delegate to CommandHandler); keep SSE streaming, keep-alive, and image upload logic

## 7. Plugin Entry Wiring

- [x] 7.1 Update `index.ts`: create shared `SessionStore` and `CommandHandler` in bridge service start; pass them to both `bridge-server` and `arinova-agent`; update stop to call `sessionStore.stopAll()` and `agent.disconnect()`
