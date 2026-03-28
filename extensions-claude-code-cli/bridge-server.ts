import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { SessionStore } from "./session-store.js";
import type { CommandHandler } from "./command-handler.js";
import type { HudMonitor } from "./hud-monitor.js";
import { type HudWebSocket, type HudData, formatResetIn } from "./hud-ws.js";
import { findAndUploadImages, replaceImagePaths } from "./image-replacer.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

type ModelInfo = { id: string; owned_by: string };

type BridgeOptions = {
  port: number;
  sessionStore: SessionStore;
  commandHandler: CommandHandler;
  logger: Logger;
  models?: ModelInfo[];
  hudMonitor?: HudMonitor;
  hudWs?: HudWebSocket;
};

type ContentBlock = { type: string; text?: string };
type MessageContent = string | ContentBlock[];

type ChatMessage = {
  role: string;
  content: MessageContent;
};

/** Strip OpenClaw's injected metadata block, returning only the user's actual message. */
function stripMetadata(msg: string): string {
  // Remove "Conversation info (untrusted metadata):\n```json\n{...}\n```\n" block
  return msg.replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "").trim();
}

/** Extract sender metadata from OpenClaw's injected conversation info. */
function extractSenderMeta(msg: string): { conversationId?: string; agentName?: string } | null {
  // Handle both escaped (\"key\":\"val\") and unescaped ("key":"val") quotes
  const convMatch = msg.match(/\\?"conversationId\\?"\s*:\s*\\?"([0-9a-f-]+)\\?"/);
  const agentMatch = msg.match(/\\?"agentName\\?"\s*:\s*\\?"([^"\\]+)\\?"/);
  if (!convMatch && !agentMatch) return null;
  return {
    conversationId: convMatch?.[1],
    agentName: agentMatch?.[1],
  };
}


function parseModelId(raw: string): { agent: string; model: string } {
  const match = raw.match(/^(.+?)\(([^)]+)\)$/);
  if (match) {
    return { agent: match[2].toLowerCase(), model: match[1] };
  }
  return { agent: "default", model: raw };
}

const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-6": "Opus 4.6",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-sonnet-4-5-20250514": "Sonnet 4.5",
  "claude-opus-4-20250514": "Opus 4",
};

function formatModelName(modelId: string): string {
  return MODEL_NAMES[modelId] ?? modelId;
}

function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return String(content ?? "");
}

// Simple mutex for sequential request processing
function createMutex() {
  let locked = false;
  return {
    isLocked(): boolean {
      return locked;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
  };
}

function extractLatestUserMsg(messages: ChatMessage[]): string {
  let latestUserMsg = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      latestUserMsg = contentToString(msg.content);
    }
  }
  return latestUserMsg;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// --- SSE helpers ---

function sseStart(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
}

function sseDelta(res: ServerResponse, id: string, created: number, model: string, content: string): void {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function sseFinish(res: ServerResponse, id: string, created: number, model: string, usage?: Record<string, number>, extra?: Record<string, unknown>): void {
  const finishChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    ...extra,
  };
  res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function sseFullMessage(res: ServerResponse, text: string, model: string): void {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  sseStart(res);
  sseDelta(res, id, created, model, text);
  sseFinish(res, id, created, model);
}

function sseError(res: ServerResponse, message: string): void {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!res.headersSent) {
    sseStart(res);
  }
  sseDelta(res, id, created, "claude-code-cli", `Error: ${message}`);
  sseFinish(res, id, created, "claude-code-cli");
}

function openAiError(message: string, type: string, code: string | null = null): unknown {
  return { error: { message, type, code } };
}

