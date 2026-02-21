## ADDED Requirements

### Requirement: Persist session data to disk
The system SHALL persist session metadata (sessionId/threadId, backend type, model, cwd) to a JSON file at `{stateDir}/bridge-sessions.json`.

#### Scenario: Session updated after sendMessage
- **WHEN** a sendMessage call completes and returns a sessionId/threadId
- **THEN** the session data is persisted to `bridge-sessions.json`

#### Scenario: File structure
- **WHEN** session data is persisted
- **THEN** the JSON file contains an object keyed by conversationId, each value having: `sessionId`, `backend`, `model`, `cwd`, `updatedAt`

### Requirement: Load persisted sessions on startup
The system SHALL load `bridge-sessions.json` on startup and use the data to enable automatic session resume.

#### Scenario: Startup with existing sessions file
- **WHEN** the bridge starts and `bridge-sessions.json` exists with valid data
- **THEN** the persisted session map is populated for use by createSession

#### Scenario: Startup with missing or corrupt file
- **WHEN** the bridge starts and `bridge-sessions.json` is missing or contains invalid JSON
- **THEN** the persisted session map starts empty and a warning is logged

### Requirement: Auto-resume from persisted data
When creating a session, the system SHALL check persisted data and automatically pass the stored sessionId/threadId for resume if the backend type matches.

#### Scenario: Matching backend — auto resume
- **WHEN** `createSession(convId, { model })` is called and persisted data exists for convId with the same backend type
- **THEN** the new process is created with the persisted sessionId/threadId for resume

#### Scenario: Backend type changed — fresh session
- **WHEN** `createSession(convId, { model })` is called and persisted data exists but with a different backend type
- **THEN** the persisted data for that convId is cleared and a fresh session is created

### Requirement: Clear persisted data on /new
The `/new` command SHALL clear the persisted session data for the conversation, ensuring the next session starts fresh.

#### Scenario: /new clears persistence
- **WHEN** user sends `/new`
- **THEN** the persisted session entry for that conversationId is removed from `bridge-sessions.json`

### Requirement: Debounced writes
Writes to `bridge-sessions.json` SHALL be debounced to avoid excessive disk I/O.

#### Scenario: Rapid updates
- **WHEN** multiple session updates occur within 500ms
- **THEN** only a single write to disk is performed
