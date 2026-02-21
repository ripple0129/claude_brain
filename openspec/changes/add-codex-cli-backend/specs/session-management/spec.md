## MODIFIED Requirements

### Requirement: Per-conversation ClaudeProcess instances
The system SHALL maintain a separate process instance (ClaudeProcess or CodexProcess) for each `conversationId`, allowing multiple concurrent conversations with independent context. The process type is determined by the model's backend.

#### Scenario: New conversation with Claude model
- **WHEN** a message arrives for a `conversationId` with no existing session and the model maps to the Claude backend
- **THEN** a new `ClaudeProcess` is created with the conversation's configured `cwd` and `model`

#### Scenario: New conversation with Codex model
- **WHEN** a message arrives for a `conversationId` with no existing session and the model maps to the Codex backend
- **THEN** a new `CodexProcess` is created with the conversation's configured `cwd` and `model`

#### Scenario: Existing conversation
- **WHEN** a message arrives for a `conversationId` with an active session
- **THEN** the existing process is reused and its `lastActivity` timestamp is updated

#### Scenario: Model backend mismatch with existing session
- **WHEN** a message arrives with a model that maps to a different backend than the active session's process type
- **THEN** the existing session is destroyed and a new session is created with the correct process type

## MODIFIED Requirements

### Requirement: ClaudeProcess supports cwd, model, resume, compact
Each process instance (ClaudeProcess or CodexProcess) SHALL accept `cwd`, `model`, `resumeSessionId`/`threadId`, and (for Claude) `compact` options at creation time.

#### Scenario: Custom working directory
- **WHEN** a process is created with `cwd: "/Users/foo/project"`
- **THEN** the spawned process runs with that directory as its cwd

#### Scenario: Custom model
- **WHEN** a process is created with a `model` option
- **THEN** the `--model <model>` flag is passed to the CLI

#### Scenario: Resume session (Claude)
- **WHEN** a ClaudeProcess is created with `resumeSessionId: "abc123"`
- **THEN** the `--resume abc123` flag is passed to the claude CLI

#### Scenario: Resume session (Codex)
- **WHEN** a CodexProcess is created with `threadId: "thread_xyz"`
- **THEN** subsequent `sendMessage` calls use `codex exec resume <threadId>` instead of `codex exec`

#### Scenario: Compact mode (Claude only)
- **WHEN** a ClaudeProcess is created with `compact: true`
- **THEN** the `--compact` flag is passed to the claude CLI

## ADDED Requirements

### Requirement: Backend resolution from model name
The SessionStore SHALL determine the backend type (claude or codex) from the model name using a configurable `codexModels` set.

#### Scenario: Model in codexModels
- **WHEN** the model is `"gpt-5.3-codex"` and codexModels contains `"gpt-5.3-codex"`
- **THEN** `resolveBackend()` returns `"codex"`

#### Scenario: Model not in codexModels
- **WHEN** the model is `"opus-4.6"` and it is not in codexModels
- **THEN** `resolveBackend()` returns `"claude"`

#### Scenario: No model specified
- **WHEN** no model is provided in the request
- **THEN** `resolveBackend()` returns `"claude"` (default)

### Requirement: SessionStore config includes codex settings
SessionStoreConfig SHALL include `codexPath` and `codexModels` fields for Codex backend support.

#### Scenario: Config with codex settings
- **WHEN** SessionStore is constructed with `codexPath: "codex"` and `codexModels: ["gpt-5.3-codex", "o4-mini"]`
- **THEN** the store can create CodexProcess instances for those models
