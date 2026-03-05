/**
 * Remote Tools — Pi-mono AgentTool objects backed by RemoteTransport.
 *
 * These tools replace pi-mono's built-in tools when operating on a remote target.
 * They match the tool interfaces/schemas that the LLM expects.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { RemoteTransport } from "./transport/types.js";

// AgentTool type matching pi-mono's interface
export interface AgentToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details?: Record<string, unknown>;
}

export interface RemoteAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (update: any) => void,
  ) => Promise<AgentToolResult>;
}

// ─── Tool Parameter Schemas ──────────────────────────────────────────────────

const BashParams = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  description: Type.Optional(
    Type.String({ description: "Short description of what this command does" }),
  ),
});

const ReadFileParams = Type.Object({
  path: Type.String({ description: "Absolute path to the file to read" }),
  view_range: Type.Optional(
    Type.Array(Type.Integer(), {
      description: "Line range [start, end] to read (1-indexed). Use [-1] for end of file.",
      minItems: 2,
      maxItems: 2,
    }),
  ),
});

const WriteFileParams = Type.Object({
  path: Type.String({ description: "Absolute path to the file to write" }),
  file_text: Type.String({ description: "Content to write to the file" }),
});

const EditFileParams = Type.Object({
  path: Type.String({ description: "Absolute path to the file to edit" }),
  old_str: Type.String({ description: "The exact string to replace" }),
  new_str: Type.String({ description: "The new string to replace old_str with" }),
});

const GrepParams = Type.Object({
  pattern: Type.String({ description: "Regular expression pattern to search for" }),
  path: Type.Optional(
    Type.String({ description: "File or directory to search in. Defaults to cwd." }),
  ),
  glob: Type.Optional(
    Type.String({ description: "Glob pattern to filter files (e.g., '*.ts')" }),
  ),
});

const GlobParams = Type.Object({
  pattern: Type.String({ description: "Glob pattern to match files (e.g., '**/*.ts')" }),
  path: Type.Optional(
    Type.String({ description: "Directory to search in. Defaults to cwd." }),
  ),
});

const LsParams = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Directory to list. Defaults to cwd." }),
  ),
});

// ─── Tool Factory ────────────────────────────────────────────────────────────

/**
 * Create a set of remote-backed AgentTools for the given transport and working directory.
 */
export function createRemoteTools(
  transport: RemoteTransport,
  workdir: string,
): RemoteAgentTool[] {
  return [
    createBashTool(transport, workdir),
    createReadFileTool(transport, workdir),
    createWriteFileTool(transport, workdir),
    createEditFileTool(transport, workdir),
    createGrepTool(transport, workdir),
    createGlobTool(transport, workdir),
    createLsTool(transport, workdir),
  ];
}

function createBashTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "bash",
    label: `Bash (${transport.name})`,
    description: `Execute a bash command on ${transport.name}. Working directory: ${workdir}`,
    parameters: BashParams,
    execute: async (_toolCallId, params: Static<typeof BashParams>) => {
      const result = await transport.exec(params.command, workdir, {
        timeout: 120000,
      });
      const output = (result.stdout + result.stderr).trim() || "(no output)";
      return {
        content: [{ type: "text", text: output }],
        details: { exitCode: result.exitCode, command: params.command },
      };
    },
  };
}

function createReadFileTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "view",
    label: `Read File (${transport.name})`,
    description: `Read a file from ${transport.name}. Returns file content with line numbers.`,
    parameters: ReadFileParams,
    execute: async (_toolCallId, params: Static<typeof ReadFileParams>) => {
      const filePath = params.path.startsWith("/")
        ? params.path
        : `${workdir}/${params.path}`;

      try {
        const content = await transport.readFile(filePath);
        let lines = content.split("\n");

        if (params.view_range) {
          const [start, end] = params.view_range;
          const startIdx = Math.max(0, start - 1);
          const endIdx = end === -1 ? lines.length : Math.min(lines.length, end);
          lines = lines.slice(startIdx, endIdx);
          const numbered = lines
            .map((line, i) => `${startIdx + i + 1}. ${line}`)
            .join("\n");
          return { content: [{ type: "text", text: numbered }] };
        }

        const numbered = lines.map((line, i) => `${i + 1}. ${line}`).join("\n");
        return { content: [{ type: "text", text: numbered }] };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading file: ${err.message}` }],
        };
      }
    },
  };
}

function createWriteFileTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "create",
    label: `Write File (${transport.name})`,
    description: `Create/write a file on ${transport.name}.`,
    parameters: WriteFileParams,
    execute: async (_toolCallId, params: Static<typeof WriteFileParams>) => {
      const filePath = params.path.startsWith("/")
        ? params.path
        : `${workdir}/${params.path}`;

      try {
        await transport.writeFile(filePath, params.file_text);
        return {
          content: [{ type: "text", text: `File written: ${filePath}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error writing file: ${err.message}` }],
        };
      }
    },
  };
}

function createEditFileTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "edit",
    label: `Edit File (${transport.name})`,
    description: `Edit a file on ${transport.name} by replacing a specific string.`,
    parameters: EditFileParams,
    execute: async (_toolCallId, params: Static<typeof EditFileParams>) => {
      const filePath = params.path.startsWith("/")
        ? params.path
        : `${workdir}/${params.path}`;

      try {
        const content = await transport.readFile(filePath);
        const occurrences = content.split(params.old_str).length - 1;

        if (occurrences === 0) {
          return {
            content: [{ type: "text", text: `Error: old_str not found in ${filePath}` }],
          };
        }
        if (occurrences > 1) {
          return {
            content: [
              {
                type: "text",
                text: `Error: old_str found ${occurrences} times in ${filePath}. Must be unique.`,
              },
            ],
          };
        }

        const newContent = content.replace(params.old_str, params.new_str);
        await transport.writeFile(filePath, newContent);
        return {
          content: [{ type: "text", text: `File edited: ${filePath}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error editing file: ${err.message}` }],
        };
      }
    },
  };
}

function createGrepTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "grep",
    label: `Grep (${transport.name})`,
    description: `Search file contents with ripgrep on ${transport.name}.`,
    parameters: GrepParams,
    execute: async (_toolCallId, params: Static<typeof GrepParams>) => {
      const searchPath = params.path || ".";
      let cmd = `rg --no-heading --line-number ${shellEscape(params.pattern)}`;
      if (params.glob) cmd += ` --glob ${shellEscape(params.glob)}`;
      cmd += ` ${shellEscape(searchPath)}`;

      const result = await transport.exec(cmd, workdir, { timeout: 30000 });
      const output = result.stdout.trim() || "(no matches)";
      return { content: [{ type: "text", text: output }] };
    },
  };
}

function createGlobTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "glob",
    label: `Find Files (${transport.name})`,
    description: `Find files by glob pattern on ${transport.name}.`,
    parameters: GlobParams,
    execute: async (_toolCallId, params: Static<typeof GlobParams>) => {
      const searchPath = params.path || ".";
      const cmd = `find ${shellEscape(searchPath)} -name ${shellEscape(params.pattern)} -type f 2>/dev/null | head -100`;

      const result = await transport.exec(cmd, workdir, { timeout: 30000 });
      const output = result.stdout.trim() || "(no files found)";
      return { content: [{ type: "text", text: output }] };
    },
  };
}

function createLsTool(transport: RemoteTransport, workdir: string): RemoteAgentTool {
  return {
    name: "ls",
    label: `List Directory (${transport.name})`,
    description: `List files and directories on ${transport.name}.`,
    parameters: LsParams,
    execute: async (_toolCallId, params: Static<typeof LsParams>) => {
      const path = params.path || ".";
      const cmd = `ls -la ${shellEscape(path)}`;

      const result = await transport.exec(cmd, workdir, { timeout: 10000 });
      const output = result.stdout.trim() || "(empty directory)";
      return { content: [{ type: "text", text: output }] };
    },
  };
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
