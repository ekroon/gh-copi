/**
 * DevcontainerTransport — executes commands inside a local devcontainer.
 *
 * Supports both `docker exec` (for running containers) and `devcontainer exec`
 * (for devcontainer CLI-managed containers).
 */
import { spawn, execSync } from "node:child_process";
import type { RemoteTransport, ExecOptions, ExecResult } from "./types.js";

export interface DevcontainerTarget {
  /** Container ID or name (for docker exec mode) */
  containerId?: string;
  /** Workspace folder (for devcontainer exec mode) */
  workspaceFolder?: string;
  /** Use devcontainer CLI instead of docker exec */
  useDevcontainerCli?: boolean;
}

export class DevcontainerTransport implements RemoteTransport {
  readonly name: string;
  private target: DevcontainerTarget;
  private resolvedContainerId?: string;

  constructor(target: DevcontainerTarget) {
    this.target = target;
    this.name = target.containerId
      ? `devcontainer:${target.containerId.slice(0, 12)}`
      : `devcontainer:${target.workspaceFolder ?? "local"}`;
  }

  async setup(): Promise<void> {
    if (this.target.useDevcontainerCli && this.target.workspaceFolder) {
      // Use devcontainer CLI to find running container
      try {
        const result = execSync(
          `devcontainer up --workspace-folder ${this.shellEscape(this.target.workspaceFolder)} 2>/dev/null | grep -o '"containerId":"[^"]*"' | head -1 | cut -d'"' -f4`,
          { encoding: "utf-8" },
        ).trim();
        if (result) this.resolvedContainerId = result;
      } catch {
        // Fall through to use devcontainer exec
      }
    } else if (this.target.containerId) {
      this.resolvedContainerId = this.target.containerId;
    }
  }

  async exec(
    command: string,
    cwd: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    const wrappedCommand = `cd ${this.shellEscape(cwd)} && ${command}`;

    let execArgs: string[];
    let execCmd: string;

    if (this.target.useDevcontainerCli && this.target.workspaceFolder) {
      execCmd = "devcontainer";
      execArgs = [
        "exec",
        "--workspace-folder", this.target.workspaceFolder,
        "bash", "-c", wrappedCommand,
      ];
    } else if (this.resolvedContainerId) {
      execCmd = "docker";
      execArgs = [
        "exec", "-i", this.resolvedContainerId,
        "bash", "-c", wrappedCommand,
      ];
    } else {
      throw new Error("DevcontainerTransport: no container ID or workspace folder");
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(execCmd, execArgs, {
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
    const result = await this.exec(`cat ${this.shellEscape(filePath)}`, "/");
    if (result.exitCode !== 0) throw new Error(`Failed to read file: ${result.stderr}`);
    return result.stdout;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const b64 = Buffer.from(content).toString("base64");
    const result = await this.exec(
      `echo '${b64}' | base64 -d > ${this.shellEscape(filePath)}`,
      "/",
    );
    if (result.exitCode !== 0) throw new Error(`Failed to write file: ${result.stderr}`);
  }

  async exists(filePath: string): Promise<boolean> {
    const result = await this.exec(
      `test -e ${this.shellEscape(filePath)} && echo yes || echo no`,
      "/",
    );
    return result.stdout.trim() === "yes";
  }

  async teardown(): Promise<void> {
    // Nothing to clean up for docker exec
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
