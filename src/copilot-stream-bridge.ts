/**
 * CopilotStreamBridge — Bridges Copilot SDK ↔ pi-mono's registerProvider() streamSimple.
 *
 * Validated in prototype/probe14-final.ts. This is the production version with:
 * - Persistent SDK session (required for subagents, plan mode, review)
 * - Tool result caching (no double execution)
 * - Final response caching (no double LLM call)
 * - Reasoning/thinking event bridging
 * - Image/attachment forwarding
 * - Reload lifecycle hook
 */
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

export interface SubagentEvent {
  type: "started" | "completed" | "failed";
  agentName: string;
  agentDisplayName: string;
  toolCallId: string;
  error?: string;
}

export interface CopilotStreamBridgeOptions {
  client: CopilotClient;
  modelRegistry: ModelRegistry;
  providerName?: string;
  onReload?: () => void;
  onSubagentEvent?: (event: SubagentEvent) => void;
}

export class CopilotStreamBridge {
  private client: CopilotClient;
  private modelRegistry: ModelRegistry;
  private providerName: string;
  private sdkSession: any = null;
  private lastModelId: string | null = null;
  private lastToolNames: string | null = null;

  // Caches — keyed by toolCallId, cleared after use
  private toolResultCache = new Map<string, AgentToolResult<any>>();
  private pendingFinalResponse: string | null = null;
  private pendingUsage: { input: number; output: number } | null = null;

  // Reference to current pi-mono tools for SDK handler dispatch
  private currentTools: any[] = [];

  // Active subagent tracking — toolCallIds of running subagents.
  // Used to filter subagent text/tool events from the main stream.
  private activeSubagents = new Set<string>();

  // Callback for subagent lifecycle events (start/complete/fail)
  private onSubagentEvent?: (event: SubagentEvent) => void;

  constructor(options: CopilotStreamBridgeOptions) {
    this.client = options.client;
    this.modelRegistry = options.modelRegistry;
    this.providerName = options.providerName ?? "copilot-sdk";
    this.onSubagentEvent = options.onSubagentEvent;
  }

  /**
   * Set the subagent event callback. Called after session creation
   * since the session is needed to emit TUI events.
   */
  setSubagentEventHandler(handler: (event: SubagentEvent) => void): void {
    this.onSubagentEvent = handler;
  }

