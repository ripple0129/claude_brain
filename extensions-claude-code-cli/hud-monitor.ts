import * as pty from "node-pty";
import { execSync } from "node:child_process";
import { statSync } from "node:fs";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type HudMonitorOptions = {
  claudePath?: string;
  /** Minimum interval between pings (debounce). Default: 60s */
  debounceMs?: number;
  logger: Logger;
};

const DEFAULT_DEBOUNCE_MS = 60_000;
const STATUS_FILE = "/tmp/claude-status.json";

/**
 * Spawns an interactive Claude session (haiku) in a PTY and sends a short
 * prompt to trigger an API call when notified, keeping /tmp/claude-status.json
 * up to date with rate limit data.
 *
 * `notify()` returns a Promise that resolves once the status file is updated.
 */
export class HudMonitor {
  private ptyProcess: pty.IPty | null = null;
  private opts: HudMonitorOptions;
  private started = false;
  private ready = false;
  private debounceMs: number;
  private lastPingAt = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending resolve callbacks waiting for status file update. */
  private waiters: Array<() => void> = [];

  constructor(opts: HudMonitorOptions) {
    this.opts = opts;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const log = this.opts.logger;
    let claudePath = this.opts.claudePath ?? "claude";
    // Resolve full path if needed (node-pty doesn't search PATH like shell does)
    if (!claudePath.includes("/")) {
      try {
        claudePath = execSync(`which ${claudePath}`, { encoding: "utf-8" }).trim();
      } catch { /* keep as-is */ }
    }
    log.info(`hud-monitor: resolved claudePath=${claudePath}`);

    try {
      this.ptyProcess = pty.spawn("/bin/bash", ["-l", "-c", `${claudePath} --model claude-haiku-4-5-20251001`], {
        name: "xterm-256color",
        cols: 120,
        rows: 24,
        env: { ...process.env, TERM: "xterm-256color" },
      });

      log.info(`hud-monitor: started (pid ${this.ptyProcess.pid}, debounce ${this.debounceMs}ms)`);

      this.ptyProcess.onExit(({ exitCode }) => {
        log.info(`hud-monitor: claude exited (code ${exitCode})`);
        this.cleanup();
      });

      // Discard output (statusLine script handles writing to file)
      this.ptyProcess.onData(() => {});

      // Send initial prompt to populate rate limit cache
      setTimeout(() => {
        if (!this.ptyProcess) return;
        this.ptyProcess.write("hi\r");
      }, 10000);

      // Mark ready after first API call likely completes
      setTimeout(() => {
        this.ready = true;
        log.info("hud-monitor: ready for notifications");
      }, 25000);
    } catch (err) {
      log.error(`hud-monitor: failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.started = false;
    }
  }

  /**
   * Call this when any session completes a turn.
   * Returns a Promise that resolves once the status file is updated.
   */
  notify(): Promise<void> {
    if (!this.ready || !this.ptyProcess) return Promise.resolve();

    const now = Date.now();
    const elapsed = now - this.lastPingAt;

    if (elapsed >= this.debounceMs) {
      return this.sendPing();
    } else if (!this.pendingTimer) {
      const delay = this.debounceMs - elapsed;
      return new Promise<void>((resolve) => {
        this.pendingTimer = setTimeout(() => {
          this.pendingTimer = null;
          this.sendPing().then(resolve);
        }, delay);
      });
    }
    // A pending ping is already scheduled — wait for it
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  stop(): void {
    this.cleanup();
  }

  private sendPing(): Promise<void> {
    if (!this.ptyProcess) return Promise.resolve();
    this.lastPingAt = Date.now();

    // Snapshot mtime before ping
    const mtimeBefore = this.getStatusMtime();

    try {
      this.ptyProcess.write("hi\r");
      this.opts.logger.info("hud-monitor: ping sent");
    } catch {
      this.opts.logger.warn("hud-monitor: failed to send ping");
      this.flushWaiters();
      return Promise.resolve();
    }

    // Poll for status file update (max ~15s)
    return new Promise<void>((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        const mtimeNow = this.getStatusMtime();
        if (mtimeNow > mtimeBefore) {
          this.flushWaiters();
          resolve();
          return;
        }
        if (attempts >= 30) {
          this.opts.logger.warn("hud-monitor: status file not updated after ping, giving up");
          this.flushWaiters();
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      setTimeout(check, 500);
    });
  }

  private getStatusMtime(): number {
    try {
      return statSync(STATUS_FILE).mtimeMs;
    } catch {
      return 0;
    }
  }

  private flushWaiters(): void {
    const w = this.waiters.splice(0);
    for (const resolve of w) resolve();
  }

  private cleanup(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch { /* already dead */ }
      this.ptyProcess = null;
    }
    this.flushWaiters();
    this.started = false;
    this.ready = false;
  }
}
