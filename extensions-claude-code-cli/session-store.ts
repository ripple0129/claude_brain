import { ClaudeProcess, type ClaudeProcessOptions } from "./claude-process.js";
import { CodexProcess, type CodexProcessOptions } from "./codex-process.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type CliProcess = ClaudeProcess | CodexProcess;
export type Backend = "claude" | "codex";

export interface SessionEntry {
  process: CliProcess;
  backend: Backend;
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
  codexPath: string;
  codexModels: Set<string>;
  mcpConfigPath?: string;
  defaultCwd: string;
  maxSessions: number;
  idleTimeoutMs: number;
}

interface PersistedSession {
  sessionId: string;
  backend: Backend;
  model: string;
  cwd: string;
  updatedAt: string;
}

const PERSIST_DEBOUNCE_MS = 500;

/**
 * In-memory session store with idle eviction, model-based backend routing,
 * and disk persistence for session/thread IDs.
 */
export class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  /** Preserved session IDs from destroyed sessions (for /resume). */
  private deadSessionIds = new Map<string, { sessionId: string; cwd: string; model?: string; backend: Backend }>();
  private config: SessionStoreConfig;
  private logger: Logger;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  // Persistence
  private stateDir: string;
  private persisted = new Map<string, PersistedSession>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SessionStoreConfig, logger: Logger, stateDir?: string) {
    this.config = config;
    this.logger = logger;
    this.stateDir = stateDir ?? "";
    this.loadFromDisk();
    this.startIdleSweep();
  }

  resolveBackend(model?: string): Backend {
    if (!model) return "claude";
    return this.config.codexModels.has(model) ? "codex" : "claude";
  }

  /** List all available models with their backend type. */
  listModels(): Array<{ id: string; backend: Backend }> {
    const models: Array<{ id: string; backend: Backend }> = [
      { id: "claude-code-cli", backend: "claude" },
    ];
    for (const m of this.config.codexModels) {
      models.push({ id: m, backend: "codex" });
    }
    return models;
  }

  createSession(conversationId: string, opts?: CreateSessionOpts): SessionEntry {
    this.enforceMaxSessions();

    const cwd = opts?.cwd ?? this.config.defaultCwd;
    const model = opts?.model;
    const backend = this.resolveBackend(model);

    // Check persisted data for auto-resume
    let resumeId = opts?.resumeSessionId;
    if (!resumeId) {
      const saved = this.persisted.get(conversationId);
      if (saved && saved.backend === backend && saved.sessionId) {
        resumeId = saved.sessionId;
        this.logger.info(`session-store: auto-resuming ${conversationId} from persisted ${resumeId.slice(0, 12)}`);
      }
    }

    let proc: CliProcess;
    if (backend === "codex") {
      proc = new CodexProcess({
        codexPath: this.config.codexPath,
        cwd,
        model,
        threadId: resumeId,
        logger: this.logger,
      });
    } else {
      const processOpts: ClaudeProcessOptions = {
        claudePath: this.config.claudePath,
        mcpConfigPath: this.config.mcpConfigPath,
        cwd,
        model,
        resumeSessionId: resumeId,
        compact: opts?.compact,
        logger: this.logger,
      };
      proc = new ClaudeProcess(processOpts);
    }
    proc.start();

    const entry: SessionEntry = {
      process: proc,
      backend,
      lastActivity: Date.now(),
      cwd,
      model,
    };

    this.sessions.set(conversationId, entry);
    this.logger.info(`session-store: created ${backend} session for ${conversationId} cwd=${cwd} model=${model ?? "default"}`);
    return entry;
  }

  async destroySession(conversationId: string): Promise<void> {
    const entry = this.sessions.get(conversationId);
    if (!entry) return;

    const sid = entry.process.getSessionId();
    if (sid) {
      this.deadSessionIds.set(sid, { sessionId: sid, cwd: entry.cwd, model: entry.model, backend: entry.backend });
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

  getDeadSession(sessionId: string): { sessionId: string; cwd: string; model?: string; backend: Backend } | undefined {
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

  /** Persist session data after a successful sendMessage. */
  persistSession(conversationId: string, sessionId: string, backend: Backend, model: string | undefined, cwd: string): void {
    this.persisted.set(conversationId, {
      sessionId,
      backend,
      model: model ?? "",
      cwd,
      updatedAt: new Date().toISOString(),
    });
    this.scheduleSave();
  }

  /** Clear persisted data for a conversation (used by /new). */
  clearPersistedSession(conversationId: string): void {
    if (this.persisted.delete(conversationId)) {
      this.scheduleSave();
    }
  }

  listSessions(): Array<{
    conversationId: string;
    sessionId: string;
    alive: boolean;
    backend: Backend;
    cwd: string;
    model?: string;
    lastActivity: number;
    cost: number;
  }> {
    const result: Array<{
      conversationId: string;
      sessionId: string;
      alive: boolean;
      backend: Backend;
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
          backend: entry.backend,
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
          backend: info.backend,
          cwd: info.cwd,
          model: info.model,
          lastActivity: 0,
          cost: 0,
        });
      }
    }

    return result;
  }

  // --- Persistence ---

  private get persistPath(): string {
    return this.stateDir ? path.join(this.stateDir, "bridge-sessions.json") : "";
  }

  private loadFromDisk(): void {
    const filePath = this.persistPath;
    if (!filePath) return;

    try {
      if (!existsSync(filePath)) return;
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw) as Record<string, PersistedSession>;
      for (const [key, value] of Object.entries(data)) {
        if (value.sessionId && value.backend) {
          this.persisted.set(key, value);
        }
      }
      this.logger.info(`session-store: loaded ${this.persisted.size} persisted session(s) from disk`);
    } catch (err) {
      this.logger.warn(`session-store: failed to load persisted sessions: ${err}`);
    }
  }

  private saveToDisk(): void {
    const filePath = this.persistPath;
    if (!filePath) return;

    try {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data: Record<string, PersistedSession> = {};
      for (const [key, value] of this.persisted) {
        data[key] = value;
      }
      writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    } catch (err) {
      this.logger.error(`session-store: failed to save persisted sessions: ${err}`);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, PERSIST_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  // --- Eviction ---

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
        this.deadSessionIds.set(sid, { sessionId: sid, cwd: entry.cwd, model: entry.model, backend: entry.backend });
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
            this.deadSessionIds.set(sid, { sessionId: sid, cwd: entry.cwd, model: entry.model, backend: entry.backend });
          }
          entry.process.stop().catch(() => {});
          this.sessions.delete(key);
        }
      }
    }, 60_000);
    this.idleTimer.unref();
  }

  async stopAll(): Promise<void> {
    // Flush pending saves
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveToDisk();
    }
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
