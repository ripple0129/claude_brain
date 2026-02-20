## ADDED Requirements

### Requirement: Slash command routing
The system SHALL intercept messages starting with `/` and route them to the appropriate command handler. Unrecognized commands SHALL be passed through to the LLM as regular messages.

#### Scenario: Known command
- **WHEN** a message starts with `/new`
- **THEN** the CommandHandler processes it and returns `{ handled: true }`

#### Scenario: Unknown command
- **WHEN** a message starts with `/unknown`
- **THEN** the CommandHandler returns `{ handled: false }` and the message is sent to Claude

### Requirement: /new command
`/new [path]` SHALL destroy the current session and create a fresh one. If a path is provided, it becomes the session's working directory.

#### Scenario: New session without path
- **WHEN** user sends `/new`
- **THEN** the current session is destroyed, a new one is created with the default cwd, and a confirmation is sent

#### Scenario: New session with path
- **WHEN** user sends `/new ~/project`
- **THEN** the path is resolved, validated to exist, set as the cwd override, and a new session is created

#### Scenario: Invalid path
- **WHEN** user sends `/new /nonexistent/path`
- **THEN** an error message is sent: "路徑不存在: /nonexistent/path"

### Requirement: /sessions command
`/sessions` SHALL list all active and dead sessions across all conversations.

#### Scenario: Sessions exist
- **WHEN** user sends `/sessions`
- **THEN** a list of sessions is displayed with status (alive/dead), session ID prefix, model, and cwd

#### Scenario: No sessions
- **WHEN** user sends `/sessions` with no active sessions
- **THEN** the message "目前沒有任何 session" is sent

### Requirement: /status command
`/status` SHALL display the current conversation's session info including provider, status, cwd, session ID, model, and cost.

#### Scenario: Active session
- **WHEN** user sends `/status` with an active session
- **THEN** session details are displayed including status, cwd, session ID, model, and accumulated cost

#### Scenario: No active session
- **WHEN** user sends `/status` with no active session
- **THEN** the message "目前無活躍的 session" is sent

### Requirement: /help command
`/help` SHALL list all available commands with descriptions.

#### Scenario: Help display
- **WHEN** user sends `/help`
- **THEN** all available commands are listed with their descriptions

### Requirement: /stop command
`/stop` SHALL abort the current in-flight operation for the conversation's session.

#### Scenario: Abort active operation
- **WHEN** user sends `/stop` while a turn is in progress
- **THEN** `abortTurn()` is called and "已中斷目前操作" is sent

### Requirement: /resume command
`/resume [id]` SHALL resume a previous session by its ID.

#### Scenario: Resume with valid ID
- **WHEN** user sends `/resume abc123` with a known session ID
- **THEN** the current session is destroyed, a new one is created with `--resume abc123`, and a confirmation is sent

#### Scenario: Resume without ID
- **WHEN** user sends `/resume` without an argument
- **THEN** an error message prompts: "請提供 session ID"

#### Scenario: Resume with invalid ID
- **WHEN** user sends `/resume invalidid` with an unknown session ID
- **THEN** an error message is sent: "恢復失敗"

### Requirement: /model command
`/model [name]` SHALL switch the model for the current conversation. This resets the session.

#### Scenario: Switch model
- **WHEN** user sends `/model sonnet`
- **THEN** the model override is set, the session is reset, and a confirmation is sent

#### Scenario: Show current model
- **WHEN** user sends `/model` without an argument
- **THEN** the current model name is displayed

### Requirement: /cost command
`/cost` SHALL display accumulated cost and token usage for the current session.

#### Scenario: Cost available
- **WHEN** user sends `/cost` with an active session that has cost data
- **THEN** the accumulated cost in USD is displayed

#### Scenario: No cost data
- **WHEN** user sends `/cost` with no session
- **THEN** "目前無使用資料" is sent

### Requirement: /compact command
`/compact` SHALL compress the conversation context by resuming the current session with the `--compact` flag.

#### Scenario: Compact active session
- **WHEN** user sends `/compact` with an active session
- **THEN** the session is reset and resumed with `compact: true`, and "已壓縮對話上下文" is sent

#### Scenario: No active session
- **WHEN** user sends `/compact` with no active session
- **THEN** "目前無活躍的 session" is sent

### Requirement: Skills registration
The CommandHandler SHALL expose a `getSkills()` method returning an array of `AgentSkill` objects for registration with the Arinova Agent SDK.

#### Scenario: Skills list
- **WHEN** `getSkills()` is called
- **THEN** it returns skills for: new, sessions, status, help, stop, resume, model, cost, compact
