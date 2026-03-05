#!/usr/bin/env node
/**
 * gh-copi — GitHub Copilot coding agent CLI
 *
 * Built on pi-mono coding agent framework with Copilot SDK as LLM backend.
 *
 * Usage:
 *   gh copi                          # Local mode (default)
 *   gh copi -c my-codespace          # Codespace mode
 *   gh copi --ssh user@host:/path    # SSH mode
 *   gh copi --devcontainer           # Devcontainer mode
 *   gh copi --resume                 # Resume previous session
 */
import { execSync } from "node:child_process";
import { CopilotClient } from "@github/copilot-sdk";
import {
  createAgentSession,
  InteractiveMode,
  AuthStorage,
  ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { Api } from "@mariozechner/pi-ai";

import { CopilotStreamBridge } from "./copilot-stream-bridge.js";
import { LocalTransport } from "./transport/local.js";
import { CodespaceTransport } from "./transport/codespace.js";
import { SSHTransport } from "./transport/ssh.js";
import { DevcontainerTransport } from "./transport/devcontainer.js";
import { TransportRegistry } from "./registry.js";
import { createRemoteTools } from "./remote-tools.js";

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

interface CliArgs {
  codespaces: string[];
  ssh?: { host: string; remotePath: string };
  devcontainer: boolean;
  resume: boolean;
  workdir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    codespaces: [],
    devcontainer: false,
    resume: false,
    workdir: process.cwd(),
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-c" || arg === "--codespace") {
      const val = argv[++i];
      if (val) args.codespaces.push(...val.split(","));
    } else if (arg === "--ssh") {
      const val = argv[++i];
      if (val) {
        const colonIdx = val.lastIndexOf(":");
        if (colonIdx > 0 && !val.startsWith("[")) {
          args.ssh = {
            host: val.slice(0, colonIdx),
            remotePath: val.slice(colonIdx + 1),
          };
        } else {
          args.ssh = { host: val, remotePath: "/workspace" };
        }
      }
    } else if (arg === "--devcontainer") {
      args.devcontainer = true;
    } else if (arg === "--resume") {
      args.resume = true;
    } else if (arg === "--workdir" || arg === "-w") {
      args.workdir = argv[++i] || process.cwd();
    }
  }

  return args;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // 1. Get GitHub token
  let token: string;
  try {
    token = execSync("gh auth token", { encoding: "utf-8" }).trim();
  } catch {
    console.error("Error: Not authenticated. Run `gh auth login` first.");
    process.exit(1);
  }

  // 2. Start Copilot SDK client
  const client = new CopilotClient({ logLevel: "error", githubToken: token });
  await client.start();

  // 3. Set up transport registry
  const registry = new TransportRegistry();
  let workdir = args.workdir;

  if (args.codespaces.length > 0) {
    for (const csName of args.codespaces) {
      const transport = new CodespaceTransport(csName);
      console.log(`Connecting to codespace: ${csName}...`);
      await transport.setup();
      registry.register(csName, transport);
    }
    // Detect remote workdir from first codespace
    const defaultTransport = registry.getDefault()!;
    const result = await defaultTransport.exec("pwd", "/workspaces");
    workdir = result.stdout.trim() || "/workspaces";
  } else if (args.ssh) {
    const transport = new SSHTransport({
      host: args.ssh.host,
      remotePath: args.ssh.remotePath,
    });
    console.log(`Connecting via SSH: ${args.ssh.host}...`);
    await transport.setup();
    registry.register("ssh", transport);
    workdir = args.ssh.remotePath;
  } else if (args.devcontainer) {
    const transport = new DevcontainerTransport({
      workspaceFolder: args.workdir,
      useDevcontainerCli: true,
    });
    console.log("Connecting to devcontainer...");
    await transport.setup();
    registry.register("devcontainer", transport);
    workdir = "/workspaces";
  } else {
    registry.register("local", new LocalTransport());
  }

  // 4. List available models from SDK
  const sdkModels = await client.listModels();
  const modelDefs = sdkModels.map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.capabilities.supports.reasoningEffort ?? false,
    input: (m.capabilities.supports.vision
      ? ["text", "image"]
      : ["text"]) as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.capabilities.limits.max_context_window_tokens,
    maxTokens: m.capabilities.limits.max_prompt_tokens || 16384,
  }));

  // 5. Set up auth + model registry
  const authStorage = AuthStorage.inMemory();
  authStorage.set("copilot-sdk", { type: "api_key", key: "copilot-sdk-managed" });

  const modelRegistry = new ModelRegistry(authStorage);
  const bridge = new CopilotStreamBridge({
    client,
    modelRegistry,
    providerName: "copilot-sdk",
  });

  modelRegistry.registerProvider("copilot-sdk", {
    api: "copilot-sdk-api" as Api,
    apiKey: token,
    baseUrl: "https://copilot-sdk-managed",
    streamSimple: bridge.createStreamFn(),
    models: modelDefs,
  });

  // 6. Select default model
  const preferredModels = [
    "claude-sonnet-4",
    "claude-sonnet-4.5",
    "gpt-4.1",
  ];
  let model = null;
  for (const id of preferredModels) {
    model = modelRegistry.find("copilot-sdk", id);
    if (model) break;
  }
  if (!model) {
    model = modelRegistry.find("copilot-sdk", sdkModels[0].id);
  }
  if (!model) {
    console.error("Error: No models available from Copilot SDK.");
    process.exit(1);
  }

  // 7. Create remote tools if not local
  const defaultTransport = registry.getDefault();
  const isRemote = defaultTransport && defaultTransport.name !== "local";

  // 8. Create pi-mono agent session
  const sessionOptions: any = {
    model,
    authStorage,
    modelRegistry,
    cwd: isRemote ? undefined : workdir,
  };

  if (isRemote) {
    const remoteTools = createRemoteTools(defaultTransport!, workdir);
    sessionOptions.customTools = remoteTools;
    sessionOptions.tools = []; // Don't use built-in local tools
  }

  const { session } = await createAgentSession(sessionOptions);

  // 9. Wire up tool result cache
  const origTools = session.agent.state.tools;
  const wrappedTools = origTools.map((t: any) => ({
    ...t,
    execute: async (
      toolCallId: string,
      params: any,
      signal?: AbortSignal,
      onUpdate?: any,
    ) => {
      const cached = bridge.getCachedResult(toolCallId);
      if (cached) return cached;
      return t.execute(toolCallId, params, signal, onUpdate);
    },
  }));
  session.agent.setTools(wrappedTools);

  // 10. Handle reload lifecycle
  const origReload = session.reload.bind(session);
  session.reload = async () => {
    await origReload();
    await bridge.handleReload(token, modelDefs);
    // Re-wrap tools after reload
    const newTools = session.agent.state.tools.map((t: any) => ({
      ...t,
      execute: async (
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: any,
      ) => {
        const cached = bridge.getCachedResult(toolCallId);
        if (cached) return cached;
        return t.execute(toolCallId, params, signal, onUpdate);
      },
    }));
    session.agent.setTools(newTools);
  };

  // 11. Launch interactive TUI
  const mode = registry.getDefault()?.name ?? "local";
  console.log(`\ngh-copi — ${mode} mode, model: ${model.name}\n`);

  const interactive = new InteractiveMode(session);
  await interactive.run();

  // 12. Cleanup
  await bridge.destroy();
  await registry.teardownAll();
  await client.stop();
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
