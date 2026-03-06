# Codespace Agent: Pi-mono + Copilot SDK — Validated Plan

> **Start here.** All key integration points have been prototype-tested and verified.
>
> - **This file**: Implementation plan, architecture, phases, code examples
> - **[LIMITATIONS.md](LIMITATIONS.md)**: Full audit of all 18 integration points (all ✅ CLEAN)
> - **[prototype/](prototype/)**: 21 validated probes + interactive TUI demo (run with `npx tsx`)

## Goal

Build on top of the **pi-mono coding agent framework** (`@mariozechner/pi-coding-agent`),
using **Copilot SDK** as the LLM backend (official, approved). Pi-mono owns:
- Agent loop, tool execution, session management
- TUI (its own `@mariozechner/pi-tui`, or replaced with OpenTUI later)
- Extension system (custom tools, slash commands, keybindings)

Copilot SDK provides:
- LLM access (models, auth, billing) via the official `copilot` CLI process
- No direct API calls to undocumented Copilot endpoints

Remote codespace operations are implemented as pi-mono tools/extensions.

## Validated Assumptions (from prototype testing)

All probes run with `@github/copilot-sdk` + Copilot CLI 0.0.422-0 + `@mariozechner/pi-coding-agent` 0.56.1.

| Capability | Status | Probe |
|---|---|---|
| CopilotClient spawns CLI via JSON-RPC | ✅ Verified | `probe1-basic.ts` |
| 17 models, 14 built-in tools listed | ✅ Verified | `probe1-basic.ts` |
| `overridesBuiltInTool` replaces built-in bash | ✅ Verified | `probe3-override-builtin.ts` |
| `availableTools` whitelist restricts model | ✅ Verified | `probe5-whitelist.ts` |
| Streaming events for TUI rendering | ✅ Verified | `probe4-events.ts` |
| `githubToken` bypasses Keychain | ✅ Verified | All probes |
| No built-in MCP servers in SDK | ✅ Verified | `probe9-mcp-servers.ts` |
| Clean `registerProvider()` (no monkey-patching) | ✅ Verified | `probe10-clean-provider.ts` |
| SDK-native tool calling (no XML parsing) | ✅ Verified | `probe11-native-tools.ts` |
| **No double execution, no double LLM call** | ✅ Verified | `probe14-final.ts` |
| **Pi-mono TUI sees tool events** | ✅ Verified | `probe14-final.ts` |
| **IDE MCP (selection, diagnostics, diffs)** | ✅ Verified | `probe18-ide-extension.ts` |
| **IDE selection auto-polling** | ✅ Verified | `probe19-ide-selection-poll.ts` |
| **Subagents, plan mode, code review, fleet** | ✅ Verified | `probe20-subagents.ts` |
| **Self-modification (create ext → reload → use)** | ✅ Verified | `probe21-self-modify.ts` |
| Pi-mono full TUI with Copilot SDK backend | ✅ Verified | `pi-tui-copilot.ts` |

### The Integration (probe 14 — the final solution)

Pi-mono's `ModelRegistry.registerProvider()` accepts a `streamSimple` function — the **official API**
for custom LLM providers. Our `streamSimple` bridge:

1. Registers pi-mono's `context.tools` as SDK tools with `overridesBuiltInTool: true`
2. SDK uses native function calling (proper `tool_calls`, not XML parsing)
3. When the LLM calls a tool, the SDK invokes our handler → we execute the pi-mono tool
4. We **cache** the tool result (keyed by `toolCallId`)
5. SDK feeds the result back to the LLM, gets the final response
6. We **cache** the final response text
7. `streamSimple` emits `toolcall_start/end` events → pi-mono TUI shows tool progress
8. Pi-mono's agent loop calls `tool.execute()` → **cache hit** (instant, no re-execution)
9. Pi-mono calls `streamSimple` again → **returns cached final response** (no second LLM call)

**Result: 1 LLM call, 1 tool execution, full TUI events, native function calling, zero hacks.**

### Key Facts

1. **Auth**: Use `OAuthProviderInterface` in `registerProvider()` wrapping `gh auth token`.
   Gives `/login`, token refresh, and credential persistence — all official pi-mono APIs.
2. **Pi-mono's `github-copilot` provider is unapproved** — reverse-engineered OAuth, spoofed
   VS Code headers, internal API. Do NOT use it. Use the Copilot SDK.
3. **No built-in MCP servers in SDK** — GitHub MCP tools come from config files, not the SDK.
   Add via `mcpServers` in SDK session config if needed.