export function createBridgeServer(opts: BridgeOptions) {
  const { port, sessionStore, commandHandler, logger, models, hudMonitor, hudWs } = opts;
  const agentMutexes = new Map<string, ReturnType<typeof createMutex>>();
  const getMutex = (agent: string) => {
    let m = agentMutexes.get(agent);
    if (!m) {
      m = createMutex();
      agentMutexes.set(agent, m);
    }
    return m;
  };
  let server: Server | null = null;

  const modelList: ModelInfo[] = models ?? [
    { id: "claude-code-cli", owned_by: "anthropic" },
  ];

  async function handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      jsonResponse(res, 405, openAiError("Method not allowed", "invalid_request_error"));
      return;
    }

    let body: {
      model?: string;
      messages?: ChatMessage[];
      stream?: boolean;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      jsonResponse(res, 400, openAiError("Invalid JSON body", "invalid_request_error"));
      return;
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      jsonResponse(res, 400, openAiError("messages array is required", "invalid_request_error"));
      return;
    }

    let model = typeof body.model === "string" ? body.model : "claude-code-cli";
    // OpenClaw may send "provider/model" format — strip the provider prefix
    if (model.includes("/")) {
      model = model.split("/").pop()!;
    }
    // Parse agent name from model ID: "model(agent)" → agent, model
    const parsed = parseModelId(model);
    const agent = parsed.agent;
    model = parsed.model;

    const isStreaming = body.stream !== false;
    const latestUserMsg = extractLatestUserMsg(messages);

    if (!latestUserMsg) {
      jsonResponse(res, 400, openAiError("No user message found", "invalid_request_error"));
      return;
    }

    // Extract conversationId and agentName from OpenClaw metadata
    const senderMeta = extractSenderMeta(latestUserMsg);
    // Use agentName as session key — session follows the person, not the conversation.
    // This ensures context persists across private chats and group chats.
    // Fallback: if agentName is missing but conversationId is present, resolve via mapping.
    const resolvedAgent = senderMeta?.agentName
      ?? (senderMeta?.conversationId ? sessionStore.resolveAgent(senderMeta.conversationId) : undefined)
      ?? agent;
    const sessionKey = resolvedAgent;
    // Use agentName for workspace resolution (workspace-linda, workspace-default, etc.)
    const agentForCwd = resolvedAgent;
    if (senderMeta?.conversationId && senderMeta.agentName) {
      sessionStore.mapConversation(senderMeta.conversationId, senderMeta.agentName);
    }

    logger.info(
      `bridge: request — session=${sessionKey} agent=${agentForCwd} model=${model} meta=${JSON.stringify(senderMeta)}`,
    );

    // Try command handling first (handles /new, /reset, etc.)
    if (latestUserMsg.trim().startsWith("/")) {
      let cmdReply = "";
      const cmdResult = await commandHandler.handle(latestUserMsg, {
        conversationId: sessionKey,
        sendChunk: (text) => { cmdReply = text; },
        sendComplete: (text) => { cmdReply = text; },
        sendError: (text) => { cmdReply = `Error: ${text}`; },
      });
      if (cmdResult.handled) {
        if (isStreaming) {
          sseFullMessage(res, cmdReply, model);
        } else {
          jsonResponse(res, 200, {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, message: { role: "assistant", content: cmdReply }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
        return;
      }
    }

    const sessionMutex = getMutex(sessionKey);
    if (sessionMutex.isLocked()) {
      logger.warn(`bridge: session=${sessionKey} mutex locked, returning busy`);
      if (isStreaming) {
        sseFullMessage(res, `⏳ Agent is busy processing another request. Please wait and try again.`, model);
      } else {
        jsonResponse(res, 429, openAiError("Agent is busy (mutex locked)", "rate_limit_error"));
      }
      return;
    }

    try {
      const result = await sessionMutex.run(async () => {
        // Resolve the effective model: command override > request body
        const cmdModel = commandHandler.getModelForConversation(sessionKey);
        const effectiveModel = cmdModel ?? (model !== "claude-code-cli" ? model : undefined);
        const requestedBackend = sessionStore.resolveBackend(effectiveModel);

        // Ensure session exists for this conversation
        let entry = sessionStore.getSession(sessionKey);

        // Backend mismatch → destroy and recreate
        if (entry && entry.process.isAlive() && entry.backend !== requestedBackend) {
          logger.info(`bridge: backend mismatch (${entry.backend} → ${requestedBackend}), recreating session`);
          await sessionStore.destroySession(sessionKey);
          entry = undefined;
        }

        if (!entry || !entry.process.isAlive()) {
          const cwd = commandHandler.getCwdForConversation(agentForCwd);
          entry = sessionStore.createSession(sessionKey, { cwd, model: effectiveModel });
        } else {
          entry.lastActivity = Date.now();
        }

        const sseId = `chatcmpl-${Date.now()}`;
        const sseCreated = Math.floor(Date.now() / 1000);

        // For streaming: send SSE headers, keep-alive, and abort on client disconnect
        let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
        let clientDisconnected = false;
        if (isStreaming) {
          sseStart(res);
          keepAliveTimer = setInterval(() => {
            sseDelta(res, sseId, sseCreated, model, "");
          }, 5000);
          res.on("close", () => {
            clientDisconnected = true;
            if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
            if (entry?.process.isBusy()) {
              logger.info(`bridge: client disconnected, aborting turn for session=${sessionKey}`);
              entry.process.abortTurn();
            }
          });
        }

        const onText = isStreaming
          ? (text: string) => {
              if (!clientDisconnected) sseDelta(res, sseId, sseCreated, model, text);
            }
          : undefined;

        // Push task started
        if (hudWs) hudWs.sendTask(sessionKey, { status: "started", task: stripMetadata(latestUserMsg).slice(0, 200) });

        let out;
        try {
          out = await entry.process.sendMessage(latestUserMsg, onText);
        } catch (err) {
          // Client disconnect → don't retry, just bail
          if (clientDisconnected) throw err;

          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`bridge: sendMessage failed: ${errMsg}, recreating session...`);
          // Stale persisted session → clear and start fresh
          sessionStore.clearPersistedSession(sessionKey);
          await sessionStore.destroySession(sessionKey);
          const cwd = commandHandler.getCwdForConversation(agentForCwd);
          entry = sessionStore.createSession(sessionKey, { cwd, model: effectiveModel });
          out = await entry.process.sendMessage(latestUserMsg, onText);
        }

        if (keepAliveTimer) clearInterval(keepAliveTimer);

        // Persist session ID for cross-restart resume
        if (out.sessionId) {
          sessionStore.persistSession(
            sessionKey,
            out.sessionId,
            entry.backend,
            entry.model,
            entry.cwd,
          );
        }

        // Skip remaining SSE writes if client already disconnected
        if (isStreaming && clientDisconnected) {
          logger.info(`bridge: skipping SSE finish — client already disconnected`);
          return { result: out };
        }

        // Upload any local image files (scan prose text)
        if (isStreaming && out) {
          const workDir = process.env.OPENCLAW_WORKSPACE
            ?? `${process.env.HOME}/.openclaw/workspace`;
          try {
            const urls = await findAndUploadImages(out.text, workDir, logger);
            for (const url of urls) {
              sseDelta(res, sseId, sseCreated, model, `\n\n![image](${url})`);
            }
          } catch (err) {
            logger.warn(`bridge: image upload failed: ${err}`);
          }
        }

        if (isStreaming) {
          const openaiUsage = out.usage ? {
            prompt_tokens: out.usage.input_tokens,
            completion_tokens: out.usage.output_tokens,
            total_tokens: out.usage.input_tokens + out.usage.output_tokens,
            cache_read_input_tokens: out.usage.cache_read_input_tokens,
            cache_creation_input_tokens: out.usage.cache_creation_input_tokens,
          } : undefined;
          const extra: Record<string, unknown> = {};
          if (out.costUsd !== undefined) extra.cost_usd = out.costUsd;
          if (out.rateLimit) extra.rate_limit = out.rateLimit;
          if (out.numTurns !== undefined) extra.num_turns = out.numTurns;
          if (out.durationMs !== undefined) extra.duration_ms = out.durationMs;
          if (out.context) extra.context = out.context;
          sseFinish(res, sseId, sseCreated, model, openaiUsage, Object.keys(extra).length > 0 ? extra : undefined);
        }

        if (out.toolsUsed?.length) {
          logger.info(`bridge: tools used: ${out.toolsUsed.map(t => t.name).join(", ")}`);
        }

        // Push task completed
        if (hudWs) hudWs.sendTask(sessionKey, {
          status: "completed",
          durationMs: out.durationMs,
          costUsd: out.costUsd,
          numTurns: out.numTurns,
        });

        // Snapshot context & model inside mutex (process may be recreated later)
        const hudContext = entry.process.getContext();
        const hudModel = formatModelName(entry.process.getModel() ?? model);

        return { result: out, hudContext, hudModel };
      });

      // HUD push outside mutex — notify + read status file + send WS
      if (hudWs && senderMeta?.conversationId) {
        // Fire and forget: don't block the response
        (async () => {
          if (hudMonitor) await hudMonitor.notify();
          const hudData: HudData = {};

          // Context from process snapshot
          if (result.hudContext) {
            const total = result.hudContext.contextWindow ?? 0;
            hudData.context = {
              used: result.hudContext.contextTokens,
              total,
              percent: total ? Math.round((result.hudContext.contextTokens / total) * 100) : 0,
            };
          }

          // Rate limits from status file
          try {
            const sf = JSON.parse(readFileSync("/tmp/claude-status.json", "utf-8")) as Record<string, unknown>;
            if (sf.limit5h) hudData.limit5h = sf.limit5h as HudData["limit5h"];
            if (sf.limit7d) hudData.limit7d = sf.limit7d as HudData["limit7d"];
          } catch { /* status file unavailable */ }

          hudData.model = result.hudModel;
          logger.info(`hud-ws: sending hud_update convId=${senderMeta.conversationId!.slice(0, 8)} data=${JSON.stringify(hudData)}`);
          hudWs.send(senderMeta.conversationId!, hudData);
        })().catch((err) => logger.warn(`hud-ws: push failed — ${err}`));
      }

      // Non-streaming response
      if (!isStreaming) {
        const workDir = process.env.OPENCLAW_WORKSPACE
          ?? `${process.env.HOME}/.openclaw/workspace`;
        let content = result.result.text;
        try {
          content = await replaceImagePaths(content, workDir, logger);
        } catch { /* ignore */ }
        const nonStreamUsage = result.result.usage ? {
          prompt_tokens: result.result.usage.input_tokens,
          completion_tokens: result.result.usage.output_tokens,
          total_tokens: result.result.usage.input_tokens + result.result.usage.output_tokens,
          cache_read_input_tokens: result.result.usage.cache_read_input_tokens,
          cache_creation_input_tokens: result.result.usage.cache_creation_input_tokens,
        } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        const nonStreamExtra: Record<string, unknown> = {};
        if (result.result.costUsd !== undefined) nonStreamExtra.cost_usd = result.result.costUsd;
        if (result.result.rateLimit) nonStreamExtra.rate_limit = result.result.rateLimit;
        if (result.result.numTurns !== undefined) nonStreamExtra.num_turns = result.result.numTurns;
        if (result.result.durationMs !== undefined) nonStreamExtra.duration_ms = result.result.durationMs;
        if (result.result.context) nonStreamExtra.context = result.result.context;

        jsonResponse(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: nonStreamUsage,
          ...nonStreamExtra,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error(`bridge: REQUEST ERROR msg=${message}`);

      if (res.writableEnded || res.destroyed) return;

      if (isStreaming) {
        sseError(res, message);
      } else {
        jsonResponse(res, 500, openAiError(message, "server_error"));
      }
    }
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "";

    if (url === "/v1/chat/completions") {
      handleCompletions(req, res).catch((err) => {
        logger.error(`bridge: unhandled error: ${err}`);
        if (!res.headersSent) {
          jsonResponse(res, 500, openAiError("Internal server error", "server_error"));
        }
      });
      return;
    }

    // Models endpoint
    if (url === "/v1/models" || url.startsWith("/v1/models/")) {
      jsonResponse(res, 200, {
        object: "list",
        data: modelList.map((m) => ({ id: m.id, object: "model", owned_by: m.owned_by })),
      });
      return;
    }

    jsonResponse(res, 404, openAiError(`Not found: ${url}`, "invalid_request_error"));
  }

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer(handleRequest);

        server.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE") {
            logger.error(
              `bridge: port ${port} is already in use, bridge not started`,
            );
            server = null;
            resolve();
          } else {
            reject(err);
          }
        });

        server.listen(port, "127.0.0.1", () => {
          logger.info(`bridge: HTTP bridge started on port ${port}`);
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => {
          server = null;
          resolve();
        });
      });
    },
  };
}
