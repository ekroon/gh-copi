/**
 * LocalTransport — executes commands on the local machine via child_process.
 * Default transport when no remote target is specified.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import type { RemoteTransport, ExecOptions, ExecResult } from "./types.js";

export class LocalTransport implements RemoteTransport {
  readonly name = "local";

  async exec(
    command: string,
    cwd: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn("bash", ["-c", command], {
        cwd,
        env: { ...process.env, ...options?.env },
        stdio: ["ignore", "pipe", "pipe"],
        signal: options?.signal,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        options?.onData?.(data);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
        options?.onData?.(data);
      });

      if (options?.timeout) {
        setTimeout(() => {
          proc.kill("SIGTERM");
          reject(new Error(`Command timed out after ${options.timeout}ms`));
        }, options.timeout);
      }

      proc.on("error", reject);
      proc.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  async readFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, "utf-8");
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