4. **IDE integration**: VS Code runs an MCP server on a Unix socket (`~/.copilot/ide/*.lock`).
   Connect directly via `http.request()`, no SDK involvement needed. Supports `get_selection`,
   `get_diagnostics`, `open_diff`. Selection auto-polling replicates Copilot CLI behavior.
5. **All 17 integration points are ✅ CLEAN** — see `LIMITATIONS.md` for the full audit.
6. **Subagents, plan mode, and /review work** (probe 20): The SDK session must be persistent
   (not recreated per turn) for these features. Keep the session alive, only recreate on
   model/tool changes. Register custom agents via `customAgents` in session config.
   Switch modes via `session.rpc.mode.set()`. Select agents via `session.rpc.agent.select()`.

---

## Architecture (Option A — pi-mono owns the loop)

```
┌──────────────────────────────────────────────────────────────┐
│              Pi-mono Coding Agent Framework                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  InteractiveMode (TUI) — pi-tui or OpenTUI later      │  │
│  │  - Renders agent events (message_update, tool_exec)    │  │
│  │  - Slash commands, keybindings, themes                 │  │
│  │  - "!" shell escape → extension user_bash event        │  │
│  │  - IDE selection auto-injected via context event       │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │                                      │
│  ┌─────────────────────▼──────────────────────────────────┐  │
│  │  AgentSession (pi-mono)                                │  │
│  │  - Owns conversation state, compaction, branching      │  │
│  │  - Extension runner (tools, commands, events)          │  │
│  │  - Session persistence (SessionManager)                │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │                                      │
│  ┌─────────────────────▼──────────────────────────────────┐  │
│  │  Agent (pi-agent-core)                                 │  │
│  │  - Agent loop: prompt → LLM → tool calls → results    │  │
│  │  - streamFn dispatched via registerProvider()          │  │
│  │  - tool.execute() returns cached SDK results           │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │                                      │
│  ┌─────────────────────▼──────────────────────────────────┐  │
│  │  Copilot SDK Stream Bridge (registerProvider)          │  │
│  │  - Registers tools as SDK tools (native function call) │  │
│  │  - SDK handler executes tool, caches result            │  │
│  │  - SDK feeds result to LLM, caches final response      │  │
│  │  - Emits toolcall events for TUI rendering             │  │
│  │  - Next streamSimple call returns cached response       │  │
│  │  - Result: 1 LLM call, 1 tool exec, full TUI events   │  │
│  └─────────────────────┬──────────────────────────────────┘  │
│                        │ JSON-RPC (stdio)                     │
│  ┌─────────────────────▼──────────────────────────────────┐  │
│  │  Copilot CLI Process (--headless --stdio)              │  │
│  │  - Official auth, model routing, billing               │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Extensions (pi-mono extension API)                    │  │
│  │  - Remote tools (bash, edit, grep via SSH)             │  │
│  │  - IDE extension (MCP to VS Code Unix socket)          │  │
│  │  - Shell escape (user_bash → codespace picker)         │  │
│  │  - IDE selection auto-inject (context event)           │  │
│  │  - /attach command (setEditorText with @file)          │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Copilot SDK Stream Bridge for Pi-mono

**Goal**: Register a Copilot SDK-backed provider via `ModelRegistry.registerProvider()`.

This is the foundational piece. Everything else (TUI, tools, extensions) comes from pi-mono.

### The Bridge (validated in `probe14-final.ts`)

The `streamSimple` function registered via `registerProvider()`:

```typescript
// Key data structures for the caching mechanism
const toolResultCache = new Map<string, AgentToolResult>();  // toolCallId → result
let pendingFinalResponse: string | null = null;              // cached LLM response after tools

