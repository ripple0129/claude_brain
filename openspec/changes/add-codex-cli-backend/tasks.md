## 1. CodexProcess

- [x] 1.1 Create `codex-process.ts` with CodexProcess class: ephemeral spawn, JSONL event parsing, threadId tracking, resume-or-new logic, auto-retry on empty resume
- [x] 1.2 Implement same public interface as ClaudeProcess: `start()`, `sendMessage(text, onText?)`, `isAlive()`, `isBusy()`, `abortTurn()`, `stop()`, `restart()`, `getSessionId()`, `getTotalCost()`, `getCwd()`, `getModel()`

## 2. Session Persistence

- [x] 2.1 Add persistence logic to SessionStore: `loadFromDisk()`, `persistSession()`, `clearPersistedSession()`, `saveToDisk()` with debounced writes to `{stateDir}/bridge-sessions.json`
- [x] 2.2 Auto-resume from persisted data in `createSession()` — pass stored threadId/sessionId if backend type matches, discard if mismatched

## 3. Model Routing

- [x] 3.1 Add `codexPath`, `codexModels` to SessionStoreConfig and `resolveBackend(model)` method
- [x] 3.2 Update `createSession()` to instantiate CodexProcess or ClaudeProcess based on `resolveBackend(model)`
- [x] 3.3 Handle backend mismatch: if request model maps to a different backend than existing session, destroy and recreate

## 4. Bridge Server & Commands

- [x] 4.1 Update bridge-server to pass request `model` to session creation and call `persistSession()` after sendMessage completes
- [x] 4.2 Update `/new` to clear persisted session data
- [x] 4.3 Update `/status` and `/sessions` to display backend type
- [x] 4.4 Update `/model` to clear persisted data on backend type switch

## 5. Plugin Config & Registration

- [x] 5.1 Update `openclaw.plugin.json` configSchema with `codexPath` and `codexModels` fields
- [x] 5.2 Update `index.ts` to resolve codexPath/codexModels from config, pass to SessionStore, and register codex models in the provider's model list
- [x] 5.3 Update `/v1/models` endpoint to list all registered models (Claude + Codex)
