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

const DEFAULT_PORT = 18810;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_CODEX_PATH = "codex";
const DEFAULT_CWD = path.join(homedir(), ".openclaw", "workspace");
const DEFAULT_MAX_SESSIONS = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000; // 10 minutes

const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 16_384;

const DEFAULT_SYSTEM_PROMPT = [
  "When you create or save images/screenshots to local files, always include the full absolute file path in your response text.",
  "The system will automatically detect local image paths and upload them for the user to view.",
].join(" ");

const DEFAULT_CODEX_MODELS = [
  "codex-mini-latest",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
];

const DEFAULT_GEMINI_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
];

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

function resolveCodexPath(api: OpenClawPluginApi): string {
  const c = cfg(api);
  if (c?.codexPath && typeof c.codexPath === "string") return c.codexPath;
  return process.env.CODEX_PATH ?? DEFAULT_CODEX_PATH;
}

function resolveCodexModels(api: OpenClawPluginApi): string[] {
  const c = cfg(api);
  if (Array.isArray(c?.codexModels)) {
    return (c.codexModels as unknown[]).filter((m): m is string => typeof m === "string");
  }
  return DEFAULT_CODEX_MODELS;
}

function resolveGeminiPath(api: OpenClawPluginApi): string {
  const c = cfg(api);
  if (c?.geminiPath && typeof c.geminiPath === "string") return c.geminiPath;
  return process.env.GEMINI_PATH ?? "gemini";
}

function resolveGeminiModels(api: OpenClawPluginApi): string[] {
  const c = cfg(api);
  if (Array.isArray(c?.geminiModels)) {
    return (c.geminiModels as unknown[]).filter((m): m is string => typeof m === "string");
  }
  return DEFAULT_GEMINI_MODELS;
}

function resolveMcpConfigPath(api: OpenClawPluginApi): string | undefined {
  const c = cfg(api);
  if (c?.mcpConfigPath && typeof c.mcpConfigPath === "string") return c.mcpConfigPath;
  return process.env.OPENCLAW_CLAUDE_MCP_CONFIG ?? undefined;
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

function resolveSystemPrompt(api: OpenClawPluginApi): string | undefined {
  const c = cfg(api);
  if (c?.systemPrompt && typeof c.systemPrompt === "string") return c.systemPrompt;
  return DEFAULT_SYSTEM_PROMPT;
}

function resolveAgentCwdDefaults(api: OpenClawPluginApi): Record<string, string> | undefined {
  const c = cfg(api);
  const agents = c?.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") return undefined;

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(agents)) {
    const agentCfg = value as Record<string, unknown> | undefined;
    if (agentCfg?.cwd && typeof agentCfg.cwd === "string") {
      result[name.toLowerCase()] = agentCfg.cwd.replace(/^~/, homedir());
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Read agents.defaults.model.primary from OpenClaw config.
 * If it's our provider (claude-code-cli/xxx), extract the model ID.
 */
function resolveDefaultModel(api: OpenClawPluginApi): string | undefined {
  const agents = api.config?.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const model = defaults?.model as Record<string, unknown> | undefined;
  const primary = model?.primary as string | undefined;
  if (!primary) return undefined;
  // "claude-code-cli/gpt-5.3-codex" → "gpt-5.3-codex"
  if (primary.includes("/")) {
    const modelId = primary.split("/").pop()!;
    return modelId !== "claude-code-cli" ? modelId : undefined;
  }
  return undefined;
}

const plugin = {
  id: "claude-code-cli",
  name: "Claude Code CLI",
  description: "Bridge provider that routes requests to the Claude Code CLI",

  register(api: OpenClawPluginApi) {
    let bridge: ReturnType<typeof createBridgeServer> | null = null;
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
        const codexPath = resolveCodexPath(api);
        const codexModelList = resolveCodexModels(api);
        const geminiPath = resolveGeminiPath(api);
        const geminiModelList = resolveGeminiModels(api);
        const mcpConfigPath = resolveMcpConfigPath(api);
        const systemPrompt = resolveSystemPrompt(api);
        const defaultCwd = resolveDefaultCwd(api);
        const defaultModel = resolveDefaultModel(api);
        const maxSessions = resolveMaxSessions(api);
        const idleTimeoutMs = resolveIdleTimeoutMs(api);

        if (defaultModel) {
          ctx.logger.info(`bridge: default model from config: ${defaultModel}`);
        }

        // Create shared SessionStore and CommandHandler
        sessionStore = new SessionStore(
          {
            claudePath,
            codexPath,
            codexModels: new Set(codexModelList),
            geminiPath,
            geminiModels: new Set(geminiModelList),
            mcpConfigPath,
            systemPrompt,
            defaultCwd,
            maxSessions,
            idleTimeoutMs,
          },
          ctx.logger,
          ctx.stateDir,
        );
        const agentCwdDefaults = resolveAgentCwdDefaults(api);
        const commandHandler = new CommandHandler(sessionStore, { defaultCwd, defaultModel, agentCwdDefaults });

        // Build model list for /v1/models endpoint
        const models = [
          { id: "claude-code-cli", owned_by: "anthropic" },
          ...codexModelList.map((m) => ({ id: m, owned_by: "openai" })),
          ...geminiModelList.map((m) => ({ id: m, owned_by: "google" })),
        ];

        // Start HTTP bridge
        bridge = createBridgeServer({
          port,
          sessionStore,
          commandHandler,
          logger: ctx.logger,
          models,
        });
        await bridge.start();
      },
      stop: async () => {
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