function copilotStreamSimple(model, context, options): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  (async () => {
    // If we have a cached final response from a previous tool cycle, return it immediately
    // (no LLM call — the SDK already got this response)
    if (pendingFinalResponse !== null) {
      emitCachedResponse(stream, model, pendingFinalResponse);
      pendingFinalResponse = null;
      return;
    }

    // Register pi-mono tools as SDK tools with native function calling
    const sdkTools = (context.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      overridesBuiltInTool: true,
      handler: async (args, invocation) => {
        // Execute the REAL tool implementation
        const result = await realToolExecute(tool.name, args);
        // Cache result so pi-mono's execute() can return it without re-executing
        toolResultCache.set(invocation.toolCallId, result);
        return result.textContent;
      },
    }));

    const sdkSession = await client.createSession({
      onPermissionRequest: approveAll,
      model: model.id,
      streaming: true,
      tools: sdkTools,
      availableTools: sdkTools.map(t => t.name),
      systemMessage: { mode: "replace", content: context.systemPrompt },
    });

    // Track text before and after tool execution
    let phase: "initial" | "after_tools" = "initial";
    let initialText = "", afterToolText = "";
    const toolCalls = [];

    sdkSession.on((event) => {
      if (event.type === "assistant.message_delta") {
        if (phase === "initial") { initialText += delta; emitTextDelta(stream, delta); }
        else { afterToolText += delta; }
      }
      if (event.type === "tool.execution_start") {
        toolCalls.push(event.data);
      }
      if (event.type === "tool.execution_complete") {
        phase = "after_tools";  // Next deltas are the final answer
      }
      if (event.type === "session.idle") {
        if (toolCalls.length > 0) {
          pendingFinalResponse = afterToolText;  // Cache for next streamSimple call
          emitToolCallEvents(stream, toolCalls);  // Pi-mono TUI shows progress
          stream.end({ stopReason: "toolUse" });
        } else {
          stream.end({ stopReason: "stop" });
        }
      }
    });

    await sdkSession.send({ prompt: serializeConversation(context) });
  })();

  return stream;
}
```

The full working implementation is in `probe14-final.ts` (~200 LOC including all event handling).

**Important: Keep the SDK session persistent.** Probe 14 recreates per turn, but subagents,
plan mode, and agent selection (probe 20) need a persistent session. The bridge should reuse
the session and only recreate on model/tool changes:

```typescript
// In streamSimple:
if (!sdkSession || modelChanged(model) || toolsChanged(context.tools)) {
  if (sdkSession) await sdkSession.destroy();
  sdkSession = await client.createSession({
    model: model.id, tools: sdkTools, customAgents: [...],
    // ... keep same config
  });
} else {
  // Reuse existing session — subagents/plan/agents persist
}
await sdkSession.send({ prompt });
```

### Registration (no hacks)

```typescript
modelRegistry.registerProvider("copilot-sdk", {
  api: "copilot-sdk-api",
  apiKey: ghToken,
  streamSimple: copilotStreamSimple,
  oauth: { /* wraps gh auth for /login support */ },
  models: sdkModels.map(m => ({ /* ... */ })),
});
```

### Pi-mono tool execute() uses cache

```typescript
// In tool registration:
customTools: [{
  name: "bash",
  execute: async (toolCallId, params) => {
    const cached = toolResultCache.get(toolCallId);
    if (cached) {
      toolResultCache.delete(toolCallId);
      return cached;  // Instant — SDK already executed this
    }
    return realExecute(params);  // Fallback (shouldn't happen)
  },
}]
```

### Integration with pi-mono's `createAgentSession()`

```typescript
import { createAgentSession, createCodingTools } from "@mariozechner/pi-coding-agent";
import { CopilotClient } from "@github/copilot-sdk";
import { CopilotStreamBridge } from "./copilot-stream-bridge.js";

const client = new CopilotClient({ githubToken: token, logLevel: "error" });
await client.start();

const bridge = new CopilotStreamBridge(client);

// Create a pi-mono model object (the bridge handles actual routing)
const copilotModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  api: "openai-completions" as Api,
  provider: "github-copilot",
  baseUrl: "",  // Not used — bridge handles routing
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 16384,
};

const { session } = await createAgentSession({
  model: copilotModel,
  tools: createCodingTools("/path/to/workdir"),  // Or custom remote tools
  // The key: override the stream function
});

// Override the agent's streamFn AFTER creation
session.agent.streamFn = bridge.createStreamFn();
```

### Alternative: Use `Agent` directly (simpler for prototype)

```typescript
import { Agent } from "@mariozechner/pi-agent-core";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a coding assistant working on a remote codespace.",
    model: copilotModel,
    thinkingLevel: "off",
    tools: remoteTools,  // Pi-mono AgentTool[] for codespace ops
  },
  streamFn: bridge.createStreamFn(),
  getApiKey: async () => token,  // Not actually used by bridge, but required
});

// Use pi-mono's interactive mode for TUI
import { InteractiveMode } from "@mariozechner/pi-coding-agent";
// Or just do: await agent.prompt("Hello");
```

---

## Phase 2: Remote Codespace Tools as Pi-mono AgentTools

**Goal**: Implement codespace file/bash operations as pi-mono `AgentTool` objects.

Pi-mono tools use TypeBox schemas and return `AgentToolResult`:

```typescript
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const BashParams = Type.Object({
  command: Type.String({ description: "Bash command to execute on the codespace" }),
  description: Type.Optional(Type.String({ description: "What this command does" })),
});

