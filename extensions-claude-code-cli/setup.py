#!/usr/bin/env python3
"""
OpenClaw Claude Code CLI Extension — Setup Script

Configures a fresh machine to use the Claude Code CLI bridge as an OpenClaw provider.
Run from the extension directory:
    python setup.py

What it does:
  1. Adds this extension to openclaw.json plugins.load.paths (external plugin)
  2. Creates ~/.claude/bridge-mcp.json with MCP servers for extended capabilities
  3. Configures mcpConfigPath in the plugin entry
  4. Adds claude-code-cli model provider to openclaw.json
  5. Registers the model in agents.defaults.models

Prerequisites:
  - OpenClaw installed and onboarded (~/.openclaw/openclaw.json exists)
  - Claude Code CLI installed and logged in (`claude --version`)
  - Node.js / npx available (for MCP servers)
"""

import json
import sys
from pathlib import Path

OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"
MCP_CONFIG = Path.home() / ".claude" / "bridge-mcp.json"
BRIDGE_PORT = 18810
EXTENSION_DIR = Path(__file__).parent.resolve()


def load_json(path: Path) -> dict:
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def create_mcp_config() -> None:
    """Create ~/.claude/bridge-mcp.json with MCP servers that extend Claude Code's capabilities."""
    config = {
        "mcpServers": {
            "playwright": {
                "command": "npx",
                "args": ["@playwright/mcp@latest"],
            },
        },
    }
    save_json(MCP_CONFIG, config)
    print(f"  [ok] MCP config written to {MCP_CONFIG}")


def patch_openclaw_config() -> None:
    """Patch ~/.openclaw/openclaw.json with plugin, model, and agent configuration."""
    if not OPENCLAW_CONFIG.exists():
        print(f"  [!!] {OPENCLAW_CONFIG} not found. Run `openclaw` first to create it.")
        sys.exit(1)

    config = load_json(OPENCLAW_CONFIG)
    ext_path = str(EXTENSION_DIR)

    # --- plugins.load.paths ---
    plugins = config.setdefault("plugins", {})
    load = plugins.setdefault("load", {})
    paths: list = load.setdefault("paths", [])
    if ext_path not in paths:
        paths.append(ext_path)
        print(f"  [ok] Added extension path to plugins.load.paths")
    else:
        print(f"  [--] Extension path already in plugins.load.paths")

    # --- plugins.entries.claude-code-cli ---
    entries = plugins.setdefault("entries", {})
    entries["claude-code-cli"] = {
        "enabled": True,
        "config": {
            "mcpConfigPath": str(MCP_CONFIG),
        },
    }
    print(f"  [ok] Plugin entry configured with mcpConfigPath")

    # --- models.providers.claude-code-cli ---
    models = config.setdefault("models", {})
    if "mode" not in models:
        models["mode"] = "merge"
    providers = models.setdefault("providers", {})
    providers["claude-code-cli"] = {
        "baseUrl": f"http://127.0.0.1:{BRIDGE_PORT}/v1",
        "apiKey": "local",
        "api": "openai-completions",
        "authHeader": False,
        "models": [
            {
                "id": "claude-code-cli",
                "name": "Claude Code CLI",
                "api": "openai-completions",
                "reasoning": False,
                "input": ["text"],
                "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                "contextWindow": 200000,
                "maxTokens": 16384,
            }
        ],
    }
    print(f"  [ok] Model provider claude-code-cli configured (port {BRIDGE_PORT})")

    # --- agents.defaults.models + streaming ---
    agents = config.setdefault("agents", {})
    defaults = agents.setdefault("defaults", {})
    agent_models = defaults.setdefault("models", {})
    agent_models["claude-code-cli/claude-code-cli"] = {}
    print(f"  [ok] Model registered in agents.defaults.models")

    # --- agents.defaults block streaming ---
    defaults["blockStreamingDefault"] = "on"
    defaults["blockStreamingCoalesce"] = {
        "minChars": 100,
        "idleMs": 500,
    }
    defaults["blockStreamingChunk"] = {
        "minChars": 100,
        "maxChars": 4000,
        "breakPreference": "paragraph",
    }
    print(f"  [ok] Block streaming enabled (minChars=100, idleMs=500ms)")

    save_json(OPENCLAW_CONFIG, config)
    print(f"  [ok] Config saved to {OPENCLAW_CONFIG}")


def verify_prerequisites() -> None:
    """Check that required tools are available."""
    import shutil

    issues = []

    if not shutil.which("claude"):
        issues.append("claude CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code")

    if not shutil.which("npx"):
        issues.append("npx not found. Install Node.js: https://nodejs.org/")

    if not OPENCLAW_CONFIG.exists():
        issues.append(f"{OPENCLAW_CONFIG} not found. Run `openclaw` first to onboard.")

    # Check extension files exist
    required = ["index.ts", "bridge-server.ts", "claude-process.ts",
                "package.json", "openclaw.plugin.json"]
    missing = [f for f in required if not (EXTENSION_DIR / f).exists()]
    if missing:
        issues.append(f"Missing extension files: {', '.join(missing)}")

    if issues:
        print("\nPrerequisite issues found:")
        for issue in issues:
            print(f"  [!!] {issue}")
        print()
        resp = input("Continue anyway? [y/N] ").strip().lower()
        if resp != "y":
            sys.exit(1)


def main() -> None:
    print(f"\n=== OpenClaw Claude Code CLI Extension Setup ===\n")
    print(f"Extension: {EXTENSION_DIR}")
    print(f"Config:    {OPENCLAW_CONFIG}")
    print(f"MCP:       {MCP_CONFIG}")
    print()

    verify_prerequisites()

    print("1. Creating MCP config...")
    create_mcp_config()

    print("\n2. Patching OpenClaw config...")
    patch_openclaw_config()

    print(f"""
=== Setup Complete ===

Next steps:
  1. Start OpenClaw gateway:
       cd <openclaw-dir> && pnpm openclaw gateway --verbose

  2. Check logs for:
       "claude-code-cli bridge started on port {BRIDGE_PORT}"

  3. To use as primary model, set in openclaw.json:
       "agents.defaults.model.primary": "claude-code-cli/claude-code-cli"

  4. Or assign to a specific agent only:
       "agents.list.<agentId>.model.primary": "claude-code-cli/claude-code-cli"

  5. Send a message via Telegram to test!
""")


if __name__ == "__main__":
    main()
