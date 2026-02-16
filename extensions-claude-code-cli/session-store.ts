import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type SessionEntry = {
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
};

export type SessionStore = Record<string, SessionEntry>;

const SESSIONS_FILE = "sessions.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function computeFingerprint(systemPrompt: string, firstUserMessage: string): string {
  const hash = createHash("sha256");
  hash.update(systemPrompt);
  hash.update("\0");
  hash.update(firstUserMessage);
  return hash.digest("hex").slice(0, 16);
}

function sessionsPath(stateDir: string): string {
  return path.join(stateDir, SESSIONS_FILE);
}

export async function loadSessions(stateDir: string): Promise<SessionStore> {
  try {
    const raw = await fs.readFile(sessionsPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as SessionStore;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export async function saveSessions(stateDir: string, store: SessionStore): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(sessionsPath(stateDir), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function pruneExpired(store: SessionStore): SessionStore {
  const now = Date.now();
  const pruned: SessionStore = {};
  for (const [key, entry] of Object.entries(store)) {
    if (now - entry.lastUsedAt < MAX_AGE_MS) {
      pruned[key] = entry;
    }
  }
  return pruned;
}

export async function getSession(
  stateDir: string,
  fingerprint: string,
): Promise<SessionEntry | null> {
  const store = pruneExpired(await loadSessions(stateDir));
  return store[fingerprint] ?? null;
}

export async function putSession(
  stateDir: string,
  fingerprint: string,
  sessionId: string,
): Promise<void> {
  const store = pruneExpired(await loadSessions(stateDir));
  const existing = store[fingerprint];
  store[fingerprint] = {
    sessionId,
    createdAt: existing?.createdAt ?? Date.now(),
    lastUsedAt: Date.now(),
  };
  await saveSessions(stateDir, store);
}

export async function deleteSession(stateDir: string, fingerprint: string): Promise<void> {
  const store = await loadSessions(stateDir);
  delete store[fingerprint];
  await saveSessions(stateDir, pruneExpired(store));
}
