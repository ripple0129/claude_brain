import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  runClaude,
  ClaudeNotFoundError,
  ClaudeTimeoutError,
  ClaudeExitError,
  ClaudeParseError,
} from "./claude-runner.js";
import {
  computeFingerprint,
  getSession,
  putSession,
  deleteSession,
} from "./session-store.js";
import { findAndUploadImages, replaceImagePaths } from "./image-replacer.js";

type BridgeOptions = {
  port: number;
  stateDir: string;
  claudePath?: string;
  timeoutMs?: number;
  mcpConfigPath?: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
};

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
      // Swallow errors so future callers aren't blocked
      pending = next.then(() => {}, () => {});
      return next;
    },
  };
}

function extractMessages(messages: ChatMessage[]): {
  systemPrompt: string;
  firstUserMsg: string;
  latestUserMsg: string;
} {
  const systemParts: string[] = [];
  let firstUserMsg = "";
  let latestUserMsg = "";

  for (const msg of messages) {
    const text = contentToString(msg.content);
    if (msg.role === "system") {
      systemParts.push(text);
    } else if (msg.role === "user") {
      if (!firstUserMsg) {
        firstUserMsg = text;
      }
      latestUserMsg = text;
    }
  }

  return {
    systemPrompt: systemParts.join("\n"),
    firstUserMsg,
    latestUserMsg,
  };
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
  // Disable Nagle's algorithm for immediate delivery
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
  const { port, stateDir, claudePath, timeoutMs, mcpConfigPath, logger } = opts;
  const mutex = createMutex();
  let server: Server | null = null;

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
    const isStreaming = body.stream !== false; // default to streaming
    const { systemPrompt, firstUserMsg, latestUserMsg } = extractMessages(messages);

    if (!latestUserMsg) {
      jsonResponse(res, 400, openAiError("No user message found", "invalid_request_error"));
      return;
    }

    const fingerprint = computeFingerprint(systemPrompt, firstUserMsg);

    // Handle /new command — clear session and confirm
    const trimmed = latestUserMsg.trim().toLowerCase();
    if (trimmed === "/new" || trimmed === "/reset") {
      await deleteSession(stateDir, fingerprint);
      logger.info(`claude-code-cli: session cleared for fingerprint ${fingerprint}`);
      const reply = "Session cleared. Next message will start a new conversation.";
      if (isStreaming) {
        sseFullMessage(res, reply, model);
      } else {
        jsonResponse(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      return;
    }

    try {
      const result = await mutex.run(async () => {
        const existing = await getSession(stateDir, fingerprint);

        const sseId = `chatcmpl-${Date.now()}`;
        const sseCreated = Math.floor(Date.now() / 1000);

        // For streaming: send SSE headers immediately and keep-alive while waiting
        let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
        if (isStreaming) {
          sseStart(res);
          // Send empty content deltas every 5s to prevent upstream timeout
          // SSE comments (: keep-alive) are ignored by OpenAI-compatible parsers
          keepAliveTimer = setInterval(() => {
            sseDelta(res, sseId, sseCreated, model, "");
          }, 5000);
        }

        const onText = isStreaming
          ? (text: string) => {
              sseDelta(res, sseId, sseCreated, model, text);
            }
          : undefined;

        const runOpts = { claudePath, timeoutMs, mcpConfigPath, onText };

        let out;

        if (existing) {
          try {
            out = await runClaude({
              message: latestUserMsg,
              sessionId: existing.sessionId,
              ...runOpts,
            });
            await putSession(stateDir, fingerprint, out.sessionId);
          } catch (err) {
            logger.warn(
              `claude-code-cli: resume failed for session ${existing.sessionId}, retrying as new: ${err instanceof Error ? err.message : err}`,
            );
            await deleteSession(stateDir, fingerprint);
            out = undefined;
          }
        }

        if (!out) {
          out = await runClaude({
            message: latestUserMsg,
            systemPrompt: systemPrompt || undefined,
            ...runOpts,
          });
          await putSession(stateDir, fingerprint, out.sessionId);
        }

        if (keepAliveTimer) clearInterval(keepAliveTimer);

        // Upload any local image files and append URLs before finishing
        if (isStreaming && out) {
          const workDir = process.env.OPENCLAW_WORKSPACE
            ?? `${process.env.HOME}/.openclaw/workspace`;
          try {
            const urls = await findAndUploadImages(out.text, workDir, logger);
            for (const url of urls) {
              sseDelta(res, sseId, sseCreated, model, `\n\n![image](${url})`);
            }
          } catch (err) {
            logger.warn(`claude-code-cli: image upload failed: ${err}`);
          }
        }

        // Finish SSE stream
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
      const code = err instanceof ClaudeNotFoundError ? "claude_not_found"
        : err instanceof ClaudeTimeoutError ? "timeout"
        : err instanceof ClaudeParseError ? "invalid_response"
        : err instanceof ClaudeExitError ? "cli_error"
        : null;

      if (isStreaming) {
        sseError(res, message);
      } else {
        const status = err instanceof ClaudeNotFoundError ? 503
          : err instanceof ClaudeTimeoutError ? 504
          : err instanceof ClaudeParseError || err instanceof ClaudeExitError ? 502
          : 500;
        jsonResponse(res, status, openAiError(message, "server_error", code));
      }
    }
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "";

    if (url === "/v1/chat/completions") {
      handleCompletions(req, res).catch((err) => {
        logger.error(`claude-code-cli: unhandled error: ${err}`);
        if (!res.headersSent) {
          jsonResponse(res, 500, openAiError("Internal server error", "server_error"));
        }
      });
      return;
    }

    // Health check
    if (url === "/v1/models" || url === "/v1/models/claude-code-cli") {
      jsonResponse(res, 200, {
        object: "list",
        data: [{ id: "claude-code-cli", object: "model", owned_by: "anthropic" }],
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
              `claude-code-cli: port ${port} is already in use, bridge not started`,
            );
            server = null;
            resolve(); // Don't crash the gateway
          } else {
            reject(err);
          }
        });

        server.listen(port, "127.0.0.1", () => {
          logger.info(`claude-code-cli bridge started on port ${port}`);
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
