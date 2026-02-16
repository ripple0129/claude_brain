import { spawn } from "node:child_process";

export type RunClaudeOptions = {
  message: string;
  systemPrompt?: string;
  sessionId?: string;
  timeoutMs?: number;
  claudePath?: string;
  mcpConfigPath?: string;
  onText?: (text: string) => void;
};

export type RunClaudeResult = {
  text: string;
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
      // Non-interactive tool: emit brief notification
      parts.push(`\n[${name}]\n`);
    }
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

  return new Promise<RunClaudeResult>((resolve, reject) => {
    const child = spawn(claudePath, argv, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let sessionId = "";
    let fullText = "";
    let stderr = "";
    let lineBuf = "";
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

        // Streaming text delta
        if (event.type === "stream_event") {
          const inner = event.event as Record<string, unknown> | undefined;
          if (inner?.type === "content_block_delta") {
            const delta = inner.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              const text = delta.text as string;
              fullText += text;
              opts.onText?.(text);
            }
          }
          return;
        }

        // Accumulated assistant message — extract tool_use content
        // This fires for each tool_use with the complete input
        if (event.type === "assistant") {
          const msg = event.message as Record<string, unknown> | undefined;
          const content = msg?.content as unknown[] | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" && typeof b.id === "string") {
                // Only emit once per tool_use block
                if (emittedToolBlocks.has(b.id as string)) continue;
                emittedToolBlocks.add(b.id as string);

                const formatted = formatToolContent([block]);
                if (formatted) {
                  fullText += formatted;
                  opts.onText?.(formatted);
                }
              }
            }
          }
          return;
        }

        // Final result
        if (event.type === "result") {
          if (typeof event.session_id === "string") {
            sessionId = event.session_id as string;
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
      stderr += chunk.toString();
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

      if (code !== 0) {
        reject(
          new ClaudeExitError(
            `Claude CLI exited with code ${code}: ${stderr.trim() || "(no stderr)"}`,
            code ?? 1,
            stderr,
          ),
        );
        return;
      }

      if (!sessionId) {
        reject(new ClaudeParseError("Claude CLI response missing session_id"));
        return;
      }

      resolve({ text: fullText, sessionId });
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
