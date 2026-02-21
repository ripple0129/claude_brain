import { ArinovaAgent } from "@arinova-ai/agent-sdk";
import type { SessionStore } from "./session-store.js";
import type { CommandHandler } from "./command-handler.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type ArinovaAgentServiceOptions = {
  serverUrl: string;
  botToken: string;
  sessionStore: SessionStore;
  commandHandler: CommandHandler;
  logger: Logger;
};

/**
 * Creates and manages the Arinova Chat agent connection.
 * Routes tasks to CommandHandler (for slash commands) or SessionStore (for regular messages).
 */
export function createArinovaAgentService(opts: ArinovaAgentServiceOptions) {
  const { serverUrl, botToken, sessionStore, commandHandler, logger } = opts;

  const skills = commandHandler.getSkills();
  logger.info(`arinova-agent: registering ${skills.length} skills: ${skills.map(s => s.id).join(", ")}`);

  const agent = new ArinovaAgent({
    serverUrl,
    botToken,
    skills,
  });

  agent.onTask(async (task) => {
    const { conversationId, content } = task;
    logger.info(`arinova-agent: task received conv=${conversationId} len=${content.length}`);

    // Try command handling first
    const result = await commandHandler.handle(content, {
      conversationId,
      sendChunk: task.sendChunk,
      sendComplete: task.sendComplete,
      sendError: task.sendError,
    });
    if (result.handled) return;

    // Regular message — route to SessionStore
    try {
      let entry = sessionStore.getSession(conversationId);

      if (entry && entry.process.isAlive()) {
        logger.info(`arinova-agent: reusing session for ${conversationId} (alive, busy=${entry.process.isBusy()})`);
        entry.lastActivity = Date.now();
      } else {
        logger.info(`arinova-agent: creating new session for ${conversationId} (old=${entry ? "dead" : "none"})`);
        const cwd = commandHandler.getCwdForConversation(conversationId);
        const model = commandHandler.getModelForConversation(conversationId);
        entry = sessionStore.createSession(conversationId, { cwd, model });
      }

      // Wire up cancel: abort the Claude turn when user cancels
      const onAbort = () => {
        logger.info(`arinova-agent: task cancelled for ${conversationId}`);
        entry!.process.abortTurn();
      };
      task.signal.addEventListener("abort", onAbort, { once: true });

      let sendResult;
      try {
        sendResult = await entry.process.sendMessage(content, (text) => {
          task.sendChunk(text);
        });
      } catch (err) {
        // If user cancelled, don't retry — just return
        if (task.signal.aborted) {
          logger.info(`arinova-agent: task aborted, skipping retry`);
          return;
        }
        // Process died or errored — try once more with a fresh process
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`arinova-agent: sendMessage failed: ${errMsg}, restarting process...`);
        await entry.process.restart();
        sendResult = await entry.process.sendMessage(content, (text) => {
          task.sendChunk(text);
        });
      } finally {
        task.signal.removeEventListener("abort", onAbort);
      }

      // Persist session for cross-restart resume
      if (sendResult.sessionId) {
        sessionStore.persistSession(
          conversationId,
          sendResult.sessionId,
          entry.backend,
          entry.model,
          entry.cwd,
        );
      }

      task.sendComplete(sendResult.text);
    } catch (err) {
      // Don't report error if it was a cancellation
      if (task.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`arinova-agent: task error for ${conversationId}: ${msg}`);
      task.sendError(msg);
    }
  });

  agent.on("connected", () => {
    logger.info("arinova-agent: connected to Arinova Chat");
  });

  agent.on("disconnected", () => {
    logger.warn("arinova-agent: disconnected from Arinova Chat");
  });

  agent.on("error", (err) => {
    logger.error(`arinova-agent: error: ${err.message}`);
  });

  return {
    async start(): Promise<void> {
      await agent.connect();
      logger.info(`arinova-agent: started — server=${serverUrl}`);
    },

    stop(): void {
      agent.disconnect();
      logger.info("arinova-agent: disconnected");
    },
  };
}
