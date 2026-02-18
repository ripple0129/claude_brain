import { spawn } from "node:child_process";

export type RunClaudeOptions = {
  message: string;
  systemPrompt?: string;
  sessionId?: string;
  timeoutMs?: number;
  claudePath?: string;
  mcpConfigPath?: string;
  onText?: (text: string) => void;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

export type RunClaudeResult = {
  /** Prose-only text (no tool calls/results) — used for final message */
  text: string;
  /** Full text including tool calls and results — used for image path scanning */
  fullText: string;
  sessionId: string;
};

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_CLAUDE_PATH = "claude";

// Tools that produce user-facing interactive content
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);

type ToolUseContent = {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
};

type QuestionOption = {
  label: string;
  description?: string;
};

type Question = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
};

/**
 * Format AskUserQuestion tool input into readable text
 */
function formatAskUserQuestion(input: Record<string, unknown>): string {
  const questions = input.questions as Question[] | undefined;
  if (!Array.isArray(questions) || questions.length === 0) return "";

  const parts: string[] = ["\n---"];
  for (const q of questions) {
    parts.push(`\n**${q.question}**${q.multiSelect ? " (可多選)" : ""}`);
    if (Array.isArray(q.options)) {
      for (let i = 0; i < q.options.length; i++) {
        const opt = q.options[i];
        const desc = opt.description ? ` — ${opt.description}` : "";
        parts.push(`${i + 1}. ${opt.label}${desc}`);
      }
    }
  }
  parts.push("\n---\n");
  return parts.join("\n");
}

/**
 * Extract a short summary of the tool input for inline display.
 * e.g. Bash {command:"ls -la"} → "ls -la"
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  // Pick the most representative field for each known tool
  const key =
    name === "Bash" ? "command"
    : name === "Read" ? "file_path"
    : name === "Write" ? "file_path"
    : name === "Edit" ? "file_path"
    : name === "Grep" ? "pattern"
    : name === "Glob" ? "pattern"
    : name === "WebFetch" ? "url"
    : name === "WebSearch" ? "query"
    : name === "Task" ? "description"
    : null;

  if (key && typeof input[key] === "string") {
    const val = input[key] as string;
    // Truncate long values
    return val.length > 120 ? val.slice(0, 117) + "..." : val;
  }
  return "";
}

/**
 * Format tool_use content blocks from assistant message into readable text
 */
function formatToolContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use" || typeof b.name !== "string") continue;

    const name = b.name as string;
    const input = (b.input ?? {}) as Record<string, unknown>;

    if (name === "AskUserQuestion") {
      parts.push(formatAskUserQuestion(input));
    } else if (!INTERACTIVE_TOOLS.has(name)) {
      const summary = summarizeToolInput(name, input);
      parts.push(summary ? `\n[${name}] ${summary}\n` : `\n[${name}]\n`);
    }
  }
  return parts.join("");
}

/**
 * Format tool_result content into readable text.
 * Truncates long results to keep the stream readable.
 */
function formatToolResult(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;

    let text = "";
    if (typeof b.content === "string") {
      text = b.content;
    } else if (Array.isArray(b.content)) {
      text = (b.content as Record<string, unknown>[])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
    }

    if (!text.trim()) continue;

    // Truncate very long results (e.g. file contents, command output)
    const maxLen = 800;
    const truncated = text.length > maxLen
      ? text.slice(0, maxLen) + `\n... (${text.length - maxLen} chars truncated)`
      : text;

    parts.push(`\n📎 結果：\n${truncated}\n`);
  }
  return parts.join("");
}

