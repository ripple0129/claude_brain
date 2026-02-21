import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { SessionStore } from "./session-store.js";

export interface CommandContext {
  conversationId: string;
  sendChunk: (text: string) => void;
  sendComplete: (text: string) => void;
  sendError: (text: string) => void;
}

export type CommandResult = { handled: true } | { handled: false };

export interface CommandHandlerConfig {
  defaultCwd: string;
  defaultModel?: string;
}

export class CommandHandler {
  private store: SessionStore;
  private config: CommandHandlerConfig;

  /** Per-conversation cwd overrides (set by /new). */
  private cwdOverrides = new Map<string, string>();
  /** Per-conversation model overrides (set by /model). */
  private modelOverrides = new Map<string, string>();

  constructor(store: SessionStore, config: CommandHandlerConfig) {
    this.store = store;
    this.config = config;
  }

  getCwdForConversation(conversationId: string): string {
    return this.cwdOverrides.get(conversationId) ?? this.config.defaultCwd;
  }

  getModelForConversation(conversationId: string): string | undefined {
    return this.modelOverrides.get(conversationId) ?? this.config.defaultModel;
  }

  async handle(content: string, ctx: CommandContext): Promise<CommandResult> {
    const trimmed = content.trim();
    if (!trimmed.startsWith("/")) return { handled: false };

    const spaceIdx = trimmed.indexOf(" ");
    const cmd = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const arg = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "new":
        await this.handleNew(arg, ctx);
        return { handled: true };
      case "sessions":
        this.handleSessions(ctx);
        return { handled: true };
      case "status":
        this.handleStatus(ctx);
        return { handled: true };
      case "help":
        this.handleHelp(ctx);
        return { handled: true };
      case "stop":
        this.handleStop(ctx);
        return { handled: true };
      case "resume":
        await this.handleResume(arg, ctx);
        return { handled: true };
      case "model":
        await this.handleModel(arg, ctx);
        return { handled: true };
      case "compact":
        await this.handleCompact(ctx);
        return { handled: true };
      case "cost":
        this.handleCost(ctx);
        return { handled: true };
      default:
        return { handled: false };
    }
  }

  /** Get the list of skills to register with Arinova. */
  getSkills(): Array<{ id: string; name: string; description: string }> {
    return [
      { id: "new", name: "New", description: "開新工作階段 (可帶路徑: /new ~/project)" },
      { id: "sessions", name: "Sessions", description: "列出所有 sessions" },
      { id: "status", name: "Status", description: "查看目前 session 狀態" },
      { id: "help", name: "Help", description: "列出所有可用指令" },
      { id: "stop", name: "Stop", description: "中斷目前正在執行的操作" },
      { id: "resume", name: "Resume", description: "恢復 session (可帶 ID: /resume <id>)" },
      { id: "model", name: "Model", description: "切換模型" },
      { id: "cost", name: "Cost", description: "顯示累計花費 / token 用量" },
      { id: "compact", name: "Compact", description: "壓縮對話上下文" },
    ];
  }

  // --- Command Handlers ---

  private reply(ctx: CommandContext, text: string): void {
    ctx.sendChunk(text);
    ctx.sendComplete(text);
  }

  private async handleNew(arg: string, ctx: CommandContext): Promise<void> {
    if (arg) {
      const resolved = resolve(arg.replace(/^~/, homedir()));
      if (!existsSync(resolved)) {
        this.reply(ctx, `路徑不存在: ${resolved}`);
        return;
      }
      this.cwdOverrides.set(ctx.conversationId, resolved);
    } else {
      this.cwdOverrides.delete(ctx.conversationId);
    }

    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    this.store.clearPersistedSession(ctx.conversationId);
    await this.store.destroySession(ctx.conversationId);

    this.reply(
      ctx,
      `已開啟新的工作階段\n工作目錄: ${cwd}${model ? `\n模型: ${model}` : ""}`,
    );
  }

  private handleSessions(ctx: CommandContext): void {
    const allSessions = this.store.listSessions();

    if (allSessions.length === 0) {
      this.reply(ctx, "目前沒有任何 session");
      return;
    }

    const lines = ["Sessions:\n"];
    for (const s of allSessions) {
      const status = s.alive ? "🟢" : "⚪";
      const id = s.sessionId.slice(0, 12);
      const model = s.model ?? "default";
      const tag = s.backend === "codex" ? "[codex]" : "[claude]";
      lines.push(`${status} ${id}  ${tag} ${model}  ${s.cwd}`);
    }
    lines.push("\n用法: /resume <session-id>");
    this.reply(ctx, lines.join("\n"));
  }

  private handleStatus(ctx: CommandContext): void {
    const entry = this.store.getSession(ctx.conversationId);

    if (!entry || !entry.process.isAlive()) {
      this.reply(ctx, "目前無活躍的 session\n發送任何訊息即可自動建立");
      return;
    }

    const backendLabel = entry.backend === "codex" ? "Codex CLI" : "Claude CLI";
    const lines = [
      `Backend: ${backendLabel}`,
      `狀態: ${entry.process.isAlive() ? "連線中" : "已停止"}`,
      `工作目錄: ${entry.process.getCwd() ?? this.config.defaultCwd}`,
      `Session ID: ${entry.process.getSessionId().slice(0, 12) || "N/A"}`,
      `模型: ${entry.process.getModel() ?? "default"}`,
    ];

    const cost = entry.process.getTotalCost();
    if (cost > 0) {
      lines.push(`累計花費: $${cost.toFixed(4)}`);
    }

    this.reply(ctx, lines.join("\n"));
  }

  private handleHelp(ctx: CommandContext): void {
    const lines = [
      "可用指令:\n",
      "/new [path] — 開新工作階段 (可帶路徑)",
      "/sessions — 列出所有 sessions",
      "/status — 查看目前 session 狀態",
      "/stop — 中斷目前正在執行的操作",
      "/resume [id] — 恢復 session",
      "/model [name] — 切換模型",
      "/cost — 顯示累計花費 / token 用量",
      "/compact — 壓縮對話上下文",
      "/help — 列出所有可用指令",
    ];
    this.reply(ctx, lines.join("\n"));
  }

  private handleStop(ctx: CommandContext): void {
    const entry = this.store.getSession(ctx.conversationId);
    if (entry?.process.isBusy()) {
      entry.process.abortTurn();
    }
    this.reply(ctx, "已中斷目前操作");
  }

  private async handleResume(arg: string, ctx: CommandContext): Promise<void> {
    if (!arg) {
      this.reply(ctx, "請提供 session ID\n用法: /resume <session-id>");
      return;
    }

    // Find full session ID from prefix
    const allSessions = this.store.listSessions();
    const match = allSessions.find((s) => s.sessionId.startsWith(arg));
    const sid = match?.sessionId ?? arg;

    const entry = await this.store.resumeSession(ctx.conversationId, sid);
    if (!entry) {
      this.reply(ctx, "恢復失敗\n用 /sessions 查看可用的 session ID");
      return;
    }

    this.reply(ctx, `已恢復 session: ${sid.slice(0, 12)}`);
  }

  private async handleModel(arg: string, ctx: CommandContext): Promise<void> {
    if (!arg) {
      const current = this.getModelForConversation(ctx.conversationId) ?? "default";
      const entry = this.store.getSession(ctx.conversationId);
      const backendLabel = entry ? (entry.backend === "codex" ? "Codex" : "Claude") : "";

      const models = this.store.listModels();
      const lines = [
        `目前模型: ${current}${backendLabel ? ` (${backendLabel})` : ""}`,
        "",
        "可用模型:",
        ...models.map((m) => {
          const active = m.id === current ? " ◀" : "";
          return `  [${m.backend}] ${m.id}${active}`;
        }),
        "",
        "用法: /model <name>",
      ];
      this.reply(ctx, lines.join("\n"));
      return;
    }

    // Check if backend type is changing
    const currentEntry = this.store.getSession(ctx.conversationId);
    const oldBackend = currentEntry?.backend;
    const newBackend = this.store.resolveBackend(arg);

    this.modelOverrides.set(ctx.conversationId, arg);

    // Clear persisted data if backend type changed
    if (oldBackend && oldBackend !== newBackend) {
      this.store.clearPersistedSession(ctx.conversationId);
    }

    await this.store.destroySession(ctx.conversationId);

    const backendLabel = newBackend === "codex" ? "Codex" : "Claude";
    this.reply(ctx, `已切換模型為 ${arg} (${backendLabel})\n下次對話將使用新模型（上下文已重置）`);
  }

  private async handleCompact(ctx: CommandContext): Promise<void> {
    const entry = this.store.getSession(ctx.conversationId);
    if (!entry || !entry.process.isAlive()) {
      this.reply(ctx, "目前無活躍的 session");
      return;
    }

    const sid = entry.process.getSessionId();
    if (!sid) {
      this.reply(ctx, "目前無活躍的 session");
      return;
    }

    const cwd = this.getCwdForConversation(ctx.conversationId);
    const model = this.getModelForConversation(ctx.conversationId);

    await this.store.destroySession(ctx.conversationId);
    this.store.createSession(ctx.conversationId, {
      cwd,
      model,
      resumeSessionId: sid,
      compact: true,
    });

    this.reply(ctx, "已壓縮對話上下文");
  }

  private handleCost(ctx: CommandContext): void {
    const entry = this.store.getSession(ctx.conversationId);
    if (!entry) {
      this.reply(ctx, "目前無使用資料");
      return;
    }

    const cost = entry.process.getTotalCost();
    if (cost <= 0) {
      this.reply(ctx, "目前無使用資料");
      return;
    }

    this.reply(ctx, `累計花費: $${cost.toFixed(4)} USD`);
  }
}
