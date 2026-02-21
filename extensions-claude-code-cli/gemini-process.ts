import { spawn, execSync, type ChildProcess } from "node:child_process";
import readline from "node:readline";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type GeminiProcessOptions = {
  geminiPath?: string;
  cwd?: string;
  model?: string;
  sessionId?: string;
  logger: Logger;
};

export type SendMessageResult = {
  text: string;
  sessionId: string;
};

// --- Gemini stream-json event types ---

type GeminiEvent =
  | { type: "init"; session_id: string; model?: string }
  | { type: "message"; role: string; content: string; delta?: boolean }
  | { type: "tool_use"; tool_name: string; [k: string]: unknown }
  | { type: "tool_result"; tool_id: string; [k: string]: unknown }
  | { type: "error"; severity: string; message: string }
  | { type: "result"; status: string; stats?: GeminiStats; error?: { message: string } };

type GeminiStats = {
  input_tokens: number;
  output_tokens: number;
  cached?: number;
  duration_ms?: number;
};

const DEFAULT_GEMINI_PATH = "gemini";

function resolveGeminiBinary(configPath?: string): string {
  if (configPath) return configPath;
  try {
    return execSync("which gemini", { encoding: "utf-8" }).trim();
  } catch {
    throw new Error("Gemini binary not found. Install Gemini CLI or set geminiPath in config.");
  }
}

/**
 * Ephemeral Gemini CLI wrapper.
 *
 * Each `sendMessage()` spawns a fresh `gemini -p` process.
 * Session IDs are tracked for resume across turns.
 * Exposes the same public interface as ClaudeProcess / CodexProcess.
 */
export class GeminiProcess {
  private opts: GeminiProcessOptions;
  private geminiPath: string;
  private sid: string | null;
  private currentChild: ChildProcess | null = null;
  private stopped = false;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  private turnResolve: ((result: SendMessageResult) => void) | null = null;
  private turnReject: ((err: Error) => void) | null = null;

  constructor(opts: GeminiProcessOptions) {
    this.opts = opts;
    this.geminiPath = resolveGeminiBinary(opts.geminiPath);
    this.sid = opts.sessionId ?? null;
  }

  start(): void {}

  async sendMessage(
    text: string,
    onText?: (text: string) => void,
  ): Promise<SendMessageResult> {
    if (this.stopped) {
      return Promise.reject(new Error("GeminiProcess has been stopped"));
    }
    if (this.currentChild) {
      return Promise.reject(new Error("Another message is already in-flight"));
    }

    return this.runTurn(text, onText, false);
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
    return this.sid ?? "";
  }

  getTotalCost(): number {
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
    const isResume = !isRetry && !!this.sid;

    const args = isResume
      ? this.buildResumeArgs(this.sid!, prompt)
      : this.buildExecArgs(prompt);

    log.info(
      `gemini-process: ${isResume ? "resume" : "exec"} ` +
      `sid=${this.sid?.slice(0, 12) ?? "none"} prompt=${prompt.length}chars`,
    );

    const stderrChunks: string[] = [];
    const child = spawn(this.geminiPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd,
    });
    child.stdin?.end();

    this.currentChild = child;

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        stderrChunks.push(text);
        log.warn(`gemini-process: [stderr] ${text.slice(0, 200)}`);
      }
    });

    try {
      const turnResult = await this.processEvents(child, onText);

      const exitResult = await waitForExit(child);
      this.currentChild = null;

      const noOutput = !turnResult.finalResponse.trim();

      if (isResume && noOutput && !isRetry) {
        log.warn("gemini-process: resume produced no output, retrying as new exec");
        this.sid = null;
        return this.runTurn(prompt, onText, true);
      }

      if (turnResult.error) {
        throw new Error(turnResult.error);
      }

      if (exitResult.code !== 0 && exitResult.code !== null && noOutput) {
        const stderr = stderrChunks.join("\n").slice(0, 500);
        throw new Error(`Gemini failed (exit ${exitResult.code}):\n${stderr || "no output"}`);
      }

      if (turnResult.usage) {
        this.totalInputTokens += turnResult.usage.inputTokens;
        this.totalOutputTokens += turnResult.usage.outputTokens;
      }

      log.info(
        `gemini-process: turn complete sid=${this.sid?.slice(0, 12) ?? "none"} ` +
        `textLen=${turnResult.finalResponse.length}`,
      );

      return {
        text: turnResult.finalResponse || "Done.",
        sessionId: this.sid ?? "",
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
    usage: { inputTokens: number; outputTokens: number } | null;
    error: string | null;
  }> {
    let finalResponse = "";
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let error: string | null = null;

    if (!child.stdout) {
      return { finalResponse, usage, error };
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: GeminiEvent;
      try {
        event = JSON.parse(line) as GeminiEvent;
      } catch {
        continue;
      }

      switch (event.type) {
        case "init":
          this.sid = event.session_id;
          break;

        case "message":
          if (event.role === "assistant") {
            if (event.delta) {
              onText?.(event.content);
              finalResponse += event.content;
            } else {
              const delta = event.content.slice(finalResponse.length);
              if (delta) onText?.(delta);
              finalResponse = event.content;
            }
          }
          break;

        case "result":
          if (event.status === "success") {
            if (event.stats) {
              usage = {
                inputTokens: event.stats.input_tokens,
                outputTokens: event.stats.output_tokens,
              };
            }
          } else {
            error = event.error?.message ?? "Unknown error";
          }
          break;

        case "error":
          if (event.severity === "error") {
            error = event.message;
          }
          break;

        default:
          break;
      }
    }

    return { finalResponse, usage, error };
  }

  private buildExecArgs(prompt: string): string[] {
    const args = ["-p", prompt, "--output-format", "stream-json", "--yolo"];
    if (this.opts.model) args.push("--model", this.opts.model);
    return args;
  }

  private buildResumeArgs(sessionId: string, prompt: string): string[] {
    const args = ["-p", prompt, "--output-format", "stream-json", "--yolo", "--resume", sessionId];
    if (this.opts.model) args.push("--model", this.opts.model);
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
