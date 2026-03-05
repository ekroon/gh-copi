/**
 * RemoteTransport — abstraction for command execution on a target environment.
 *
 * Implementations: LocalTransport, CodespaceTransport, SSHTransport, DevcontainerTransport.
 */

export interface ExecOptions {
  /** Callback for streaming stdout/stderr data */
  onData?: (data: Buffer) => void;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Environment variables to set */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RemoteTransport {
  /** Display name (e.g., "local", "codespace:my-cs", "ssh:user@host") */
  readonly name: string;

  /** Execute a command on the target */
  exec(
    command: string,
    cwd: string,
    options?: ExecOptions,
  ): Promise<ExecResult>;

  /** Forward a Unix socket (local ↔ remote). Used for IDE socket forwarding. */
  forwardSocket?(
    localPath: string,
    remotePath: string,
  ): Promise<void>;

  /** Cancel a socket forward */
  cancelForward?(
    localPath: string,
    remotePath: string,
  ): void;

  /** Set up the transport (e.g., establish SSH master connection) */
  setup?(): Promise<void>;

  /** Tear down the transport (e.g., close SSH master connection) */
  teardown?(): Promise<void>;

  /** Read a file from the target */
  readFile(filePath: string): Promise<string>;

  /** Write a file on the target */
  writeFile(filePath: string, content: string): Promise<void>;

  /** Check if a file/directory exists on the target */
  exists(filePath: string): Promise<boolean>;
}
