import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SessionStore } from "./session-store.js";
import type { CommandHandler } from "./command-handler.js";
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
};

const DEBUG_CONVERSATION_ID = "debug";

type ContentBlock = { type: string; text?: string };
type MessageContent = string | ContentBlock[];

type ChatMessage = {
  role: string;
  content: MessageContent;
};

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
  let pending: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = pending.then(() => fn());
      pending = next.then(() => {}, () => {});
      return next;
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

function sseFinish(res: ServerResponse, id: string, created: number, model: string): void {
  const finishChunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
  const { port, sessionStore, commandHandler, logger, models } = opts;
  const mutex = createMutex();
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

    const model = typeof body.model === "string" ? body.model : "claude-code-cli";
    const isStreaming = body.stream !== false;
    const latestUserMsg = extractLatestUserMsg(messages);

    if (!latestUserMsg) {
      jsonResponse(res, 400, openAiError("No user message found", "invalid_request_error"));
      return;
    }

    logger.info(
      `bridge: request — msgs=${messages.length} msg="${latestUserMsg.slice(0, 80)}${latestUserMsg.length > 80 ? "..." : ""}"`,
    );

    // Try command handling first (handles /new, /reset, etc.)
    if (latestUserMsg.trim().startsWith("/")) {
      let cmdReply = "";
      const cmdResult = await commandHandler.handle(latestUserMsg, {
        conversationId: DEBUG_CONVERSATION_ID,
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

    try {
      const result = await mutex.run(async () => {
        // Resolve the effective model: command override > request body
        const cmdModel = commandHandler.getModelForConversation(DEBUG_CONVERSATION_ID);
        const effectiveModel = cmdModel ?? (model !== "claude-code-cli" ? model : undefined);
        const requestedBackend = sessionStore.resolveBackend(effectiveModel);

        // Ensure session exists for debug conversation
        let entry = sessionStore.getSession(DEBUG_CONVERSATION_ID);

        // Backend mismatch → destroy and recreate
        if (entry && entry.process.isAlive() && entry.backend !== requestedBackend) {
          logger.info(`bridge: backend mismatch (${entry.backend} → ${requestedBackend}), recreating session`);
          await sessionStore.destroySession(DEBUG_CONVERSATION_ID);
          entry = undefined;
        }

        if (!entry || !entry.process.isAlive()) {
          const cwd = commandHandler.getCwdForConversation(DEBUG_CONVERSATION_ID);
          entry = sessionStore.createSession(DEBUG_CONVERSATION_ID, { cwd, model: effectiveModel });
        } else {
          entry.lastActivity = Date.now();
        }

        const sseId = `chatcmpl-${Date.now()}`;
        const sseCreated = Math.floor(Date.now() / 1000);

        // For streaming: send SSE headers and keep-alive
        let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
        if (isStreaming) {
          sseStart(res);
          keepAliveTimer = setInterval(() => {
            sseDelta(res, sseId, sseCreated, model, "");
          }, 5000);
        }

        const onText = isStreaming
          ? (text: string) => {
              sseDelta(res, sseId, sseCreated, model, text);
            }
          : undefined;

        let out;
        try {
          out = await entry.process.sendMessage(latestUserMsg, onText);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`bridge: sendMessage failed: ${errMsg}, restarting process...`);
          await entry.process.restart();
          out = await entry.process.sendMessage(latestUserMsg, onText);
        }

        if (keepAliveTimer) clearInterval(keepAliveTimer);

        // Persist session ID for cross-restart resume
        if (out.sessionId) {
          sessionStore.persistSession(
            DEBUG_CONVERSATION_ID,
            out.sessionId,
            entry.backend,
            entry.model,
            entry.cwd,
          );
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
          sseFinish(res, sseId, sseCreated, model);
        }

        return { result: out };
      });

      // Non-streaming response
      if (!isStreaming) {
        const workDir = process.env.OPENCLAW_WORKSPACE
          ?? `${process.env.HOME}/.openclaw/workspace`;
        let content = result.result.text;
        try {
          content = await replaceImagePaths(content, workDir, logger);
        } catch { /* ignore */ }
        jsonResponse(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.error(`bridge: REQUEST ERROR msg=${message}`);

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
