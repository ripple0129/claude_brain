import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk";
import { createBridgeServer } from "./bridge-server.js";

const DEFAULT_PORT = 18810;
const DEFAULT_CLAUDE_PATH = "claude";
const DEFAULT_TIMEOUT_MS = 300_000;

const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 16_384;

function resolvePort(api: OpenClawPluginApi): number {
  const cfg = api.pluginConfig as Record<string, unknown> | undefined;
  if (cfg?.port && typeof cfg.port === "number") return cfg.port;
  const envPort = process.env.OPENCLAW_CLAUDE_CLI_PORT;
  if (envPort) {
    const n = Number.parseInt(envPort, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

function resolveClaudePath(api: OpenClawPluginApi): string {
  const cfg = api.pluginConfig as Record<string, unknown> | undefined;
  if (cfg?.claudePath && typeof cfg.claudePath === "string") return cfg.claudePath;
  return process.env.CLAUDE_PATH ?? DEFAULT_CLAUDE_PATH;
}

function resolveTimeoutMs(api: OpenClawPluginApi): number {
  const cfg = api.pluginConfig as Record<string, unknown> | undefined;
  if (cfg?.timeoutMs && typeof cfg.timeoutMs === "number") return cfg.timeoutMs;
  return DEFAULT_TIMEOUT_MS;
}

function resolveMcpConfigPath(api: OpenClawPluginApi): string | undefined {
  const cfg = api.pluginConfig as Record<string, unknown> | undefined;
  if (cfg?.mcpConfigPath && typeof cfg.mcpConfigPath === "string") return cfg.mcpConfigPath;
  return process.env.OPENCLAW_CLAUDE_MCP_CONFIG ?? undefined;
}

const plugin = {
  id: "claude-code-cli",
  name: "Claude Code CLI",
  description: "Bridge provider that routes requests to the Claude Code CLI",

  register(api: OpenClawPluginApi) {
    let bridge: ReturnType<typeof createBridgeServer> | null = null;

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
        const timeoutMs = resolveTimeoutMs(api);
        const mcpConfigPath = resolveMcpConfigPath(api);

        bridge = createBridgeServer({
          port,
          stateDir: ctx.stateDir,
          claudePath,
          timeoutMs,
          mcpConfigPath,
          logger: ctx.logger,
        });

        await bridge.start();
      },
      stop: async () => {
        if (bridge) {
          await bridge.stop();
          bridge = null;
        }
      },
    };

    api.registerService(bridgeService);
  },
};

export default plugin;
