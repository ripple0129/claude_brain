import { spawn, type ChildProcess } from "node:child_process";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type ClaudeProcessOptions = {
  claudePath?: string;
  mcpConfigPath?: string;
  systemPrompt?: string;
  logger: Logger;
};

export type SendMessageResult = {
  /** Prose-only text (no tool calls/results) — used for final message */
  text: string;
  /** Full text including tool calls and results — used for image path scanning */
  fullText: string;
  sessionId: string;
};

// Tools that produce user-facing interactive content
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]);

const DEFAULT_CLAUDE_PATH = "claude";

/**
 * Format AskUserQuestion tool input into readable text
 */
function formatAskUserQuestion(input: Record<string, unknown>): string {
  const questions = input.questions as Array<{
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }> | undefined;
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
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
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
    return val.length > 120 ? val.slice(0, 117) + "..." : val;
  }
  return "";
}

/**
 * Persistent Claude Code CLI process using the bidirectional stream-json protocol.
 *
 * Instead of spawning a new process per message, we keep a single long-running
 * `claude` process and send/receive newline-delimited JSON on stdin/stdout.
 */
export class ClaudeProcess {
  private child: ChildProcess | null = null;
  private opts: ClaudeProcessOptions;
  private lineBuf = "";
  private sessionId = "";
  private alive = false;

  // Per-turn state — reset on each sendMessage() call
  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;
  private turnProseText = "";
  private turnFullText = "";
  private turnOnText: ((text: string) => void) | null = null;
  private emittedToolBlocks = new Set<string>();

  constructor(opts: ClaudeProcessOptions) {
    this.opts = opts;
  }

  /** Spawn the persistent process. */
  start(): void {
    if (this.child) return;

    const claudePath = this.opts.claudePath ?? DEFAULT_CLAUDE_PATH;
    const log = this.opts.logger;

    const argv: string[] = [
      "-p", "",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];

    if (this.opts.mcpConfigPath) {
      argv.push("--mcp-config", this.opts.mcpConfigPath);
    }

    if (this.opts.systemPrompt) {
      argv.push("--append-system-prompt", this.opts.systemPrompt);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;
    env.CI = "true";

    log.info(`claude-process: spawning persistent process args=${argv.filter(a => a !== "").join(" ")}`);

    const child = spawn(claudePath, argv, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.alive = true;

    child.stdout!.on("data", (chunk: Buffer) => {
      this.lineBuf += chunk.toString();
      const lines = this.lineBuf.split("\n");
      this.lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        this.processLine(line);
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) log.warn(`claude-process: [stderr] ${line.trim()}`);
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      log.error(`claude-process: spawn error: ${err.message}`);
      this.alive = false;
      this.child = null;
      if (this.turnReject) {
        this.turnReject(new Error(`Claude process error: ${err.message}`));
        this.turnResolve = null;
        this.turnReject = null;
      }
    });

    child.on("close", (code) => {
      log.warn(`claude-process: process exited code=${code}`);
      this.alive = false;
      this.child = null;
      if (this.turnReject) {
        this.turnReject(new Error(`Claude process exited unexpectedly (code ${code})`));
        this.turnResolve = null;
        this.turnReject = null;
      }
    });
  }

  /** Send a user message and wait for the complete response. */
  sendMessage(
    text: string,
    onText?: (text: string) => void,
  ): Promise<SendMessageResult> {
    const log = this.opts.logger;

    if (!this.child || !this.alive) {
      return Promise.reject(new Error("Claude process is not running"));
    }

    if (this.turnResolve) {
      return Promise.reject(new Error("Another message is already in-flight"));
    }

    // Reset per-turn state
    this.turnProseText = "";
    this.turnFullText = "";
    this.turnOnText = onText ?? null;
    this.emittedToolBlocks.clear();

    return new Promise<SendMessageResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;

      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      });

      log.info(`claude-process: sending message (${text.length} chars)`);

