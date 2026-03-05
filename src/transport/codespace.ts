/**
 * CodespaceTransport — executes commands on a GitHub Codespace via SSH.
 *
 * Uses `gh codespace ssh --config` + OpenSSH ControlMaster for connection
 * multiplexing (~0.1s vs ~3s per command). Ported from gh-copilot-codespace's
 * Go SSH client strategy.
 */
import { spawn, execSync } from "node:child_process";
import { mkdtemp, writeFile as fsWriteFile, readFile as fsReadFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTransport, ExecOptions, ExecResult } from "./types.js";

export class CodespaceTransport implements RemoteTransport {
  readonly name: string;
  private codespaceName: string;
  private sshConfigPath?: string;
  private sshHost?: string;
  private controlSocket?: string;
  private tempDir?: string;
  private masterProcess?: ReturnType<typeof spawn>;

  constructor(codespaceName: string) {
    this.codespaceName = codespaceName;
    this.name = `codespace:${codespaceName}`;
  }

  async setup(): Promise<void> {
    // 1. Get SSH config from gh CLI
    const sshConfig = execSync(
      `gh codespace ssh --config -c ${this.codespaceName}`,
      { encoding: "utf-8" },
    );

    // 2. Parse host from config
    const hostMatch = sshConfig.match(/^Host\s+(\S+)/m);
    if (!hostMatch) throw new Error("Could not parse SSH host from codespace config");
    this.sshHost = hostMatch[1];

    // 3. Create temp dir for config and control socket
    this.tempDir = await mkdtemp(join(tmpdir(), "gh-copi-"));
    this.controlSocket = join(this.tempDir, "ctrl.sock");
    this.sshConfigPath = join(this.tempDir, "ssh_config");

    // 4. Write augmented SSH config with ControlMaster settings
    const augmentedConfig =
      sshConfig +
      `\n  ControlPath ${this.controlSocket}` +
      `\n  ControlPersist 600` +
      `\n  ServerAliveInterval 15` +
      `\n  ServerAliveCountMax 3\n`;

    await fsWriteFile(this.sshConfigPath, augmentedConfig);

    // 5. Establish master connection
    this.masterProcess = spawn(
      "ssh",
      [
        "-F", this.sshConfigPath,
        "-o", "ControlMaster=yes",
        "-fN",
        this.sshHost,
      ],
      { stdio: "ignore", detached: true },
    );

    // Wait for master to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSH master connection timeout")), 30000);
      const check = () => {
        try {
          execSync(
            `ssh -F ${this.sshConfigPath} -O check ${this.sshHost} 2>/dev/null`,
            { encoding: "utf-8" },
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
    if (!this.sshConfigPath || !this.sshHost) {
      throw new Error("CodespaceTransport not set up — call setup() first");
    }

    const wrappedCommand = `cd ${this.shellEscape(cwd)} && ${command}`;

    return new Promise((resolve, reject) => {
      const proc = spawn(
        "ssh",
        ["-F", this.sshConfigPath!, this.sshHost!, "--", "bash", "-c", this.shellEscape(wrappedCommand)],
        {
          stdio: ["ignore", "pipe", "pipe"],
          signal: options?.signal,
        },
      );

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
    if (!this.sshConfigPath || !this.sshHost) {
      throw new Error("CodespaceTransport not set up");
    }

    execSync(
      `ssh -F ${this.sshConfigPath} -O forward -L ${localPath}:${remotePath} ${this.sshHost}`,
      { encoding: "utf-8" },
    );
  }

  cancelForward(localPath: string, remotePath: string): void {
    if (!this.sshConfigPath || !this.sshHost) return;

    try {
      execSync(
        `ssh -F ${this.sshConfigPath} -O cancel -L ${localPath}:${remotePath} ${this.sshHost}`,
        { encoding: "utf-8" },
      );
    } catch {
      // Ignore errors on cancel
    }
  }

  async readFile(filePath: string): Promise<string> {
    const result = await this.exec(`cat ${this.shellEscape(filePath)}`, "/");
    if (result.exitCode !== 0) throw new Error(`Failed to read file: ${result.stderr}`);
    return result.stdout;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    // Use base64 to safely transfer content over SSH
    const b64 = Buffer.from(content).toString("base64");
    const result = await this.exec(
      `echo '${b64}' | base64 -d > ${this.shellEscape(filePath)}`,
      "/",
    );
    if (result.exitCode !== 0) throw new Error(`Failed to write file: ${result.stderr}`);
  }

  async exists(filePath: string): Promise<boolean> {
    const result = await this.exec(`test -e ${this.shellEscape(filePath)} && echo yes || echo no`, "/");
    return result.stdout.trim() === "yes";
  }

  async teardown(): Promise<void> {
    if (this.sshConfigPath && this.sshHost) {
      try {
        execSync(
          `ssh -F ${this.sshConfigPath} -O exit ${this.sshHost} 2>/dev/null`,
          { encoding: "utf-8" },
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
        // Ignore cleanup errors
      }
    }
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
