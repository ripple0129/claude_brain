import { spawn, execSync, type ChildProcess } from "node:child_process";
import readline from "node:readline";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type CodexProcessOptions = {
  codexPath?: string;
  cwd?: string;
  model?: string;
  threadId?: string;
  logger: Logger;
};

export type SendMessageResult = {
  text: string;
  sessionId: string;
};

// --- Codex JSONL event types ---

type ThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: TokenUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "item.started"; item: ThreadItem }
  | { type: "item.updated"; item: ThreadItem }
  | { type: "item.completed"; item: ThreadItem }
  | { type: "error"; message: string };

type ThreadItem = { id: string; type: string; text?: string; [k: string]: unknown };

type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
};

const DEFAULT_CODEX_PATH = "codex";

function resolveCodexBinary(configPath?: string): string {
  if (configPath) return configPath;
  try {
    return execSync("which codex", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Codex binary not found. Install Codex CLI or set codexPath in config.");
  }
}

/**
 * Ephemeral Codex CLI wrapper.
 *
 * Each `sendMessage()` spawns a fresh `codex exec` process.
 * Thread IDs are tracked for resume across turns.
 * Exposes the same public interface as ClaudeProcess (duck typing).
 */
export class CodexProcess {
  private opts: CodexProcessOptions;
  private codexPath: string;
  private threadId: string | null;
  private currentChild: ChildProcess | null = null;
  private stopped = false;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  // Per-turn state
  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;

  constructor(opts: CodexProcessOptions) {
    this.opts = opts;
    this.codexPath = resolveCodexBinary(opts.codexPath);
    this.threadId = opts.threadId ?? null;
  }

  /** No-op for ephemeral processes — always ready to spawn. */
  start(): void {}

  async sendMessage(
    text: string,
    onText?: (text: string) => void,
  ): Promise<SendMessageResult> {
    if (this.stopped) {
      return Promise.reject(new Error("CodexProcess has been stopped"));
    }
    if (this.turnResolve) {
      return Promise.reject(new Error("Another message is already in-flight"));
    }

    const log = this.opts.logger;
    const result = await this.runTurn(text, onText, false);
    return result;
  }

  isAlive(): boolean {
    return !this.stopped;
  }

  isBusy(): boolean {
    return this.currentChild !== null;
  }

  abortTurn(): void {
    if (this.currentChild && !this.currentChild.killed && this.currentChild.pid) {
      this.currentChild.kill("SIGINT");
    }
    if (this.turnReject) {
      const reject = this.turnReject;
      this.turnResolve = null;
      this.turnReject = null;
      reject(new Error("Turn aborted by user"));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.currentChild && !this.currentChild.killed) {
      this.currentChild.kill("SIGTERM");
    }
    this.abortTurn();
  }

  async restart(): Promise<void> {
    this.stopped = false;
  }

  getSessionId(): string {
    return this.threadId ?? "";
  }

  getTotalCost(): number {
    // Codex doesn't report cost in USD; return 0
    return 0;
  }

  getCwd(): string | undefined {
    return this.opts.cwd;
  }

  getModel(): string | undefined {
    return this.opts.model;
  }

  // --- Internal ---

  private async runTurn(
    prompt: string,
    onText: ((text: string) => void) | undefined,
    isRetry: boolean,
  ): Promise<SendMessageResult> {
    const log = this.opts.logger;
    const isResume = !isRetry && !!this.threadId;

    const args = isResume
      ? this.buildResumeArgs(this.threadId!, prompt)
      : this.buildExecArgs(prompt);

    log.info(
      `codex-process: ${isResume ? "resume" : "exec"} ` +
      `threadId=${this.threadId?.slice(0, 12) ?? "none"} prompt=${prompt.length}chars`,
    );

    const stderrChunks: string[] = [];
    const child = spawn(this.codexPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
    });
    child.stdin?.end();

    this.currentChild = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        stderrChunks.push(text);
        log.warn(`codex-process: [stderr] ${text.slice(0, 200)}`);
      }
    });

    try {
      const turnResult = await this.processEvents(child, onText);

      const exitResult = await waitForExit(child);
      this.currentChild = null;

      const noOutput = !turnResult.finalResponse.trim();

      // Resume produced no output → auto-retry as fresh exec
      if (isResume && noOutput && !isRetry) {
        log.warn("codex-process: resume produced no output, retrying as new exec");
        this.threadId = null;
        return this.runTurn(prompt, onText, true);
      }

      if (turnResult.error) {
        throw new Error(turnResult.error);
      }

      if (exitResult.code !== 0 && exitResult.code !== null && noOutput) {
        const stderr = stderrChunks.join("\n").slice(0, 500);
        throw new Error(`Codex failed (exit ${exitResult.code}):\n${stderr || "no output"}`);
      }

      if (turnResult.usage) {
        this.totalInputTokens += turnResult.usage.input_tokens;
        this.totalOutputTokens += turnResult.usage.output_tokens;
      }

      log.info(
        `codex-process: turn complete threadId=${this.threadId?.slice(0, 12) ?? "none"} ` +
        `textLen=${turnResult.finalResponse.length}`,
      );

      return {
        text: turnResult.finalResponse || "Done.",
        sessionId: this.threadId ?? "",
      };
    } catch (err) {
      this.currentChild = null;
      throw err;
    }
  }

  private async processEvents(
    child: ChildProcess,
    onText: ((text: string) => void) | undefined,
  ): Promise<{
    finalResponse: string;
    usage: TokenUsage | null;
    error: string | null;
  }> {
    let finalResponse = "";
    let usage: TokenUsage | null = null;
    let error: string | null = null;
    let lastSentLength = 0;

    if (!child.stdout) {
      return { finalResponse, usage, error };
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: ThreadEvent;
      try {
        event = JSON.parse(line) as ThreadEvent;
      } catch {
        continue; // skip malformed lines
      }

      switch (event.type) {
        case "thread.started":
          this.threadId = event.thread_id;
          break;

        case "item.started":
        case "item.updated":
          if (event.item.type === "agent_message" && event.item.text) {
            const delta = event.item.text.slice(lastSentLength);
            if (delta) {
              onText?.(delta);
              lastSentLength = event.item.text.length;
            }
          }
          break;

        case "item.completed":
          if (event.item.type === "agent_message" && event.item.text) {
            const delta = event.item.text.slice(lastSentLength);
            if (delta) onText?.(delta);
            finalResponse = event.item.text;
            lastSentLength = 0;
          }
          break;

        case "turn.completed":
          usage = event.usage;
          break;

        case "turn.failed":
          error = event.error.message;
          break;

        case "error":
          error = event.message;
          break;

        default:
          break;
      }
    }

    return { finalResponse, usage, error };
  }

  private buildExecArgs(prompt: string): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", "--full-auto"];
    if (this.opts.cwd) args.push("--cd", this.opts.cwd);
    if (this.opts.model) args.push("--model", this.opts.model);
    args.push(prompt);
    return args;
  }

  private buildResumeArgs(threadId: string, prompt: string): string[] {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check", "--full-auto"];
    if (this.opts.model) args.push("--model", this.opts.model);
    args.push(threadId, prompt);
    return args;
  }
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: null });
      return;
    }
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
