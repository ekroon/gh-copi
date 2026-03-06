# Copilot Instructions for gh-pico

## Commands

```bash
npm run build          # TypeScript → dist/
npm run dev            # Run via tsx (no build needed)
npm test               # All tests (vitest)
npx vitest run src/__tests__/registry.test.ts              # Single test file
npx vitest run -t "should parse comma-separated"           # Single test by name
```

## Architecture

gh-pico is a CLI tool that wires **two frameworks together**: the pi-mono coding agent framework provides the agent loop, TUI, tools, and session management; the Copilot SDK provides LLM access. The key integration point is `CopilotStreamBridge`.

### The Bridge (copilot-stream-bridge.ts)

Pi-mono calls `streamSimple()` to get LLM responses. The bridge translates this into Copilot SDK calls, handling two critical problems:

1. **No double execution**: When the LLM calls a tool, the SDK handler executes it and caches the result (keyed by `toolCallId`). When pi-mono's agent loop later calls `tool.execute()` for the same tool call, it gets the cached result instantly.

2. **No double LLM call**: After the SDK processes tool results and gets the final text, that text is cached. The next `streamSimple()` call returns the cached response instead of making another LLM call.

The SDK session is **persistent** across turns (required for subagents, plan mode, review). It's only recreated when the model or tool set changes.

### Transport Layer (transport/)

`RemoteTransport` is an interface with `exec()`, `readFile()`, `writeFile()`, `exists()`. Four implementations exist: `LocalTransport` (child_process), `CodespaceTransport` (gh cs ssh + ControlMaster), `SSHTransport`, `DevcontainerTransport`. The remote tools in `remote-tools.ts` are `AgentTool` objects that delegate to whatever transport is active.

### Extension System

`codespace-extension.ts` and `ide-extension.ts` are pi-mono extensions. They use the pi-mono extension API (`ctx.on()`, `ctx.registerTool()`, `ctx.registerCommand()`). The codespace extension intercepts `user_bash` events to route shell commands to the active transport. The IDE extension discovers VS Code's MCP server via lock files at `~/.copilot/ide/`.

## Conventions

- **ESM only**: `"type": "module"` in package.json. All imports use `.js` extensions even for `.ts` source files.
- **TypeBox for schemas**: Tool parameter schemas use `@sinclair/typebox` (`Type.Object()`, `Type.String()`, etc.), not raw JSON Schema.
- **Pi-mono types come from specific packages**: `AgentTool`/`AgentToolResult` from `@mariozechner/pi-agent-core`, stream types from `@mariozechner/pi-ai`, session/registry types from `@mariozechner/pi-coding-agent`.
- **`AuthStorage.inMemory()`**: Constructor is private. Use static factory methods: `AuthStorage.inMemory()`, `AuthStorage.create()`, `AuthStorage.fromStorage()`.
- **`createAssistantMessageEventStream()`**: The class is exported as `export type` only. Use the factory function to create instances.
- **Reload lifecycle**: `session.reload()` resets the API provider registry. After any reload, the bridge must re-register the provider and destroy the SDK session. This is handled in `bridge.handleReload()`.
- **Test pattern**: Tests use concrete implementations of interfaces (e.g., `InMemoryTransport`) rather than mocking frameworks. No `vi.fn()` usage.
- **Never use pi-mono's `github-copilot` provider**: It uses reverse-engineered OAuth and spoofed VS Code headers. All LLM access goes through the Copilot SDK.