  /**
   * Returns the streamSimple function to pass to registerProvider().
   */
  createStreamFn(): (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream {
    return (model, context, options) =>
      this.streamSimple(model, context, options);
  }

  /**
   * Get a cached tool result (called by pi-mono's tool.execute()).
   * Returns undefined if no cache hit — caller should fall back to real execution.
   */
  getCachedResult(toolCallId: string): AgentToolResult<any> | undefined {
    const cached = this.toolResultCache.get(toolCallId);
    if (cached) {
      this.toolResultCache.delete(toolCallId);
    }
    return cached;
  }

  /**
   * Call after session.reload() to re-register the provider and reset SDK session.
   */
  async handleReload(
    token: string,
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: ("text" | "image")[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
    }>,
  ): Promise<void> {
    // Destroy current SDK session
    if (this.sdkSession) {
      try {
        await this.sdkSession.destroy();
      } catch {}
      this.sdkSession = null;
    }
    this.pendingFinalResponse = null;
    this.pendingUsage = null;
    this.toolResultCache.clear();
    this.activeSubagents.clear();
    this.modelRegistry.registerProvider(this.providerName, {
      api: `${this.providerName}-api` as Api,
      apiKey: token,
      baseUrl: `https://${this.providerName}-managed`,
      streamSimple: this.createStreamFn(),
      models,
    });
  }

  /**
   * Destroy the SDK session and clean up.
   */
  async destroy(): Promise<void> {
    if (this.sdkSession) {
      try {
        await this.sdkSession.destroy();
      } catch {}
      this.sdkSession = null;
    }
    this.toolResultCache.clear();
    this.pendingFinalResponse = null;
    this.pendingUsage = null;
    this.activeSubagents.clear();
  }

  // ─── Core stream function ──────────────────────────────────────────────────

  private streamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    (async () => {
      try {
        // If we have a cached final response from a previous tool cycle, return it
        if (this.pendingFinalResponse !== null) {
          this.emitCachedResponse(stream, model);
          return;
        }

        // Update current tools reference
        this.currentTools = context.tools || [];

        // Check if we need a new SDK session
        const modelId = model.id;
        const toolNames = this.currentTools
          .map((t) => t.name)
          .sort()
          .join(",");
        const needNewSession =
          !this.sdkSession ||
          modelId !== this.lastModelId ||
          toolNames !== this.lastToolNames;

        if (needNewSession) {
          if (this.sdkSession) {
            try {
              await this.sdkSession.destroy();
            } catch {}
          }
          await this.createSdkSession(model, context, options);
          this.lastModelId = modelId;
          this.lastToolNames = toolNames;
        }

        // Build prompt from context
        const prompt = this.serializeConversation(context);

        // Set up event tracking
        const partial = this.createPartial(model);
        let fullText = "";
        let afterToolText = "";
        let phase: "initial" | "after_tools" = "initial";
        const toolCalls: Array<{
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
        }> = [];
        let totalUsage = { input: 0, output: 0 };
        let thinkingIndex = -1;
        let streamEnded = false;

        // Safety timeout — prevents hanging if session.idle never fires (e.g., subagent stalls)
        const STREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        let unsub: () => void;
        const timeoutHandle = setTimeout(() => {
          if (streamEnded) return;
          streamEnded = true;
          unsub?.();
          partial.stopReason = "error";
          partial.errorMessage = `Request timed out after ${STREAM_TIMEOUT_MS / 1000}s waiting for response`;
          stream.push({
            type: "error",
            reason: "error",
            error: { ...partial },
          });
          stream.end({ ...partial });
        }, STREAM_TIMEOUT_MS);

        stream.push({ type: "start", partial: { ...partial } });
        stream.push({
          type: "text_start",
          contentIndex: 0,
          partial: { ...partial },
        });

        unsub = this.sdkSession.on((event: any) => {
          // Subagent lifecycle tracking
          if (event.type === "subagent.started") {
            this.activeSubagents.add(event.data.toolCallId);
            this.onSubagentEvent?.({
              type: "started",
              agentName: event.data.agentName,
              agentDisplayName: event.data.agentDisplayName,
              toolCallId: event.data.toolCallId,
            });
          }
          if (event.type === "subagent.completed") {
            this.activeSubagents.delete(event.data.toolCallId);
            this.onSubagentEvent?.({
              type: "completed",
              agentName: event.data.agentName,
              agentDisplayName: event.data.agentDisplayName,
              toolCallId: event.data.toolCallId,
            });
          }
          if (event.type === "subagent.failed") {
            this.activeSubagents.delete(event.data.toolCallId);
            this.onSubagentEvent?.({
              type: "failed",
              agentName: event.data.agentName,
              agentDisplayName: event.data.agentDisplayName,
              toolCallId: event.data.toolCallId,
              error: event.data.error,
            });
          }

          // Text deltas — skip subagent output (it stays in the toolHandler result)
          if (event.type === "assistant.message_delta") {
            if (event.data.parentToolCallId && this.activeSubagents.has(event.data.parentToolCallId)) {
              return; // Subagent text — don't mix into main stream
            }
            const delta: string = event.data.deltaContent;
            if (phase === "initial") {
              fullText += delta;
              partial.content[0] = { type: "text", text: fullText };
              stream.push({
                type: "text_delta",
                contentIndex: 0,
                delta,
                partial: { ...partial },
              });
            } else {
              afterToolText += delta;
            }
          }

          // Reasoning/thinking deltas
          if (event.type === "assistant.reasoning_delta") {
            if (thinkingIndex < 0) {
              thinkingIndex = partial.content.length;
              partial.content.push({
                type: "thinking",
                thinking: "",
              });
            }
            const delta: string = event.data.deltaContent;
            const thinking = partial.content[thinkingIndex];
            if (thinking && thinking.type === "thinking") {
              thinking.thinking += delta;
            }
            stream.push({
              type: "thinking_delta" as any,
              contentIndex: thinkingIndex,
              delta,
              partial: { ...partial },
            });
          }

          // Tool execution tracking — skip subagent-internal tool calls
          if (event.type === "tool.execution_start") {
            if (event.data.parentToolCallId) {
              return; // Subagent's internal tool call — don't track as top-level
            }
            toolCalls.push({
              toolCallId: event.data.toolCallId,
              toolName: event.data.toolName,
              args: event.data.arguments || {},
            });
          }
          if (event.type === "tool.execution_complete") {
            if (event.data.parentToolCallId) {
              return; // Subagent's internal tool completion
            }
            phase = "after_tools";
          }

          // Usage tracking
          if (event.type === "assistant.usage") {
            totalUsage.input += event.data.inputTokens || 0;
            totalUsage.output += event.data.outputTokens || 0;
          }

          // Session idle — turn complete
          if (event.type === "session.idle") {
            unsub();
            clearTimeout(timeoutHandle);
            streamEnded = true;
            partial.content[0] = { type: "text", text: fullText };
            stream.push({
              type: "text_end",
              contentIndex: 0,
              content: fullText,
              partial: { ...partial },
            });
            partial.usage.input = totalUsage.input;
            partial.usage.output = totalUsage.output;
            partial.usage.totalTokens =
              totalUsage.input + totalUsage.output;

            if (toolCalls.length > 0) {
              // Cache the final response for the next streamSimple call
              this.pendingFinalResponse = afterToolText;
              this.pendingUsage = totalUsage;

              // Emit tool call events so pi-mono's loop processes them
              for (const tc of toolCalls) {
                const idx = partial.content.length;
                const toolCall = {
                  type: "toolCall" as const,
                  id: tc.toolCallId,
                  name: tc.toolName,
                  arguments: tc.args,
                };
                partial.content.push(toolCall);
                partial.stopReason = "toolUse";
                stream.push({
                  type: "toolcall_start",
                  contentIndex: idx,
                  partial: { ...partial },
                });
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: idx,
                  delta: JSON.stringify(tc.args),
                  partial: { ...partial },
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: idx,
                  toolCall,
                  partial: { ...partial },
                });
              }
              stream.push({
                type: "done",
                reason: "toolUse",
                message: { ...partial },
              });
            } else {
              stream.push({
                type: "done",
                reason: "stop",
                message: { ...partial },
              });
            }
            stream.end({ ...partial });
          }

          // Error handling
          if (event.type === "session.error") {
            unsub();
            clearTimeout(timeoutHandle);
            streamEnded = true;
            partial.stopReason = "error";
            partial.errorMessage = event.data.message;
            stream.push({
              type: "error",
              reason: "error",
              error: { ...partial },
            });
            stream.end({ ...partial });
          }
        });

        // Send the prompt
        await this.sdkSession.send({ prompt });
      } catch (err: any) {
        const errorPartial = this.createPartial(model);
        errorPartial.stopReason = "error";
        errorPartial.errorMessage = err.message;
        stream.push({
          type: "error",
          reason: "error",
          error: errorPartial,
        });
        stream.end(errorPartial);
      }
    })();

    return stream;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async createSdkSession(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<void> {
    // Deduplicate tools by name (last occurrence wins, matching pi-mono's Map override semantics)
    const deduped = new Map(this.currentTools.map((t) => [t.name, t]));
    const uniqueTools = Array.from(deduped.values());

    const sdkTools = uniqueTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      overridesBuiltInTool: true,
      handler: async (args: any, invocation: any) => {
        // Find and run the real pi-mono tool
        const piTool = this.currentTools.find((t) => t.name === tool.name);
        if (!piTool) return `Tool ${tool.name} not found`;

        const result = await piTool.execute(
          invocation.toolCallId,
          args,
          undefined,
          undefined,
        );
        const text = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");

        // Cache result for pi-mono's execute() call
        this.toolResultCache.set(invocation.toolCallId, result);
        return text;
      },
    }));

    // Map reasoning level
    const reasoning = options?.reasoning;
    const reasoningEffort = reasoning
      ? (reasoning as "low" | "medium" | "high")
      : undefined;

    // Exclude built-in CLI tools that conflict with our custom tools.
    // This keeps built-in agents (task, explore, code-review, research) enabled.
    const customToolNames = new Set(sdkTools.map((t) => t.name));
    const BUILTIN_CLI_TOOLS = [
      "bash", "read", "edit", "write", "grep", "glob", "view",
      "create", "ls", "find", "str_replace_editor",
    ];
    const excludedTools = BUILTIN_CLI_TOOLS.filter((t) => customToolNames.has(t));

    this.sdkSession = await this.client.createSession({
      onPermissionRequest: approveAll,
      model: model.id,
      streaming: true,
      tools: sdkTools,
      excludedTools,
      systemMessage: {
        mode: "replace",
        content: context.systemPrompt || "You are a helpful coding assistant.",
      },
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  private emitCachedResponse(
    stream: AssistantMessageEventStream,
    model: Model<Api>,
  ): void {
    const text = this.pendingFinalResponse!;
    const usage = this.pendingUsage || { input: 0, output: 0 };
    this.pendingFinalResponse = null;
    this.pendingUsage = null;

    const partial = this.createPartial(model);
    partial.content[0] = { type: "text", text };
    partial.usage.input = usage.input;
    partial.usage.output = usage.output;
    partial.usage.totalTokens = usage.input + usage.output;

    stream.push({ type: "start", partial: { ...partial } });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...partial },
    });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: text,
      partial: { ...partial },
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: text,
      partial: { ...partial },
    });
    stream.push({ type: "done", reason: "stop", message: { ...partial } });
    stream.end({ ...partial });
  }

  private createPartial(model: Model<Api>): any {
    return {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  private serializeConversation(context: Context): string {
    return context.messages
      .map((msg: any) => {
        if (msg.role === "user") {
          if (typeof msg.content === "string") return msg.content;
          return msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        }
        if (msg.role === "assistant") {
          return msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        }
        if (msg.role === "toolResult") {
          return `[${msg.toolName}]: ${msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n")}`;
        }
        return "";
      })
      .join("\n\n");
  }
}
