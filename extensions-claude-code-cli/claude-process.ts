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
  cwd?: string;
  model?: string;
  resumeSessionId?: string;
  compact?: boolean;
  env?: Record<string, string>;
  logger: Logger;
};

export type SendMessageResult = {
  text: string;
  sessionId: string;
};

const DEFAULT_CLAUDE_PATH = "claude";
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Persistent Claude Code CLI process using the bidirectional stream-json protocol.
 *
 * Keeps a single long-running `claude` process and sends/receives
 * newline-delimited JSON on stdin/stdout. Only prose text is tracked.
 */
export class ClaudeProcess {
  private child: ChildProcess | null = null;
  private opts: ClaudeProcessOptions;
  private lineBuf = "";
  private sessionId = "";
  private alive = false;
  private totalCostUsd = 0;
  private stderrBuf: string[] = [];

  // Per-turn state
  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;
  private turnProseText = "";
  private turnOnText: ((text: string) => void) | null = null;
  private turnTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ClaudeProcessOptions) {
    this.opts = opts;
  }

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

    if (this.opts.model) {
      argv.push("--model", this.opts.model);
    }

    if (this.opts.mcpConfigPath) {
      argv.push("--mcp-config", this.opts.mcpConfigPath);
    }

    if (this.opts.systemPrompt) {
      argv.push("--append-system-prompt", this.opts.systemPrompt);
    }

    if (this.opts.resumeSessionId) {
      argv.push("--resume", this.opts.resumeSessionId);
    }

    if (this.opts.compact) {
      argv.push("--compact");
    }

    const env = { ...process.env, ...this.opts.env };
    delete env.CLAUDECODE;
    env.CI = "true";
    // Strip node_modules/.bin from PATH to avoid picking up local
    // @anthropic-ai/claude-code binary which may be an incompatible version
    if (env.PATH) {
      env.PATH = env.PATH.split(":").filter((p) => !p.includes("node_modules/.bin")).join(":");
    }

    log.info(`claude-process: spawning args=${argv.filter(a => a !== "").join(" ")}`);

    const child = spawn(claudePath, argv, {
      env,
      cwd: this.opts.cwd,
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

    this.stderrBuf = [];
    child.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) {
          log.warn(`claude-process: [stderr] ${line.trim()}`);
          this.stderrBuf.push(line.trim());
          if (this.stderrBuf.length > 20) this.stderrBuf.shift();
        }
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      log.error(`claude-process: spawn error: ${err.message}`);
      this.alive = false;
      this.child = null;
      this.clearTurnTimeout();
      if (this.turnReject) {
        this.turnReject(new Error(`Claude process error: ${err.message}`));
        this.turnResolve = null;
        this.turnReject = null;
      }
    });

    child.on("close", (code, signal) => {
      const stderrTail = this.stderrBuf.join("\n");
      log.warn(`claude-process: process exited code=${code} signal=${signal}`);
      if (stderrTail) {
        log.error(`claude-process: stderr output:\n${stderrTail}`);
      }
      this.alive = false;
      this.child = null;
      this.clearTurnTimeout();
      if (this.turnReject) {
        const errDetail = stderrTail ? `\nstderr: ${stderrTail}` : "";
        this.turnReject(new Error(`Claude process exited unexpectedly (code ${code})${errDetail}`));
        this.turnResolve = null;
        this.turnReject = null;
      }
    });
  }

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

    this.turnProseText = "";
    this.turnOnText = onText ?? null;

    return new Promise<SendMessageResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;

      this.turnTimeout = setTimeout(() => {
        log.error(
          `claude-process: turn timeout after ${TURN_TIMEOUT_MS / 1000}s ` +
          `proseLen=${this.turnProseText.length}`,
        );
        this.completeTurn();
      }, TURN_TIMEOUT_MS);

      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      });

      log.info(`claude-process: sending message (${text.length} chars)`);

      this.child!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          log.error(`claude-process: stdin write error: ${err.message}`);
          this.clearTurnTimeout();
          this.turnResolve = null;
          this.turnReject = null;
          reject(new Error(`Failed to write to Claude stdin: ${err.message}`));
        }
      });
    });
  }

  /** Check if a turn is currently in progress. */
  isBusy(): boolean {
    return this.turnResolve !== null;
  }

  /** Abort the current in-flight turn without killing the process. */
  abortTurn(): void {
    if (!this.turnReject) return;
    this.clearTurnTimeout();
    const reject = this.turnReject;
    this.turnResolve = null;
    this.turnReject = null;
    this.turnOnText = null;
    reject(new Error("Turn aborted by user"));
  }

  private clearTurnTimeout(): void {
    if (this.turnTimeout) {
      clearTimeout(this.turnTimeout);
      this.turnTimeout = null;
    }
  }

  private completeTurn(): void {
    this.clearTurnTimeout();
    if (this.turnResolve) {
      const resolve = this.turnResolve;
      this.turnResolve = null;
      this.turnReject = null;
      this.turnOnText = null;
      resolve({
        text: this.turnProseText,
        sessionId: this.sessionId,
      });
    }
  }

  private processLine(line: string): void {
    if (!line.trim()) return;

    const log = this.opts.logger;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log.warn(`claude-process: unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    const eventType = String(event.type ?? "unknown");

    if (eventType === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
        log.info(`claude-process: session init sid=${this.sessionId.slice(0, 12)}`);
      }
      return;
    }

    if (eventType === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      const status = String(info?.status ?? "unknown");
      if (status !== "allowed") {
        log.warn(`claude-process: rate limit status=${status} info=${JSON.stringify(info)}`);
      }
      return;
    }

    // Streaming text delta — Claude's prose (only thing we send to chat)
    if (eventType === "stream_event") {
      const inner = event.event as Record<string, unknown> | undefined;
      if (inner?.type === "content_block_delta") {
        const delta = inner.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          const text = delta.text as string;
          this.turnProseText += text;
          this.turnOnText?.(text);
        }
      }
      return;
    }

    // Silently skip tool calls and tool results (prose-only strategy)
    if (eventType === "assistant" || eventType === "user") {
      return;
    }

    // Result event — turn is complete
    if (eventType === "result") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
      }

      if (typeof event.total_cost_usd === "number") {
        this.totalCostUsd += event.total_cost_usd as number;
      }

      const costUsd = typeof event.total_cost_usd === "number"
        ? (event.total_cost_usd as number).toFixed(4)
        : "?";
      const numTurns = event.num_turns ?? "?";
      const durationMs = event.duration_ms ?? "?";

      if (event.is_error || event.subtype === "error_during_execution") {
        const errors = event.errors as string[] | undefined;
        const errorMsg = errors?.join("; ") ?? String(event.result ?? "unknown error");
        log.error(`claude-process: turn error: ${errorMsg}`);

        if (!this.turnProseText.trim()) {
          log.warn("claude-process: error with no prose output, rejecting");
          this.clearTurnTimeout();
          if (this.turnReject) {
            const reject = this.turnReject;
            this.turnResolve = null;
            this.turnReject = null;
            this.turnOnText = null;
            reject(new Error(`Claude turn error: ${errorMsg}`));
          }
          return;
        }
      }

      log.info(
        `claude-process: turn complete sid=${this.sessionId.slice(0, 12)} ` +
        `proseLen=${this.turnProseText.length} ` +
        `turns=${numTurns} cost=$${costUsd} dur=${durationMs}ms`,
      );

      this.completeTurn();
      return;
    }

    log.warn(`claude-process: unhandled event type="${eventType}" subtype="${event.subtype ?? ""}"`);
  }

  async restart(): Promise<void> {
    this.opts.logger.info("claude-process: restarting...");
    await this.stop();
    this.start();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.child) {
        resolve();
        return;
      }

      const child = this.child;
      this.child = null;
      this.alive = false;

      this.clearTurnTimeout();
      if (this.turnReject) {
        this.turnReject(new Error("Claude process stopped"));
        this.turnResolve = null;
        this.turnReject = null;
      }

      child.on("close", () => resolve());
      child.kill("SIGTERM");

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

  getTotalCost(): number {
    return this.totalCostUsd;
  }

  getCwd(): string | undefined {
    return this.opts.cwd;
  }

  getModel(): string | undefined {
    return this.opts.model;
  }
}
