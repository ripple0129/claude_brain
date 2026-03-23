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
  label?: string;
};

export type TurnUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

export type ToolActivity = {
  name: string;
  id: string;
};

export type RateLimitInfo = {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  /** 0-1 utilization from Anthropic API headers (may be absent at low usage) */
  utilization?: number;
};

export type WindowUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
  resetsAt: number;
};

export type ContextUsage = {
  /** Total input tokens in the last API call (≈ current context size) */
  contextTokens: number;
  /** Context window limit for the model */
  contextWindow?: number;
  /** Max output tokens for the model */
  maxOutputTokens?: number;
};

export type SendMessageResult = {
  text: string;
  sessionId: string;
  usage?: TurnUsage;
  toolsUsed?: ToolActivity[];
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  rateLimit?: RateLimitInfo;
  context?: ContextUsage;
};

const DEFAULT_CLAUDE_PATH = "claude";
const TURN_TIMEOUT_MS = 60 * 60 * 1000;

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

  // Latest snapshot (persisted across turns for /usage)
  // Keyed by rateLimitType (e.g. "five_hour", "seven_day")
  private rateLimits = new Map<string, RateLimitInfo>();
  private lastContext: ContextUsage | undefined;

  // 5H window usage tracking
  private windowResetsAt = 0;
  private windowInputTokens = 0;
  private windowOutputTokens = 0;
  private windowCostUsd = 0;
  private windowTurns = 0;

  // Per-turn state
  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;
  private turnProseText = "";
  private turnOnText: ((text: string) => void) | null = null;
  private turnTimeout: ReturnType<typeof setTimeout> | null = null;
  private turnUsage: TurnUsage = { input_tokens: 0, output_tokens: 0 };
  private turnToolsUsed: ToolActivity[] = [];
  private seenToolIds = new Set<string>();
  private turnCostUsd: number | undefined;
  private turnNumTurns: number | undefined;
  private turnDurationMs: number | undefined;
  private turnRateLimits = new Map<string, RateLimitInfo>();
  private turnContextTokens = 0;
  private turnContextWindow: number | undefined;
  private turnMaxOutputTokens: number | undefined;

  private tag: string;

  constructor(opts: ClaudeProcessOptions) {
    this.opts = opts;
    this.tag = opts.label ? `claude[${opts.label}]` : "claude-process";
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

    log.info(`${this.tag}: spawning args=${argv.filter(a => a !== "").join(" ")}`);

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
          log.warn(`${this.tag}: [stderr] ${line.trim()}`);
          this.stderrBuf.push(line.trim());
          if (this.stderrBuf.length > 20) this.stderrBuf.shift();
        }
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      log.error(`${this.tag}: spawn error: ${err.message}`);
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
      log.warn(`${this.tag}: process exited code=${code} signal=${signal}`);
      if (stderrTail) {
        log.error(`${this.tag}: stderr output:\n${stderrTail}`);
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
    this.turnUsage = { input_tokens: 0, output_tokens: 0 };
    this.turnToolsUsed = [];
    this.seenToolIds.clear();
    this.turnCostUsd = undefined;
    this.turnNumTurns = undefined;
    this.turnDurationMs = undefined;
    this.turnRateLimits.clear();
    this.turnContextTokens = 0;
    this.turnContextWindow = undefined;
    this.turnMaxOutputTokens = undefined;

    return new Promise<SendMessageResult>((resolve, reject) => {
      this.turnResolve = resolve;
      this.turnReject = reject;

      this.turnTimeout = setTimeout(() => {
        log.error(
          `${this.tag}: turn timeout after ${TURN_TIMEOUT_MS / 1000}s ` +
          `proseLen=${this.turnProseText.length}`,
        );
        this.completeTurn();
      }, TURN_TIMEOUT_MS);

      const msg = JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
      });

      log.info(`${this.tag}: sending message (${text.length} chars)`);

      this.child!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          log.error(`${this.tag}: stdin write error: ${err.message}`);
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
    // Persist snapshots for /usage queries
    for (const [type, rl] of this.turnRateLimits) {
      this.rateLimits.set(type, { ...rl });
      // Track 5H window accumulator
      if (type === "five_hour") {
        const newResetsAt = rl.resetsAt ?? 0;
        if (newResetsAt !== this.windowResetsAt) {
          this.windowResetsAt = newResetsAt;
          this.windowInputTokens = 0;
          this.windowOutputTokens = 0;
          this.windowCostUsd = 0;
          this.windowTurns = 0;
        }
      }
    }
    // Accumulate window usage
    this.windowInputTokens += this.turnUsage.input_tokens + (this.turnUsage.cache_read_input_tokens ?? 0) + (this.turnUsage.cache_creation_input_tokens ?? 0);
    this.windowOutputTokens += this.turnUsage.output_tokens;
    if (this.turnCostUsd !== undefined) this.windowCostUsd += this.turnCostUsd;
    this.windowTurns += this.turnNumTurns ?? 1;

    if (this.turnContextTokens > 0) {
      this.lastContext = {
        contextTokens: this.turnContextTokens,
        contextWindow: this.turnContextWindow,
        maxOutputTokens: this.turnMaxOutputTokens,
      };
    }
    if (this.turnResolve) {
      const resolve = this.turnResolve;
      this.turnResolve = null;
      this.turnReject = null;
      this.turnOnText = null;
      const hasUsage = this.turnUsage.input_tokens > 0 || this.turnUsage.output_tokens > 0;
      resolve({
        text: this.turnProseText,
        sessionId: this.sessionId,
        usage: hasUsage ? { ...this.turnUsage } : undefined,
        toolsUsed: this.turnToolsUsed.length > 0 ? [...this.turnToolsUsed] : undefined,
        costUsd: this.turnCostUsd,
        numTurns: this.turnNumTurns,
        durationMs: this.turnDurationMs,
        rateLimit: this.turnRateLimits.size > 0 ? { ...this.turnRateLimits.values().next().value } : undefined,
        context: this.turnContextTokens > 0 ? {
          contextTokens: this.turnContextTokens,
          contextWindow: this.turnContextWindow,
          maxOutputTokens: this.turnMaxOutputTokens,
        } : undefined,
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
      log.warn(`${this.tag}: unparseable line: ${line.slice(0, 200)}`);
      return;
    }

    const eventType = String(event.type ?? "unknown");

    if (eventType === "system" && event.subtype === "init") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
        log.info(`${this.tag}: session init sid=${this.sessionId.slice(0, 12)}`);
      }
      return;
    }

    if (eventType === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info) {
        const rlType = typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown";
        const rl: RateLimitInfo = {
          status: String(info.status ?? "unknown"),
          resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
          rateLimitType: rlType,
          overageStatus: typeof info.overageStatus === "string" ? info.overageStatus : undefined,
          overageResetsAt: typeof info.overageResetsAt === "number" ? info.overageResetsAt : undefined,
          isUsingOverage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
          utilization: typeof info.utilization === "number" ? info.utilization : undefined,
        };
        this.turnRateLimits.set(rlType, rl);
        if (rl.status !== "allowed") {
          log.warn(`${this.tag}: rate limit ${rlType} status=${rl.status} info=${JSON.stringify(info)}`);
        }
      }
      return;
    }

    // Streaming events — prose text + usage tracking
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

      // message_start carries input token counts
      if (inner?.type === "message_start") {
        const msgUsage = (inner.message as Record<string, unknown>)?.usage as Record<string, number> | undefined;
        if (msgUsage) {
          if (msgUsage.input_tokens) this.turnUsage.input_tokens += msgUsage.input_tokens;
          if (msgUsage.cache_read_input_tokens) {
            this.turnUsage.cache_read_input_tokens = (this.turnUsage.cache_read_input_tokens ?? 0) + msgUsage.cache_read_input_tokens;
          }
          if (msgUsage.cache_creation_input_tokens) {
            this.turnUsage.cache_creation_input_tokens = (this.turnUsage.cache_creation_input_tokens ?? 0) + msgUsage.cache_creation_input_tokens;
          }
          // Track latest input tokens as context size (last message_start = most recent context)
          const totalInput = (msgUsage.input_tokens ?? 0) + (msgUsage.cache_read_input_tokens ?? 0) + (msgUsage.cache_creation_input_tokens ?? 0);
          if (totalInput > 0) {
            this.turnContextTokens = totalInput;
          }
        }
      }

      // message_delta carries output token counts
      if (inner?.type === "message_delta") {
        const deltaUsage = (inner as Record<string, unknown>).usage as Record<string, number> | undefined;
        if (deltaUsage?.output_tokens) {
          this.turnUsage.output_tokens += deltaUsage.output_tokens;
        }
      }

      return;
    }

    // Extract tool activity from assistant messages, skip user messages
    if (eventType === "assistant") {
      const content = (event.message as Record<string, unknown>)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === "tool_use" && typeof block.id === "string" && !this.seenToolIds.has(block.id as string)) {
            this.seenToolIds.add(block.id as string);
            this.turnToolsUsed.push({ name: String(block.name), id: block.id as string });
          }
        }
      }
      return;
    }
    if (eventType === "user") {
      return;
    }

    // Result event — turn is complete
    if (eventType === "result") {
      if (typeof event.session_id === "string") {
        this.sessionId = event.session_id as string;
      }

      if (typeof event.total_cost_usd === "number") {
        this.totalCostUsd += event.total_cost_usd as number;
        this.turnCostUsd = event.total_cost_usd as number;
      }
      if (typeof event.num_turns === "number") {
        this.turnNumTurns = event.num_turns as number;
      }
      if (typeof event.duration_ms === "number") {
        this.turnDurationMs = event.duration_ms as number;
      }

      // Extract contextWindow/maxOutputTokens from modelUsage
      const modelUsage = event.modelUsage as Record<string, Record<string, unknown>> | undefined;
      if (modelUsage) {
        for (const info of Object.values(modelUsage)) {
          if (typeof info.contextWindow === "number") this.turnContextWindow = info.contextWindow;
          if (typeof info.maxOutputTokens === "number") this.turnMaxOutputTokens = info.maxOutputTokens;
        }
      }

      // Fallback: if stream events didn't provide usage, try result.usage
      const resultUsage = (event as Record<string, unknown>).usage as Record<string, number> | undefined;
      if (resultUsage && this.turnUsage.input_tokens === 0 && this.turnUsage.output_tokens === 0) {
        if (resultUsage.input_tokens) this.turnUsage.input_tokens = resultUsage.input_tokens;
        if (resultUsage.output_tokens) this.turnUsage.output_tokens = resultUsage.output_tokens;
        if (resultUsage.cache_read_input_tokens) this.turnUsage.cache_read_input_tokens = resultUsage.cache_read_input_tokens;
        if (resultUsage.cache_creation_input_tokens) this.turnUsage.cache_creation_input_tokens = resultUsage.cache_creation_input_tokens;
      }

      const costUsd = this.turnCostUsd !== undefined ? this.turnCostUsd.toFixed(4) : "?";
      const numTurns = this.turnNumTurns ?? "?";
      const durationMs = this.turnDurationMs ?? "?";

      if (event.is_error || event.subtype === "error_during_execution") {
        const errors = event.errors as string[] | undefined;
        const errorMsg = errors?.join("; ") ?? String(event.result ?? "unknown error");
        log.error(`${this.tag}: turn error: ${errorMsg}`);

        if (!this.turnProseText.trim()) {
          log.warn(`${this.tag}: error with no prose output, rejecting`);
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

      const usageStr = (this.turnUsage.input_tokens > 0 || this.turnUsage.output_tokens > 0)
        ? ` in=${this.turnUsage.input_tokens} out=${this.turnUsage.output_tokens}`
        : "";
      const toolStr = this.turnToolsUsed.length > 0
        ? ` tools=[${this.turnToolsUsed.map(t => t.name).join(",")}]`
        : "";

      log.info(
        `${this.tag}: turn complete sid=${this.sessionId.slice(0, 12)} ` +
        `proseLen=${this.turnProseText.length} ` +
        `turns=${numTurns} cost=$${costUsd} dur=${durationMs}ms` +
        usageStr + toolStr,
      );

      this.completeTurn();
      return;
    }

    log.warn(`${this.tag}: unhandled event type="${eventType}" subtype="${event.subtype ?? ""}"`);
  }

  async restart(): Promise<void> {
    this.opts.logger.info(`${this.tag}: restarting...`);
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

  getRateLimit(type?: string): RateLimitInfo | undefined {
    if (type) return this.rateLimits.get(type);
    // Default: return five_hour if exists, otherwise first
    return this.rateLimits.get("five_hour") ?? this.rateLimits.values().next().value;
  }

  getRateLimits(): Map<string, RateLimitInfo> {
    return this.rateLimits;
  }

  getContext(): ContextUsage | undefined {
    return this.lastContext;
  }

  getWindowUsage(): WindowUsage | undefined {
    if (this.windowResetsAt === 0 && this.windowTurns === 0) return undefined;
    return {
      inputTokens: this.windowInputTokens,
      outputTokens: this.windowOutputTokens,
      costUsd: this.windowCostUsd,
      turns: this.windowTurns,
      resetsAt: this.windowResetsAt,
    };
  }
}
