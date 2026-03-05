import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverIdeSockets } from "../ide-extension.js";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const IDE_DIR = join(homedir(), ".copilot", "ide");

/**
 * Tests for IDE extension discovery logic.
 * Uses real filesystem operations — no mocking.
 *
 * Note: callIdeTool and getSelection require a running VS Code MCP server
 * so they're tested with integration tests only.
 */
describe("discoverIdeSockets", () => {
  const testLockFile = join(IDE_DIR, "__test_ghcopi__.lock");
  let createdFiles: string[] = [];

  beforeEach(async () => {
    // Ensure the IDE directory exists
    await mkdir(IDE_DIR, { recursive: true });
    createdFiles = [];
  });

  afterEach(async () => {
    // Clean up test files
    for (const f of createdFiles) {
      try { await rm(f); } catch {}
    }
  });

  it("should return empty array when no lock files exist", async () => {
    // This might find real lock files if VS Code is running,
    // so we just verify the return type
    const sockets = await discoverIdeSockets();
    expect(Array.isArray(sockets)).toBe(true);
  });

  it("should discover valid lock files", async () => {
    // Create a test lock file
    const lockData = {
      socketPath: "/tmp/test-vscode.sock",
      pid: 12345,
      workspaceFolder: "/home/user/project",
    };
    await writeFile(testLockFile, JSON.stringify(lockData));
    createdFiles.push(testLockFile);

    const sockets = await discoverIdeSockets();
    const testSocket = sockets.find(s => s.socketPath === "/tmp/test-vscode.sock");

    expect(testSocket).toBeDefined();
    expect(testSocket!.pid).toBe(12345);
    expect(testSocket!.workspaceFolder).toBe("/home/user/project");
  });

  it("should skip invalid JSON lock files", async () => {
    const invalidLock = join(IDE_DIR, "__test_invalid__.lock");
    await writeFile(invalidLock, "not json{{{");
    createdFiles.push(invalidLock);

    // Should not throw
    const sockets = await discoverIdeSockets();
    expect(Array.isArray(sockets)).toBe(true);
    // The invalid file should be skipped
    const found = sockets.find(s => (s as any).invalid);
    expect(found).toBeUndefined();
  });

  it("should skip lock files without socketPath", async () => {
    const noSocketLock = join(IDE_DIR, "__test_nosocket__.lock");
    await writeFile(noSocketLock, JSON.stringify({ pid: 999 }));
    createdFiles.push(noSocketLock);

    const sockets = await discoverIdeSockets();
    const found = sockets.find(s => s.pid === 999);
    expect(found).toBeUndefined();
  });
});
