## ADDED Requirements

### Requirement: Agent connects to Arinova Chat via WebSocket
The system SHALL connect to the Arinova Chat server using `@arinova-ai/agent-sdk` with a bot token for authentication. The agent SHALL automatically reconnect on unexpected disconnects.

#### Scenario: Successful connection
- **WHEN** the Arinova agent service starts with a valid `botToken` and `serverUrl`
- **THEN** the agent connects via WebSocket, authenticates, and emits a "connected" event

#### Scenario: Missing bot token
- **WHEN** the Arinova agent service starts without a `botToken` configured
- **THEN** the service logs a warning and does not attempt to connect (no crash)

#### Scenario: Auth failure
- **WHEN** the agent connects with an invalid bot token
- **THEN** the agent emits an "error" event and does not reconnect

#### Scenario: Unexpected disconnect
- **WHEN** the WebSocket connection drops unexpectedly
- **THEN** the agent automatically reconnects after the configured `reconnectInterval`

### Requirement: Agent registers skills at connection time
The system SHALL register all available slash-command skills with Arinova Chat during the authentication handshake, so users see them as available commands.

#### Scenario: Skills visible to users
- **WHEN** the agent authenticates successfully
- **THEN** the skills array (from CommandHandler) is sent as part of the auth message

### Requirement: Agent routes tasks to CommandHandler or ClaudeProcess
The system SHALL receive tasks from Arinova Chat and route them: slash commands go to CommandHandler, regular messages go to the conversation's ClaudeProcess via SessionStore.

#### Scenario: Slash command task
- **WHEN** a task arrives with content starting with `/`
- **THEN** the CommandHandler processes it and sends the response via `task.sendChunk`/`task.sendComplete`

#### Scenario: Regular message task
- **WHEN** a task arrives with regular text content
- **THEN** the system retrieves or creates a ClaudeProcess for the `conversationId`, streams chunks via `task.sendChunk`, and finalizes with `task.sendComplete`

#### Scenario: Claude process error with retry
- **WHEN** `sendMessage` fails on the first attempt
- **THEN** the system restarts the process and retries once before calling `task.sendError`

### Requirement: Agent streams responses
The system SHALL stream Claude's prose text to the user in real-time via `task.sendChunk`, and send the complete prose text via `task.sendComplete` when the turn finishes.

#### Scenario: Streaming chunks
- **WHEN** Claude emits `text_delta` events during processing
- **THEN** each delta is forwarded to the user via `task.sendChunk`

#### Scenario: Complete response
- **WHEN** Claude's turn completes
- **THEN** the full prose text is sent via `task.sendComplete`
