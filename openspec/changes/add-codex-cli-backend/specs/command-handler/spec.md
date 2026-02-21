## MODIFIED Requirements

### Requirement: /status command
`/status` SHALL display the current conversation's session info including backend type, status, cwd, session ID, model, and cost.

#### Scenario: Active session
- **WHEN** user sends `/status` with an active session
- **THEN** session details are displayed including backend type (Claude/Codex), status, cwd, session ID, model, and accumulated cost

#### Scenario: No active session
- **WHEN** user sends `/status` with no active session
- **THEN** the message "目前無活躍的 session" is sent

### Requirement: /new command
`/new [path]` SHALL destroy the current session, clear persisted session data for the conversation, and create a fresh one. If a path is provided, it becomes the session's working directory.

#### Scenario: New session without path
- **WHEN** user sends `/new`
- **THEN** the current session is destroyed, persisted data is cleared, a new session is created with the default cwd, and a confirmation is sent

#### Scenario: New session with path
- **WHEN** user sends `/new ~/project`
- **THEN** the path is resolved, validated to exist, set as the cwd override, persisted data is cleared, and a new session is created

#### Scenario: Invalid path
- **WHEN** user sends `/new /nonexistent/path`
- **THEN** an error message is sent: "路徑不存在: /nonexistent/path"

### Requirement: /sessions command
`/sessions` SHALL list all active and dead sessions across all conversations, including backend type.

#### Scenario: Sessions exist
- **WHEN** user sends `/sessions`
- **THEN** a list of sessions is displayed with status (alive/dead), session ID prefix, backend type, model, and cwd

#### Scenario: No sessions
- **WHEN** user sends `/sessions` with no active sessions
- **THEN** the message "目前沒有任何 session" is sent

## ADDED Requirements

### Requirement: /model command clears persisted data on backend switch
When `/model` switches to a model with a different backend type, the persisted session data SHALL be cleared.

#### Scenario: Switch from Claude to Codex model
- **WHEN** user sends `/model gpt-5.3-codex` while current backend is Claude
- **THEN** the persisted session data is cleared, session is destroyed, and a new session will use Codex backend

#### Scenario: Switch within same backend
- **WHEN** user sends `/model o4-mini` while current backend is already Codex
- **THEN** session is destroyed but persisted data is preserved (threadId can still be used)
