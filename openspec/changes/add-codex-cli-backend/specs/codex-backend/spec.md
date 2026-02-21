## ADDED Requirements

### Requirement: Ephemeral Codex CLI process spawning
CodexProcess SHALL spawn a new `codex exec` child process for each `sendMessage()` call. The process runs a single turn and exits.

#### Scenario: New conversation (no threadId)
- **WHEN** `sendMessage(text)` is called and no threadId exists
- **THEN** the system spawns `codex exec --json --skip-git-repo-check --full-auto [--model <m>] [--cd <cwd>] <prompt>`

#### Scenario: Resume conversation (has threadId)
- **WHEN** `sendMessage(text)` is called and a threadId exists from a previous turn
- **THEN** the system spawns `codex exec resume --json --skip-git-repo-check --full-auto [--model <m>] <threadId> <prompt>`

### Requirement: JSONL event parsing
CodexProcess SHALL parse newline-delimited JSON events from the codex process stdout and extract text deltas, thread IDs, and usage data.

#### Scenario: Thread started event
- **WHEN** a `{"type":"thread.started","thread_id":"..."}` event is received
- **THEN** the threadId is stored for future resume

#### Scenario: Agent message streaming
- **WHEN** `item.started`, `item.updated`, or `item.completed` events with `item.type === "agent_message"` are received
- **THEN** text deltas are computed and delivered via the `onText` callback

#### Scenario: Turn completed
- **WHEN** a `{"type":"turn.completed","usage":{...}}` event is received
- **THEN** the sendMessage promise resolves with `{ text: finalResponse, sessionId: threadId }`

#### Scenario: Turn failed
- **WHEN** a `{"type":"turn.failed","error":{"message":"..."}}` event is received
- **THEN** the sendMessage promise rejects with the error message

### Requirement: Resume auto-retry on failure
CodexProcess SHALL auto-retry as a fresh `codex exec` (no resume) if a resumed turn produces no output.

#### Scenario: Resume produces no output
- **WHEN** a resumed codex process exits with no agent_message output
- **THEN** the system retries as a new `codex exec` (without threadId), resets the stored threadId, and returns the fresh result

### Requirement: Same public interface as ClaudeProcess
CodexProcess SHALL expose the same public methods as ClaudeProcess: `start()`, `sendMessage(text, onText?)`, `isAlive()`, `isBusy()`, `abortTurn()`, `stop()`, `restart()`, `getSessionId()`, `getTotalCost()`, `getCwd()`, `getModel()`.

#### Scenario: isAlive always true
- **WHEN** `isAlive()` is called on a CodexProcess that has not been stopped
- **THEN** it returns `true` (ephemeral processes are always ready to spawn)

#### Scenario: isBusy during turn
- **WHEN** a codex child process is currently running
- **THEN** `isBusy()` returns `true`

#### Scenario: abortTurn kills child
- **WHEN** `abortTurn()` is called while a codex child process is running
- **THEN** SIGINT is sent to the child process and the sendMessage promise rejects

#### Scenario: stop kills active child
- **WHEN** `stop()` is called while a codex child process is running
- **THEN** the child is killed and no further turns can be started

### Requirement: Codex binary resolution
CodexProcess SHALL resolve the codex binary path from: explicit config → `which codex` → error.

#### Scenario: Codex binary found
- **WHEN** CodexProcess is constructed with `codexPath: "/usr/local/bin/codex"`
- **THEN** that path is used for spawning

#### Scenario: Codex binary not found
- **WHEN** no codexPath is configured and `which codex` fails
- **THEN** an error is thrown: "Codex binary not found"

### Requirement: No API key needed
Codex CLI uses OAuth authentication. CodexProcess SHALL NOT require or inject API key environment variables.

#### Scenario: Spawn without API key
- **WHEN** a codex process is spawned
- **THEN** no `OPENAI_API_KEY` environment variable is set by the bridge
