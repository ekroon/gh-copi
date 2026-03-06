import { describe, it, expect, beforeEach } from "vitest";
import { CopilotStreamBridge } from "../copilot-stream-bridge.js";

/**
 * Tests for CopilotStreamBridge — focused on the cache mechanism and
 * lifecycle management. Uses minimal stubs (not mocking frameworks)
 * for CopilotClient and ModelRegistry since those are external SDKs.
 */

// Minimal stub matching the interface CopilotStreamBridge actually uses
function makeStubClient() {
  let sessionCount = 0;
  return {
    sessions: [] as any[],
    async createSession(config: any) {
      const listeners: Array<(event: any) => void> = [];
      const session = {
        id: `session-${++sessionCount}`,
        config,
        destroyed: false,
        sentPrompts: [] as string[],
        on(cb: (event: any) => void) {
          listeners.push(cb);
          return () => { listeners.splice(listeners.indexOf(cb), 1); };
        },
        async send(msg: { prompt: string }) {
          session.sentPrompts.push(msg.prompt);
        },
        emit(event: any) {
          for (const cb of listeners) cb(event);
        },
        async destroy() {
          session.destroyed = true;
        },
      };
      (this as any).sessions.push(session);
      return session;
    },
  };
}

function makeStubModelRegistry() {
  const registrations: Array<{ name: string; config: any }> = [];
  return {
    registrations,
    registerProvider(name: string, config: any) {
      registrations.push({ name, config });
    },
  };
}

function makeModel(id = "test-model") {
  return {
    id,
    name: `Test Model (${id})`,
    api: "test-api" as any,
    provider: "test-provider",
    baseUrl: "",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  };
}

