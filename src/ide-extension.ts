/**
 * IDE Extension — connects to VS Code's MCP server for IDE integration.
 *
 * Discovers IDE lock files at ~/.copilot/ide/, connects via MCP Streamable HTTP
 * on Unix socket, provides tools (get_diagnostics, open_diff) and auto-polls
 * get_selection for context injection.
 *
 * This is a pi-mono extension that registers tools and context handlers.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import * as http from "node:http";

const IDE_DIR = join(homedir(), ".copilot", "ide");

export interface IdeLockInfo {
  socketPath: string;
  pid: number;
  workspaceFolder?: string;
}

/** Discover IDE lock files and return connection info */
export async function discoverIdeSockets(): Promise<IdeLockInfo[]> {
  try {
    const files = await readdir(IDE_DIR);
    const lockFiles = files.filter((f) => f.endsWith(".lock"));
    const results: IdeLockInfo[] = [];

    for (const lockFile of lockFiles) {
      try {
        const content = await readFile(join(IDE_DIR, lockFile), "utf-8");
        const data = JSON.parse(content);
        if (data.socketPath) {
          results.push({
            socketPath: data.socketPath,
            pid: data.pid,
            workspaceFolder: data.workspaceFolder,
          });
        }
      } catch {
        // Skip invalid lock files
      }
    }

    return results;
  } catch {
    return [];
  }
}

/** Call an MCP tool on the IDE socket */
export async function callIdeTool(
  socketPath: string,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.result ?? parsed);
          } catch {
            resolve(data);
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("IDE MCP request timeout"));
    });
    req.write(body);
    req.end();
  });
}

/** Poll get_selection from the IDE */
export async function getSelection(socketPath: string): Promise<{
  filePath?: string;
  startLine?: number;
  endLine?: number;
  text?: string;
} | null> {
  try {
    const result = await callIdeTool(socketPath, "get_selection");
    if (result?.content?.[0]?.text) {
      return JSON.parse(result.content[0].text);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create a pi-mono extension for IDE integration.
 *
 * Usage in createAgentSession:
 *   extensions: [createIdeExtension()]
 *
 * This returns the extension definition object that pi-mono's extension
 * system can load.
 */
export function createIdeExtension() {
  return {
    name: "ide-integration",
    description: "VS Code IDE integration (selection, diagnostics, diffs)",

    async activate(ctx: any) {
      const sockets = await discoverIdeSockets();
      if (sockets.length === 0) {
        return;
      }

      const socket = sockets[0]; // Use first available IDE

      // Register get_diagnostics tool
      ctx.registerTool({
        name: "get_diagnostics",
        description: "Get language errors/warnings from VS Code",
        parameters: {},
        execute: async () => {
          const result = await callIdeTool(
            socket.socketPath,
            "get_diagnostics",
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        },
      });

      // Register open_diff tool
      ctx.registerTool({
        name: "open_diff",
        description: "Show a diff in VS Code editor",
        parameters: {
          filePath: { type: "string", description: "File to diff" },
          newContent: { type: "string", description: "New content to diff against" },
        },
        execute: async (_id: string, params: any) => {
          const result = await callIdeTool(
            socket.socketPath,
            "open_diff",
            params,
          );
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        },
      });

      // Auto-poll selection on context events
      ctx.on("context", async () => {
        const selection = await getSelection(socket.socketPath);
        if (selection?.text) {
          return {
            inject: `<ide_selection file="${selection.filePath}" lines="${selection.startLine}-${selection.endLine}">\n${selection.text}\n</ide_selection>`,
          };
        }
        return {};
      });
    },
  };
}