export function createRemoteBashTool(ssh: CodespaceSSH): AgentTool {
  return {
    name: "bash",
    label: "Remote Bash",
    description: `Execute bash on codespace "${ssh.codespaceName}"`,
    parameters: BashParams,
    execute: async (toolCallId, params: Static<typeof BashParams>) => {
      const result = await ssh.exec(`cd ${ssh.workdir} && ${params.command}`);
      return {
        content: [{ type: "text", text: result.stdout || result.stderr || "(no output)" }],
        details: { exitCode: result.exitCode, command: params.command },
      };
    },
  };
}
```

Repeat for `read`, `edit`, `write`, `grep`, `find`, `ls` — matching pi-mono's built-in tool interfaces.

### Transport Abstraction

Remote tools are backed by a transport interface. This supports codespaces, SSH, devcontainers,
and any future target:

```typescript
interface RemoteTransport {
  name: string;  // Display name (e.g., "codespace:my-cs", "ssh:user@host")
  exec(command: string, cwd: string, options?: {
    onData?: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  forwardSocket?(localPath: string, remotePath: string): Promise<void>;
  cancelForward?(localPath: string, remotePath: string): void;
}
```

Implementations:

| Transport | Backing | How it works |
|-----------|---------|-------------|
| `CodespaceTransport` | `gh cs ssh` + ControlMaster | SSH multiplexing via `gh codespace ssh --config` |
| `SSHTransport` | `ssh user@host` | Direct SSH with ControlMaster |
| `DevcontainerTransport` | `docker exec` or `devcontainer exec` | Local devcontainer |
| `LocalTransport` | `child_process.spawn` | Default — pi-mono's built-in tools |

### SSH Multiplexing (ported from gh-copilot-codespace)

The Go SSH client in `gh-copilot-codespace/internal/ssh/client.go` uses OpenSSH
ControlMaster for connection reuse (~0.1s vs ~3s per command). The approach ports
directly to TypeScript since it shells out to `ssh` / `gh`:

```typescript
class CodespaceTransport implements RemoteTransport {
  private sshConfigPath?: string;
  private sshHost?: string;
  private controlSocket?: string;

  async setupMultiplexing() {
    // 1. Get SSH config: gh codespace ssh --config -c <name>
    // 2. Add ControlPath + ControlPersist to config
    // 3. Establish master: ssh -F config -o ControlMaster=yes -o ControlPersist=600 -fN host
    // 4. All subsequent exec() calls use: ssh -F config host -- command
    //    (reuses master connection, ~0.1s latency)
  }

  async exec(command: string, cwd: string) {
    // ssh -F configPath host -- bash -c "cd cwd && command"
  }

  async forwardSocket(localPath: string, remotePath: string) {
    // ssh -F configPath -O forward -L localPath:remotePath host
    // Used for IDE socket forwarding and MCP server forwarding
  }
}
```

This is the same multiplexing strategy used in gh-copilot-codespace today.
Nothing new to invent — just port from Go to TypeScript (the Go code shells
out to `ssh`/`gh` commands, which works identically from Node.js).

---

## Phase 3: IDE Integration

Build a pi-mono extension that:
1. Discovers IDE lock files at `~/.copilot/ide/` (validated in probes 18-19)
2. Connects to VS Code's MCP server via Unix socket (MCP Streamable HTTP)
3. Registers tools: `get_diagnostics`, `open_diff` (LLM-callable)
4. Auto-polls `get_selection` via `ctx.on("context", ...)` for selection injection
5. Registers `/attach` command for explicit file attachment via `ctx.ui.setEditorText()`
6. For remote codespaces: forwards IDE sockets via `transport.forwardSocket()`

---

## Phase 4: OpenTUI Integration

Replace `@mariozechner/pi-tui` with OpenTUI for the rendering layer. Pi-mono's `InteractiveMode`
has a component-based architecture that maps to OpenTUI's React reconciler.

---

## Phase 5: Multi-Target + Pi-mono Extensions

- Multi-target: registry of `RemoteTransport` instances, lifecycle tools
- Extensions: pi-mono's `discoverAndLoadExtensions()` + `ExtensionRunner`
- Custom slash commands via pi-mono's extension command system
- `!` shell escape → `user_bash` event → target picker (if multiple connected)

---

## Usage Modes

```bash
# Local mode (default) — pi-mono's built-in tools, no remote connection
gh pico

# Codespace mode — tools execute on codespace via SSH
gh pico -c my-codespace

# Multi-codespace — tools route by alias, picker on ambiguity
gh pico -c cs1,cs2

# SSH target — tools execute on any SSH host
gh pico --ssh user@host:/path/to/project

# Devcontainer — tools execute inside local devcontainer
gh pico --devcontainer

# Resume previous session
gh pico --resume
```

---

## File Structure

```
gh-pico/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts                    # Entry point, CLI args, mode selection
│   ├── copilot-stream-bridge.ts   # Bridges Copilot SDK → pi-ai events
│   ├── transport/
│   │   ├── types.ts               # RemoteTransport interface
│   │   ├── local.ts               # Default — no remote, pi-mono built-in tools
│   │   ├── codespace.ts           # gh cs ssh + ControlMaster multiplexing
│   │   ├── ssh.ts                 # Direct SSH transport
│   │   └── devcontainer.ts        # docker exec / devcontainer exec
│   ├── remote-tools.ts            # Pi-mono AgentTools backed by RemoteTransport
│   ├── ide-extension.ts           # IDE MCP connection + selection polling
│   ├── codespace-extension.ts     # Lifecycle tools, /cs command, ! picker
│   └── registry.ts                # Multi-target registry
```

## Key Dependencies

```json
{
  "dependencies": {
    "@github/copilot-sdk": "latest",
    "@mariozechner/pi-coding-agent": "^0.56",
    "@mariozechner/pi-agent-core": "^0.56",
    "@mariozechner/pi-ai": "^0.56",
    "@mariozechner/pi-tui": "^0.56"
  },
  "devDependencies": {
    "tsx": "latest",
    "typescript": "^5.7"
  }
}
```

## What NOT To Do

1. **Don't use pi-mono's `github-copilot` provider** — it's unapproved (reverse-engineered OAuth, spoofed VS Code headers, internal API).
2. **Don't use XML tool-call parsing** — probes 10/8 used this; probe 14 replaced it with SDK-native function calling + result caching. No XML needed.
3. **Don't let pi-mono execute tools twice** — use the `toolResultCache` pattern from probe 14 so pi-mono's `execute()` returns the cached SDK result instantly.

## Gotchas (from prototype testing)

1. **`session.reload()` resets the API registry and invalidates the SDK session.**
   The bridge must hook into the reload lifecycle:
   ```typescript
   // After session.reload():
   modelRegistry.registerProvider("copilot-sdk", { ... });  // re-register provider
   sdkSession = null;  // force new SDK session on next turn (picks up new tools)
   ```
   Both are one-liners but forgetting either causes crashes (`No API provider` or
   `tool not found` errors). Build this into the bridge class, not as caller responsibility.

2. **LLM-generated extensions may have wrong signatures.** The LLM sometimes writes
   `execute(params)` instead of `execute(toolCallId, params, signal, onUpdate)`.
   In the real TUI the LLM sees the error and self-corrects on retry. Consider
   including a condensed extension template in the system prompt to reduce first-attempt failures.

## Quick Start (Copy-Paste for New Session)

```
I want to build a TypeScript CLI tool called "gh-pico" built on top of the
pi-mono coding agent framework (@mariozechner/pi-coding-agent) with Copilot SDK
(@github/copilot-sdk) as the LLM backend.

The tool works in multiple modes:
- Local mode (default): pi-mono's built-in tools, no remote connection
- Codespace mode (-c name): tools execute on GitHub Codespace via SSH
- SSH mode (--ssh user@host): tools execute on any SSH target
- Devcontainer mode (--devcontainer): tools execute in local devcontainer

Architecture (pi-mono owns the agent loop, persistent SDK session):
- Register "copilot-sdk" provider via ModelRegistry.registerProvider() with streamSimple
- streamSimple bridge: register tools as SDK tools (native function calling),
  cache tool results + final response to avoid double execution/LLM calls
- Transport abstraction: RemoteTransport interface with exec() + forwardSocket()
- IDE extension: connects to VS Code MCP server at ~/.copilot/ide/*.lock
- Session.reload() after extension creation (re-register provider after reload)

The project directory has PLAN.md, LIMITATIONS.md, and prototype/ with validated probes:
- probe14-final.ts: complete bridge (native tools, caching, no double exec)
- probe20-subagents.ts: subagents, plan mode, code review, fleet
- probe21-self-modify.ts: LLM creates extension → reload → uses new tool
- pi-tui-copilot.ts: full pi-mono TUI on Copilot SDK

Start with Phase 1: the copilot-stream-bridge module, then transport abstraction.
```