      this.child!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          log.error(`claude-process: stdin write error: ${err.message}`);
          this.turnResolve = null;
          this.turnReject = null;
          reject(new Error(`Failed to write to Claude stdin: ${err.message}`));
        }
      });
    });
  }

  /** Process a single line of stdout JSON. */
  private processLine(line: string): void {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // Session init
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.session_id === "string") {
          this.sessionId = event.session_id as string;
          this.opts.logger.info(
            `claude-process: session init sid=${this.sessionId.slice(0, 12)}`,
          );
        }
        return;
      }

      // Streaming text delta — Claude's prose
      if (event.type === "stream_event") {
        const inner = event.event as Record<string, unknown> | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const text = delta.text as string;
            this.turnFullText += text;
            this.turnProseText += text;
            this.turnOnText?.(text);
          }
        }
        return;
      }

      // Accumulated assistant message — extract tool_use content
      if (event.type === "assistant") {
        const msg = event.message as Record<string, unknown> | undefined;
        const content = msg?.content as unknown[] | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_use" && typeof b.id === "string") {
              if (this.emittedToolBlocks.has(b.id as string)) continue;
              this.emittedToolBlocks.add(b.id as string);

              const name = b.name as string;
              const input = (b.input ?? {}) as Record<string, unknown>;

              if (name === "AskUserQuestion") {
                const formatted = formatAskUserQuestion(input);
                if (formatted) this.turnFullText += formatted;
              } else if (!INTERACTIVE_TOOLS.has(name)) {
                const summary = summarizeToolInput(name, input);
                const formatted = summary ? `\n[${name}] ${summary}\n` : `\n[${name}]\n`;
                this.turnFullText += formatted;
              }
            }
          }
        }
        return;
      }

      // Tool result
      if (event.type === "user") {
        const msg = event.message as Record<string, unknown> | undefined;
        const content = msg?.content as unknown[] | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type !== "tool_result") continue;

            let resultText = "";
            if (typeof b.content === "string") {
              resultText = b.content;
            } else if (Array.isArray(b.content)) {
              resultText = (b.content as Record<string, unknown>[])
                .filter((c) => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text as string)
                .join("\n");
            }

            if (resultText.trim()) {
              const maxLen = 800;
              const truncated = resultText.length > maxLen
                ? resultText.slice(0, maxLen) + `\n... (${resultText.length - maxLen} chars truncated)`
                : resultText;
              this.turnFullText += `\n📎 結果：\n${truncated}\n`;
            }
          }
        }
        return;
      }

      // Result event — turn is complete
      if (event.type === "result") {
        if (typeof event.session_id === "string") {
          this.sessionId = event.session_id as string;
        }

        if (event.is_error || event.subtype === "error_during_execution") {
          const errors = event.errors as string[] | undefined;
          const errorMsg = errors?.join("; ") ?? String(event.result ?? "unknown error");
          this.opts.logger.error(`claude-process: turn error: ${errorMsg}`);
        }

        this.opts.logger.info(
          `claude-process: turn complete sid=${this.sessionId.slice(0, 12)} ` +
          `proseLen=${this.turnProseText.length} fullLen=${this.turnFullText.length}`,
        );

        if (this.turnResolve) {
          const resolve = this.turnResolve;
          this.turnResolve = null;
          this.turnReject = null;
          this.turnOnText = null;
          resolve({
            text: this.turnProseText,
            fullText: this.turnFullText,
            sessionId: this.sessionId,
          });
        }
        return;
      }
    } catch {
      // Skip unparseable lines
    }
  }

  /** Kill the process and respawn. */
  async restart(): Promise<void> {
    this.opts.logger.info("claude-process: restarting...");
    await this.stop();
    this.start();
  }

  /** Kill the process. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve();
        return;
      }

      const child = this.child;
      this.child = null;
      this.alive = false;
      this.sessionId = "";

      // Reject any in-flight turn
      if (this.turnReject) {
        this.turnReject(new Error("Claude process stopped"));
        this.turnResolve = null;
        this.turnReject = null;
      }

      child.on("close", () => resolve());
      child.kill("SIGTERM");

      // Force kill after 5s
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 5000).unref();
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