export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const claudePath = opts.claudePath ?? DEFAULT_CLAUDE_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const argv: string[] = [
    "-p", opts.message,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  if (opts.mcpConfigPath) {
    argv.push("--mcp-config", opts.mcpConfigPath);
  }

  if (opts.sessionId) {
    argv.push("--resume", opts.sessionId);
  } else if (opts.systemPrompt) {
    argv.push("--append-system-prompt", opts.systemPrompt);
  }

  // Remove CLAUDECODE env var to prevent nested session detection
  // Set CI=true to suppress interactive prompts (feedback surveys, etc.)
  const env = { ...process.env };
  delete env.CLAUDECODE;
  env.CI = "true";

  const log = opts.logger;
  const mode = opts.sessionId ? `resume:${opts.sessionId.slice(0, 12)}` : "new";
  log?.info(`claude-runner: spawning [${mode}] args=${argv.filter(a => a !== opts.message).join(" ")}`);

  return new Promise<RunClaudeResult>((resolve, reject) => {
    const child = spawn(claudePath, argv, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let sessionId = "";
    let fullText = "";   // Everything: prose + tool calls + tool results
    let proseText = "";  // Only text_delta from Claude (no tool noise)
    let stderr = "";
    let lineBuf = "";
    let resultError = ""; // Error from result event (in stdout, not stderr)
    // Track which tool_use blocks we've already emitted notifications for
    const emittedToolBlocks = new Set<string>();

    function processLine(line: string): void {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;

        // Session init
        if (event.type === "system" && event.subtype === "init") {
          if (typeof event.session_id === "string") {
            sessionId = event.session_id as string;
          }
          return;
        }

        // Streaming text delta — this is Claude's prose (no tool noise)
        if (event.type === "stream_event") {
          const inner = event.event as Record<string, unknown> | undefined;
          if (inner?.type === "content_block_delta") {
            const delta = inner.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              const text = delta.text as string;
              fullText += text;
              proseText += text;
              opts.onText?.(text);
            }
          }
          return;
        }

        // Accumulated assistant message — extract tool_use content
        // Tool calls only go to fullText (for image path scanning), NOT to SSE stream
        if (event.type === "assistant") {
          const msg = event.message as Record<string, unknown> | undefined;
          const content = msg?.content as unknown[] | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" && typeof b.id === "string") {
                if (emittedToolBlocks.has(b.id as string)) continue;
                emittedToolBlocks.add(b.id as string);

                const formatted = formatToolContent([block]);
                if (formatted) {
                  fullText += formatted;
                }
              }
            }
          }
          return;
        }

        // Tool result from executed tool (type: "user" with tool_result content)
        // Tool results only go to fullText (for image path scanning), NOT to SSE stream
        if (event.type === "user") {
          const msg = event.message as Record<string, unknown> | undefined;
          const content = msg?.content as unknown[] | undefined;
          if (Array.isArray(content)) {
            const formatted = formatToolResult(content);
            if (formatted) {
              fullText += formatted;
            }
          }
          return;
        }

        // Final result
        if (event.type === "result") {
          if (typeof event.session_id === "string") {
            sessionId = event.session_id as string;
          }
          // Capture error details from result event (shown in stdout, not stderr)
          if (event.is_error || event.subtype === "error_during_execution") {
            const errors = event.errors as string[] | undefined;
            resultError = errors?.join("; ") ?? String(event.result ?? "unknown error");
          }
          // Don't overwrite fullText with result — we've been accumulating
          // text + tool content which is richer than result.result
          return;
        }
      } catch {
        // Skip unparseable lines
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Log stderr lines as they arrive for real-time diagnostics
      for (const line of text.split("\n")) {
        if (line.trim()) log?.warn(`claude-runner: [stderr] ${line.trim()}`);
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
      reject(new ClaudeTimeoutError(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer.unref) {
      timer.unref();
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(
          new ClaudeNotFoundError(
            `Claude CLI not found at "${claudePath}". Install it: npm install -g @anthropic-ai/claude-code`,
          ),
        );
      } else {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (lineBuf.trim()) {
        processLine(lineBuf);
        lineBuf = "";
      }

      log?.info(
        `claude-runner: [${mode}] exited code=${code} ` +
        `sessionId=${sessionId ? sessionId.slice(0, 12) : "(none)"} ` +
        `proseLen=${proseText.length} fullLen=${fullText.length} ` +
        `stderrLen=${stderr.length}`,
      );

      if (code !== 0) {
        const detail = resultError || stderr.trim() || "(no details)";
        log?.error(`claude-runner: [${mode}] FAILED detail=${detail.slice(0, 300)}`);
        reject(
          new ClaudeExitError(
            `Claude CLI exited with code ${code}: ${detail}`,
            code ?? 1,
            stderr,
          ),
        );
        return;
      }

      if (!sessionId) {
        log?.error(`claude-runner: [${mode}] no session_id in output`);
        reject(new ClaudeParseError("Claude CLI response missing session_id"));
        return;
      }

      resolve({ text: proseText, fullText, sessionId });
    });
  });
}

export class ClaudeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeNotFoundError";
  }
}

export class ClaudeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeTimeoutError";
  }
}

export class ClaudeExitError extends Error {
  code: number;
  stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = "ClaudeExitError";
    this.code = code;
    this.stderr = stderr;
  }
}

export class ClaudeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeParseError";
  }
}
