import { ClaudeProcess, type ClaudeProcessOptions } from "./claude-process.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export interface SessionEntry {
  process: ClaudeProcess;
  lastActivity: number;
  cwd: string;
  model?: string;
  lastSessionId?: string;
}

export interface CreateSessionOpts {
  cwd?: string;
  model?: string;
  resumeSessionId?: string;
  compact?: boolean;
}

export interface SessionStoreConfig {
  claudePath: string;
  mcpConfigPath?: string;
  defaultCwd: string;
  maxSessions: number;
  idleTimeoutMs: number;
}

/**
 * In-memory session store with idle eviction.
 * Manages per-conversationId ClaudeProcess instances.
 */
export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  /** Preserved session IDs from destroyed sessions (for /resume). */
  private deadSessionIds = new Map<string, { sessionId: string; cwd: string; model?: string }>();
  private config: SessionStoreConfig;
  private logger: Logger;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SessionStoreConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.startIdleSweep();
  }

  createSession(conversationId: string, opts?: CreateSessionOpts): SessionEntry {
    this.enforceMaxSessions();

    const cwd = opts?.cwd ?? this.config.defaultCwd;
    const model = opts?.model;

    const processOpts: ClaudeProcessOptions = {
      claudePath: this.config.claudePath,
      mcpConfigPath: this.config.mcpConfigPath,
      cwd,
      model,
      resumeSessionId: opts?.resumeSessionId,
      compact: opts?.compact,
      logger: this.logger,
    };

    const proc = new ClaudeProcess(processOpts);
    proc.start();

    const entry: SessionEntry = {
      process: proc,
      lastActivity: Date.now(),
      cwd,
      model,
    };

    this.sessions.set(conversationId, entry);
    this.logger.info(`session-store: created session for ${conversationId} cwd=${cwd} model=${model ?? "default"}`);
    return entry;
  }

  async destroySession(conversationId: string): Promise<void> {
    const entry = this.sessions.get(conversationId);
    if (!entry) return;

    const sid = entry.process.getSessionId();
    if (sid) {
      this.deadSessionIds.set(sid, { sessionId: sid, cwd: entry.cwd, model: entry.model });
    }

    await entry.process.stop();
    this.sessions.delete(conversationId);
    this.logger.info(`session-store: destroyed session for ${conversationId}`);
  }

  getSession(conversationId: string): SessionEntry | undefined {
    return this.sessions.get(conversationId);
  }

  getLastSessionId(conversationId: string): string | undefined {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      return entry.process.getSessionId() || entry.lastSessionId;
    }
    return undefined;
  }

  getDeadSession(sessionId: string): { sessionId: string; cwd: string; model?: string } | undefined {
    return this.deadSessionIds.get(sessionId);
  }

  async resumeSession(conversationId: string, sessionId?: string): Promise<SessionEntry | null> {
    const sid = sessionId ?? this.getLastSessionId(conversationId);
    if (!sid) return null;

    const dead = this.deadSessionIds.get(sid);
    const existing = this.sessions.get(conversationId);
    const cwd = dead?.cwd ?? existing?.cwd ?? this.config.defaultCwd;
    const model = dead?.model ?? existing?.model;

    await this.destroySession(conversationId);
    return this.createSession(conversationId, {
      cwd,
      model,
      resumeSessionId: sid,
    });
  }

  listSessions(): Array<{
    conversationId: string;
    sessionId: string;
    alive: boolean;
    cwd: string;
    model?: string;
    lastActivity: number;
    cost: number;
  }> {
    const result: Array<{
      conversationId: string;
      sessionId: string;
      alive: boolean;
      cwd: string;
      model?: string;
      lastActivity: number;
      cost: number;
    }> = [];

    for (const [convId, entry] of this.sessions) {
      const sid = entry.process.getSessionId();
      if (sid) {
        result.push({
          conversationId: convId,
          sessionId: sid,
          alive: entry.process.isAlive(),
          cwd: entry.cwd,
          model: entry.model,
          lastActivity: entry.lastActivity,
          cost: entry.process.getTotalCost(),
        });
      }
    }

    const activeSids = new Set(result.map((r) => r.sessionId));
    for (const [sid, info] of this.deadSessionIds) {
      if (!activeSids.has(sid)) {
        result.push({
          conversationId: "",
          sessionId: sid,
          alive: false,
          cwd: info.cwd,
          model: info.model,
          lastActivity: 0,
          cost: 0,
        });
      }
    }

    return result;
  }

  private enforceMaxSessions(): void {
    if (this.sessions.size < this.config.maxSessions) return;

    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.sessions) {
      if (!entry.process.isBusy() && entry.lastActivity < oldestTime) {
        oldestTime = entry.lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.logger.info(`session-store: evicting idle session ${oldestKey} to make room`);
      const entry = this.sessions.get(oldestKey)!;
      const sid = entry.process.getSessionId();
      if (sid) {
        this.deadSessionIds.set(sid, { sessionId: sid, cwd: entry.cwd, model: entry.model });
      }
      entry.process.stop().catch(() => {});
      this.sessions.delete(oldestKey);
    }
  }

  private startIdleSweep(): void {
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.sessions) {
        if (!entry.process.isBusy() && now - entry.lastActivity > this.config.idleTimeoutMs) {
          this.logger.info(`session-store: idle timeout for ${key}`);
          const sid = entry.process.getSessionId();
          if (sid) {
            this.deadSessionIds.set(sid, { sessionId: sid, cwd: entry.cwd, model: entry.model });
          }
          entry.process.stop().catch(() => {});
          this.sessions.delete(key);
        }
      }
    }, 60_000);
    this.idleTimer.unref();
  }

  async stopAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const stops = Array.from(this.sessions.values()).map((e) => e.process.stop());
    await Promise.allSettled(stops);
    this.sessions.clear();
    this.logger.info("session-store: all sessions stopped");
  }
}
