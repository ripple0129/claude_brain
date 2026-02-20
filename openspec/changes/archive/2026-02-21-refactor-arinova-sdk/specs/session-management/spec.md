## ADDED Requirements

### Requirement: Per-conversation ClaudeProcess instances
The system SHALL maintain a separate `ClaudeProcess` for each `conversationId`, allowing multiple concurrent conversations with independent context.

#### Scenario: New conversation
- **WHEN** a message arrives for a `conversationId` with no existing session
- **THEN** a new `ClaudeProcess` is created with the conversation's configured `cwd` and `model`

#### Scenario: Existing conversation
- **WHEN** a message arrives for a `conversationId` with an active session
- **THEN** the existing `ClaudeProcess` is reused and its `lastActivity` timestamp is updated

### Requirement: Max session limit with eviction
The system SHALL enforce a configurable `maxSessions` limit. When the limit is reached, the oldest idle (non-busy) session is evicted to make room.

#### Scenario: Max sessions reached
- **WHEN** a new session is needed but `maxSessions` is already reached
- **THEN** the oldest idle session is stopped and removed before creating the new one

#### Scenario: All sessions busy
- **WHEN** max sessions is reached and all sessions are busy
- **THEN** the new session is created anyway (best-effort, no blocking)

### Requirement: Idle session timeout
The system SHALL periodically sweep sessions and stop any that have been idle longer than `idleTimeoutMs`. Dead session IDs are preserved for `/resume`.

#### Scenario: Idle timeout
- **WHEN** a session's `lastActivity` is older than `idleTimeoutMs` and it is not busy
- **THEN** the session's `ClaudeProcess` is stopped, the session is removed, and its session ID is saved to the dead sessions map

### Requirement: Dead session tracking for resume
The system SHALL preserve session IDs from destroyed sessions so they can be resumed later via `/resume`.

#### Scenario: Resume dead session
- **WHEN** `/resume <id>` is called with a dead session ID
- **THEN** a new `ClaudeProcess` is created with `--resume <id>` and the original `cwd`/`model`

### Requirement: ClaudeProcess supports cwd, model, resume, compact
Each `ClaudeProcess` SHALL accept `cwd`, `model`, `resumeSessionId`, and `compact` options at creation time, passing them as CLI flags to the `claude` process.

#### Scenario: Custom working directory
- **WHEN** a ClaudeProcess is created with `cwd: "/Users/foo/project"`
- **THEN** the spawned `claude` process runs with that directory as its cwd

#### Scenario: Custom model
- **WHEN** a ClaudeProcess is created with `model: "sonnet"`
- **THEN** the `--model sonnet` flag is passed to the claude CLI

#### Scenario: Resume session
- **WHEN** a ClaudeProcess is created with `resumeSessionId: "abc123"`
- **THEN** the `--resume abc123` flag is passed to the claude CLI

#### Scenario: Compact mode
- **WHEN** a ClaudeProcess is created with `compact: true`
- **THEN** the `--compact` flag is passed to the claude CLI

### Requirement: ClaudeProcess tracks cost
Each `ClaudeProcess` SHALL accumulate `total_cost_usd` from result events and expose it via `getTotalCost()`.

#### Scenario: Cost accumulation
- **WHEN** multiple turns complete with `total_cost_usd` in the result event
- **THEN** `getTotalCost()` returns the sum of all turn costs

### Requirement: ClaudeProcess supports abort
Each `ClaudeProcess` SHALL support aborting the current in-flight turn without killing the process, via `abortTurn()`.

#### Scenario: Abort in-flight turn
- **WHEN** `abortTurn()` is called while a message is being processed
- **THEN** the turn promise is rejected with "Turn aborted by user" and the process remains alive
