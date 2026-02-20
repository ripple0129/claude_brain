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

  const agent = new ArinovaAgent({
    serverUrl,
    botToken,
    skills: commandHandler.getSkills(),
  });

  agent.onTask(async (task) => {
    const { conversationId, content } = task;

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
        entry.lastActivity = Date.now();
      } else {
        const cwd = commandHandler.getCwdForConversation(conversationId);
        const model = commandHandler.getModelForConversation(conversationId);
        entry = sessionStore.createSession(conversationId, { cwd, model });
      }

      let sendResult;
      try {
        sendResult = await entry.process.sendMessage(content, (text) => {
          task.sendChunk(text);
        });
      } catch (err) {
        // Process died or errored — try once more with a fresh process
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`arinova-agent: sendMessage failed: ${errMsg}, restarting process...`);
        await entry.process.restart();
        sendResult = await entry.process.sendMessage(content, (text) => {
          task.sendChunk(text);
        });
      }

      task.sendComplete(sendResult.text);
    } catch (err) {
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
