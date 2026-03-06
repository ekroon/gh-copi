#!/usr/bin/env node
/**
 * MCP Shell Server — provides shell command execution for Copilot CLI subagents.
 *
 * The built-in `bash` tool creates PTY sessions that `write_bash`/`read_bash` depend on.
 * When we exclude `bash` (to avoid name conflicts with our custom bash tool),
 * subagents lose shell access. This MCP server fills that gap by providing a
 * `shell_execute` tool that subagents can use instead.
 *
 * Runs as a stdio MCP server, spawned by the Copilot CLI SDK.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";

const server = new McpServer({
  name: "gh-copi-shell",
  version: "1.0.0",
});

server.tool(
  "shell_execute",
  "Execute a shell command and return its output. Use this for running any shell command.",
  {
    command: z.string().describe("The shell command to execute"),
    cwd: z.string().optional().describe("Working directory (defaults to session cwd)"),
    timeout: z.number().optional().describe("Timeout in milliseconds (default: 30000)"),
  },
  async ({ command, cwd, timeout }) => {
    const timeoutMs = timeout ?? 30_000;
    const workDir = cwd ?? process.cwd();

    try {
      const result = await executeCommand(command, workDir, timeoutMs);
      return {
        content: [
          {
            type: "text" as const,
            text: result.stdout + (result.stderr ? `\nSTDERR:\n${result.stderr}` : ""),
          },
        ],
        ...(result.exitCode !== 0 ? { isError: true } : {}),
      };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  },
);

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP shell server error: ${err.message}\n`);
  process.exit(1);
});