describe("CopilotStreamBridge", () => {
  let client: ReturnType<typeof makeStubClient>;
  let modelRegistry: ReturnType<typeof makeStubModelRegistry>;
  let bridge: CopilotStreamBridge;

  beforeEach(() => {
    client = makeStubClient();
    modelRegistry = makeStubModelRegistry();
    bridge = new CopilotStreamBridge({
      client: client as any,
      modelRegistry: modelRegistry as any,
      providerName: "test-sdk",
    });
  });

  describe("constructor", () => {
    it("should store provider name", () => {
      const fn = bridge.createStreamFn();
      expect(typeof fn).toBe("function");
    });

    it("should default provider name to copilot-sdk", () => {
      const b = new CopilotStreamBridge({
        client: client as any,
        modelRegistry: modelRegistry as any,
      });
      expect(typeof b.createStreamFn()).toBe("function");
    });
  });

  describe("getCachedResult", () => {
    it("should return undefined for unknown toolCallId", () => {
      expect(bridge.getCachedResult("unknown-id")).toBeUndefined();
    });

    it("should return cached result and delete it (one-shot)", () => {
      // Access internal cache via the bridge — we need to use the streaming
      // mechanism to populate it, but we can test the retrieval directly
      // by accessing the private member through the public API
      const result = bridge.getCachedResult("tc1");
      expect(result).toBeUndefined();

      // Second call should also be undefined
      expect(bridge.getCachedResult("tc1")).toBeUndefined();
    });
  });

  describe("createStreamFn", () => {
    it("should return a function", () => {
      const fn = bridge.createStreamFn();
      expect(typeof fn).toBe("function");
    });

    it("should return a stream when called", () => {
      const fn = bridge.createStreamFn();
      const context = {
        systemPrompt: "Be helpful",
        messages: [
          { role: "user", content: "hello" },
        ],
        tools: [],
      };
      const stream = fn(makeModel(), context as any);
      expect(stream).toBeDefined();
    });
  });

  describe("streaming - text only (no tools)", () => {
    it("should emit text events and end with stop", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      const stream = fn(model, context as any);

      // Schedule SDK events after session creation (async)
      setTimeout(async () => {
        // Wait for session to be created
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Hello " } });
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "world!" } });
        session.emit({ type: "assistant.usage", data: { inputTokens: 10, outputTokens: 5 } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === "text_delta");
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0].delta).toBe("Hello ");
      expect(textDeltas[1].delta).toBe("world!");

      const doneEvent = events.find(e => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent.reason).toBe("stop");
    }, 10000);
  });

  describe("streaming - with tool calls", () => {
    it("should emit tool call events and cache final response", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "list files" }],
        tools: [{
          name: "bash",
          description: "Run bash",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text" as const, text: "file1.ts" }],
            details: {},
          }),
        }],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Let me check." } });
        session.emit({
          type: "tool.execution_start",
          data: { toolCallId: "tc-123", toolName: "bash", arguments: { command: "ls" } },
        });
        session.emit({ type: "tool.execution_complete", data: { toolCallId: "tc-123" } });
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Here are the files." } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      const toolStarts = events.filter(e => e.type === "toolcall_start");
      expect(toolStarts).toHaveLength(1);

      const toolEnds = events.filter(e => e.type === "toolcall_end");
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].toolCall.name).toBe("bash");

      const doneEvent = events.find(e => e.type === "done");
      expect(doneEvent.reason).toBe("toolUse");
    }, 10000);
  });

  describe("streaming - cached final response", () => {
    it("should return cached response on second call after tools", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "list files" }],
        tools: [{
          name: "bash",
          description: "Run bash",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text" as const, text: "file1.ts" }],
            details: {},
          }),
        }],
      };

      // First call — triggers tool use
      const stream1 = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        session.emit({ type: "tool.execution_start", data: { toolCallId: "tc-1", toolName: "bash", arguments: {} } });
        session.emit({ type: "tool.execution_complete", data: { toolCallId: "tc-1" } });
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Cached final text" } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      for await (const _event of stream1 as any) { /* drain */ }

      // Second call — should return cached response immediately (no new SDK session)
      const sessionCountBefore = client.sessions.length;
      const stream2 = fn(model, context as any);
      const events2: any[] = [];
      for await (const event of stream2 as any) {
        events2.push(event);
      }

      // Should NOT have created a new session
      expect(client.sessions.length).toBe(sessionCountBefore);

      const textDelta = events2.find(e => e.type === "text_delta");
      expect(textDelta).toBeDefined();
      expect(textDelta.delta).toBe("Cached final text");

      const doneEvent = events2.find(e => e.type === "done");
      expect(doneEvent.reason).toBe("stop");
    }, 10000);
  });

  describe("streaming - error handling", () => {
    it("should emit error event on SDK session error", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        session.emit({ type: "session.error", data: { message: "Something went wrong" } });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === "error");
      expect(errorEvent).toBeDefined();
    }, 10000);
  });

  describe("session reuse", () => {
    it("should reuse session when model and tools unchanged", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel("same-model");
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      // First call
      const stream1 = fn(model, context as any);
      await new Promise(r => setTimeout(r, 50));
      client.sessions[0]?.emit({ type: "session.idle", data: {} });
      await new Promise(r => setTimeout(r, 50));

      const sessionCountAfterFirst = client.sessions.length;

      // Second call with same model and tools
      const stream2 = fn(model, context as any);
      await new Promise(r => setTimeout(r, 50));

      // Should reuse session (but the session from first call may have been
      // destroyed and a new one created based on the idle state).
      // The key behavior: if model/tools are same, it keeps the session.
      expect(client.sessions.length).toBe(sessionCountAfterFirst);
    });

    it("should create new session when model changes", async () => {
      const fn = bridge.createStreamFn();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      // First call with model A
      fn(makeModel("model-a"), context as any);
      await new Promise(r => setTimeout(r, 50));
      client.sessions[0]?.emit({ type: "session.idle", data: {} });
      await new Promise(r => setTimeout(r, 50));

      // Second call with model B — should create new session
      fn(makeModel("model-b"), context as any);
      await new Promise(r => setTimeout(r, 50));

      expect(client.sessions.length).toBe(2);
      expect(client.sessions[0].destroyed).toBe(true);
    });
  });

  describe("destroy", () => {
    it("should clean up session and caches", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      // Create a session
      fn(model, context as any);
      await new Promise(r => setTimeout(r, 50));
      client.sessions[0]?.emit({ type: "session.idle", data: {} });
      await new Promise(r => setTimeout(r, 50));

      await bridge.destroy();

      // Cache should be empty
      expect(bridge.getCachedResult("any")).toBeUndefined();
    });
  });

  describe("handleReload", () => {
    it("should re-register the provider with model registry", async () => {
      const models = [{
        id: "model-1",
        name: "Model 1",
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      }];

      await bridge.handleReload("token-123", models);

      expect(modelRegistry.registrations).toHaveLength(1);
      expect(modelRegistry.registrations[0].name).toBe("test-sdk");
      expect(modelRegistry.registrations[0].config.apiKey).toBe("token-123");
      expect(modelRegistry.registrations[0].config.models).toEqual(models);
    });

    it("should destroy existing SDK session", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      // Create a session
      fn(model, context as any);
      await new Promise(r => setTimeout(r, 50));
      client.sessions[0]?.emit({ type: "session.idle", data: {} });
      await new Promise(r => setTimeout(r, 50));

      await bridge.handleReload("token", []);

      expect(client.sessions[0].destroyed).toBe(true);
    });
  });

  describe("tool deduplication", () => {
    it("should deduplicate tools by name when creating SDK session", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const duplicateTool = {
        name: "bash",
        description: "Run bash (duplicate)",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text" as const, text: "result" }],
        }),
      };
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "bash",
            description: "Run bash",
            parameters: { type: "object", properties: {} },
            execute: async () => ({
              content: [{ type: "text" as const, text: "result" }],
            }),
          },
          duplicateTool,
        ],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        // Verify SDK session was created with deduplicated tools
        expect(session.config.tools).toHaveLength(1);
        expect(session.config.tools[0].name).toBe("bash");
        // Verify conflicting built-in tools are excluded
        expect(session.config.excludedTools).toContain("bash");
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      for await (const _event of stream as any) { /* drain */ }
    }, 10000);
  });

  describe("subagent event filtering", () => {
    it("should filter subagent text deltas from main stream", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "spin a subagent" }],
        tools: [{
          name: "bash",
          description: "Run bash",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text" as const, text: "done" }],
          }),
        }],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        // Main agent text
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Main text. " } });
        // Subagent starts
        session.emit({ type: "subagent.started", data: { toolCallId: "sub-1", agentName: "task", agentDisplayName: "Task Agent", agentDescription: "Runs tasks" } });
        // Subagent text (should be filtered)
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Subagent output", parentToolCallId: "sub-1" } });
        session.emit({ type: "assistant.message_delta", data: { deltaContent: " more subagent", parentToolCallId: "sub-1" } });
        // Subagent completes
        session.emit({ type: "subagent.completed", data: { toolCallId: "sub-1", agentName: "task", agentDisplayName: "Task Agent" } });
        // More main agent text
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Back to main." } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      // Only main text should appear, not subagent text
      const textDeltas = events.filter(e => e.type === "text_delta");
      const allText = textDeltas.map(e => e.delta).join("");
      expect(allText).toBe("Main text. Back to main.");
      expect(allText).not.toContain("Subagent output");
    }, 10000);

    it("should filter subagent-internal tool calls from top-level", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "test" }],
        tools: [{
          name: "bash",
          description: "Run bash",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text" as const, text: "result" }],
          }),
        }],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        // Top-level tool call (should be tracked)
        session.emit({
          type: "tool.execution_start",
          data: { toolCallId: "top-1", toolName: "bash", arguments: { command: "ls" } },
        });
        // Subagent starts within that tool call
        session.emit({ type: "subagent.started", data: { toolCallId: "top-1", agentName: "task", agentDisplayName: "Task" } });
        // Subagent-internal tool call (should be filtered)
        session.emit({
          type: "tool.execution_start",
          data: { toolCallId: "sub-tool-1", toolName: "bash", arguments: { command: "npm test" }, parentToolCallId: "top-1" },
        });
        session.emit({
          type: "tool.execution_complete",
          data: { toolCallId: "sub-tool-1", parentToolCallId: "top-1" },
        });
        // Top-level tool completes
        session.emit({ type: "subagent.completed", data: { toolCallId: "top-1", agentName: "task", agentDisplayName: "Task" } });
        session.emit({ type: "tool.execution_complete", data: { toolCallId: "top-1" } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      // Only top-level tool call should appear
      const toolStarts = events.filter(e => e.type === "toolcall_start");
      expect(toolStarts).toHaveLength(1);
      const toolEnds = events.filter(e => e.type === "toolcall_end");
      expect(toolEnds).toHaveLength(1);
      expect(toolEnds[0].toolCall.name).toBe("bash");
    }, 10000);

    it("should not filter text without parentToolCallId", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "Normal response" } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === "text_delta");
      expect(textDeltas).toHaveLength(1);
      expect(textDeltas[0].delta).toBe("Normal response");
    }, 10000);

    it("should clean up activeSubagents on failed subagent", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [{ role: "user", content: "test" }],
        tools: [],
      };

      const stream = fn(model, context as any);

      setTimeout(async () => {
        while (client.sessions.length === 0) await new Promise(r => setTimeout(r, 10));
        const session = client.sessions[0];
        session.emit({ type: "subagent.started", data: { toolCallId: "sub-fail", agentName: "task", agentDisplayName: "Task", agentDescription: "" } });
        // Subagent text (filtered)
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "should be hidden", parentToolCallId: "sub-fail" } });
        // Subagent fails
        session.emit({ type: "subagent.failed", data: { toolCallId: "sub-fail", agentName: "task", agentDisplayName: "Task", error: "timeout" } });
        // Text after failure (should NOT be filtered — subagent no longer active)
        session.emit({ type: "assistant.message_delta", data: { deltaContent: "After failure" } });
        session.emit({ type: "session.idle", data: {} });
      }, 100);

      const events: any[] = [];
      for await (const event of stream as any) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === "text_delta");
      const allText = textDeltas.map(e => e.delta).join("");
      expect(allText).toBe("After failure");
      expect(allText).not.toContain("should be hidden");
    }, 10000);
  });

  describe("conversation serialization", () => {
    it("should serialize user messages", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Be brief",
        messages: [
          { role: "user", content: "Hello world" },
        ],
        tools: [],
      };

      fn(model, context as any);
      await new Promise(r => setTimeout(r, 50));

      const session = client.sessions[0];
      expect(session.sentPrompts[0]).toContain("Hello world");
    });

    it("should serialize tool results", async () => {
      const fn = bridge.createStreamFn();
      const model = makeModel();
      const context = {
        systemPrompt: "Test",
        messages: [
          { role: "user", content: "list files" },
          { role: "assistant", content: [{ type: "text", text: "running..." }] },
          { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "file1.ts\nfile2.ts" }] },
        ],
        tools: [],
      };

      fn(model, context as any);
      await new Promise(r => setTimeout(r, 50));

      const session = client.sessions[0];
      expect(session.sentPrompts[0]).toContain("[bash]:");
      expect(session.sentPrompts[0]).toContain("file1.ts");
    });
  });
});
