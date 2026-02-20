import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import path from "node:path";
import { createBridgeServer } from "./bridge-server.js";
import { SessionStore } from "./session-store.js";
import { CommandHandler } from "./command-handler.js";
import { createArinovaAgentService } from "./arinova-agent.js";

const DEFAULT_PORT = 18810;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_CWD = path.join(homedir(), ".openclaw", "workspace");
const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000; // 10 minutes

const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 16_384;

type PluginCfg = Record<string, unknown> | undefined;
function cfg(api: OpenClawPluginApi): PluginCfg {
  return api.pluginConfig as PluginCfg;
}

function resolvePort(api: OpenClawPluginApi): number {
  const c = cfg(api);
  if (c?.port && typeof c.port === "number") return c.port;
  const envPort = process.env.OPENCLAW_CLAUDE_CLI_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

function resolveClaudePath(api: OpenClawPluginApi): string {
  const c = cfg(api);
  if (c?.claudePath && typeof c.claudePath === "string") return c.claudePath;
  return process.env.CLAUDE_PATH ?? DEFAULT_CLAUDE_PATH;
}

function resolveMcpConfigPath(api: OpenClawPluginApi): string | undefined {
  const c = cfg(api);
  if (c?.mcpConfigPath && typeof c.mcpConfigPath === "string") return c.mcpConfigPath;
  return process.env.OPENCLAW_CLAUDE_MCP_CONFIG ?? undefined;
}

function arinovaChannelConfig(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  return api.config?.channels?.["openclaw-arinova-ai"] as Record<string, unknown> | undefined;
}

function resolveArinovaServerUrl(api: OpenClawPluginApi): string {
  const c = cfg(api);
  const arinova = c?.arinova as Record<string, unknown> | undefined;
  if (arinova?.serverUrl && typeof arinova.serverUrl === "string") return arinova.serverUrl;
  const ch = arinovaChannelConfig(api);
  if (ch?.apiUrl && typeof ch.apiUrl === "string") return ch.apiUrl;
  return process.env.ARINOVA_SERVER_URL ?? "wss://api.chat.arinova.ai";
}

function resolveArinovaBotToken(api: OpenClawPluginApi): string {
  const c = cfg(api);
  const arinova = c?.arinova as Record<string, unknown> | undefined;
  if (arinova?.botToken && typeof arinova.botToken === "string") return arinova.botToken;
  const ch = arinovaChannelConfig(api);
  if (ch?.botToken && typeof ch.botToken === "string") return ch.botToken;
  return process.env.ARINOVA_BOT_TOKEN ?? "";
}

function resolveDefaultCwd(api: OpenClawPluginApi): string {
  const c = cfg(api);
  const defaults = c?.defaults as Record<string, unknown> | undefined;
  if (defaults?.cwd && typeof defaults.cwd === "string") {
    return defaults.cwd.replace(/^~/, homedir());
  }
  const envCwd = process.env.DEFAULT_CWD;
  if (envCwd) return envCwd.replace(/^~/, homedir());
  return DEFAULT_CWD;
}

function resolveMaxSessions(api: OpenClawPluginApi): number {
  const c = cfg(api);
  const defaults = c?.defaults as Record<string, unknown> | undefined;
  if (defaults?.maxSessions && typeof defaults.maxSessions === "number") return defaults.maxSessions;
  const envVal = process.env.MAX_SESSIONS;
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_SESSIONS;
}

function resolveIdleTimeoutMs(api: OpenClawPluginApi): number {
  const c = cfg(api);
  const defaults = c?.defaults as Record<string, unknown> | undefined;
  if (defaults?.idleTimeoutMs && typeof defaults.idleTimeoutMs === "number") return defaults.idleTimeoutMs;
  const envVal = process.env.IDLE_TIMEOUT_MS;
  if (envVal) {
    const n = Number.parseInt(envVal, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

const plugin = {
  id: "claude-code-cli",
  name: "Claude Code CLI",
  description: "Bridge provider that routes requests to the Claude Code CLI",

  register(api: OpenClawPluginApi) {
    let bridge: ReturnType<typeof createBridgeServer> | null = null;
    let arinovaAgent: ReturnType<typeof createArinovaAgentService> | null = null;
    let sessionStore: SessionStore | null = null;

    // --- Provider registration ---
    api.registerProvider({
      id: "claude-code-cli",
      label: "Claude Code CLI",
      auth: [
        {
          id: "local",
          label: "Local CLI bridge",
          hint: "Starts a local HTTP bridge that forwards requests to the Claude Code CLI",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const portInput = await ctx.prompter.text({
              message: "Bridge port",
              initialValue: String(DEFAULT_PORT),
              validate: (value: string) => {
                const n = Number.parseInt(value, 10);
                if (!Number.isFinite(n) || n < 1 || n > 65535) return "Enter a valid port (1-65535)";
                return undefined;
              },
            });

            const port = Number.parseInt(portInput, 10);
            const baseUrl = `http://127.0.0.1:${port}/v1`;
            const modelId = "claude-code-cli";
            const modelRef = `claude-code-cli/${modelId}`;

            return {
              profiles: [
                {
                  profileId: "claude-code-cli:local",
                  credential: {
                    type: "token",
                    provider: "claude-code-cli",
                    token: "local",
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    "claude-code-cli": {
                      baseUrl,
                      apiKey: "local",
                      api: "openai-completions",
                      authHeader: false,
                      models: [
                        {
                          id: modelId,
                          name: "Claude Code CLI",
                          api: "openai-completions" as const,
                          reasoning: false,
                          input: ["text"] as Array<"text" | "image">,
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          contextWindow: CONTEXT_WINDOW,
                          maxTokens: MAX_TOKENS,
                        },
                      ],
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: {
                      [modelRef]: {},
                    },
                  },
                },
              },
              defaultModel: modelRef,
              notes: [
                "Ensure `claude` CLI is installed and logged in (`claude --version`).",
                "The bridge server starts automatically with the gateway.",
                `Bridge listens on http://127.0.0.1:${port}/v1.`,
              ],
            };
          },
        },
      ],
    });

    // --- Service registration ---
    const bridgeService: OpenClawPluginService = {
      id: "claude-code-cli-bridge",
      start: async (ctx) => {
        const port = resolvePort(api);
        const claudePath = resolveClaudePath(api);
        const mcpConfigPath = resolveMcpConfigPath(api);
        const defaultCwd = resolveDefaultCwd(api);
        const maxSessions = resolveMaxSessions(api);
        const idleTimeoutMs = resolveIdleTimeoutMs(api);

        // Create shared SessionStore and CommandHandler
        sessionStore = new SessionStore(
          { claudePath, mcpConfigPath, defaultCwd, maxSessions, idleTimeoutMs },
          ctx.logger,
        );
        const commandHandler = new CommandHandler(sessionStore, { defaultCwd });

        // Start HTTP bridge
        bridge = createBridgeServer({
          port,
          sessionStore,
          commandHandler,
          logger: ctx.logger,
        });
        await bridge.start();

        // Start Arinova agent (optional — skip if no bot token)
        const botToken = resolveArinovaBotToken(api);
        if (botToken) {
          const serverUrl = resolveArinovaServerUrl(api);
          arinovaAgent = createArinovaAgentService({
            serverUrl,
            botToken,
            sessionStore,
            commandHandler,
            logger: ctx.logger,
          });
          try {
            await arinovaAgent.start();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.logger.error(`arinova-agent: failed to connect: ${msg}`);
            arinovaAgent = null;
          }
        } else {
          ctx.logger.info("arinova-agent: no bot token configured, skipping");
        }
      },
      stop: async () => {
        if (arinovaAgent) {
          arinovaAgent.stop();
          arinovaAgent = null;
        }
        if (bridge) {
          await bridge.stop();
          bridge = null;
        }
        if (sessionStore) {
          await sessionStore.stopAll();
          sessionStore = null;
        }
      },
    };

    api.registerService(bridgeService);
  },
};

export default plugin;
