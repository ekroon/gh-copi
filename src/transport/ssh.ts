/**
 * SSHTransport — executes commands on a remote host via SSH.
 *
 * Uses OpenSSH ControlMaster for connection multiplexing.
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTransport, ExecOptions, ExecResult } from "./types.js";

export interface SSHTarget {
  /** user@host */
  host: string;
  /** Remote working directory */
  remotePath?: string;
  /** SSH port (default: 22) */
  port?: number;
  /** SSH identity file */
  identityFile?: string;
}

export class SSHTransport implements RemoteTransport {
  readonly name: string;
  private target: SSHTarget;
  private controlSocket?: string;
  private tempDir?: string;
  private masterProcess?: ReturnType<typeof spawn>;

  constructor(target: SSHTarget) {
    this.target = target;
    this.name = `ssh:${target.host}`;
  }

  async setup(): Promise<void> {
    this.tempDir = await mkdtemp(join(tmpdir(), "gh-pico-ssh-"));
    this.controlSocket = join(this.tempDir, "ctrl.sock");

    const sshArgs = [
      "-o", `ControlPath=${this.controlSocket}`,
      "-o", "ControlMaster=yes",
      "-o", "ControlPersist=600",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      ...(this.target.port ? ["-p", String(this.target.port)] : []),
      ...(this.target.identityFile ? ["-i", this.target.identityFile] : []),
      "-fN",
      this.target.host,
    ];

    this.masterProcess = spawn("ssh", sshArgs, {
      stdio: "ignore",
      detached: true,
    });

    // Wait for master to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("SSH master connection timeout")),
        30000,
      );
      const check = () => {
        try {
          execSync(
            `ssh -o ControlPath=${this.controlSocket} -O check ${this.target.host} 2>/dev/null`,
          );
          clearTimeout(timeout);
          resolve();
        } catch {
          setTimeout(check, 200);
        }
      };
      check();
    });
  }

  async exec(
    command: string,
    cwd: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (!this.controlSocket) {
      throw new Error("SSHTransport not set up — call setup() first");
    }

    const wrappedCommand = `cd ${this.shellEscape(cwd)} && ${command}`;
    const sshArgs = [
      "-o", `ControlPath=${this.controlSocket}`,
      ...(this.target.port ? ["-p", String(this.target.port)] : []),
      this.target.host,
      "--",
      "bash", "-c", this.shellEscape(wrappedCommand),
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn("ssh", sshArgs, {
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

  async forwardSocket(localPath: string, remotePath: string): Promise<void> {
    if (!this.controlSocket) throw new Error("SSHTransport not set up");

    execSync(
      `ssh -o ControlPath=${this.controlSocket} -O forward -L ${localPath}:${remotePath} ${this.target.host}`,
      { encoding: "utf-8" },
    );
  }

  cancelForward(localPath: string, remotePath: string): void {
    if (!this.controlSocket) return;
    try {
      execSync(
        `ssh -o ControlPath=${this.controlSocket} -O cancel -L ${localPath}:${remotePath} ${this.target.host}`,
        { encoding: "utf-8" },
      );
    } catch {
      // Ignore
    }
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
    if (this.controlSocket) {
      try {
        execSync(
          `ssh -o ControlPath=${this.controlSocket} -O exit ${this.target.host} 2>/dev/null`,
        );
      } catch {
        // Ignore
      }
    }

    if (this.masterProcess) {
      this.masterProcess.kill();
      this.masterProcess = undefined;
    }

    if (this.tempDir) {
      try {
        await rm(this.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
