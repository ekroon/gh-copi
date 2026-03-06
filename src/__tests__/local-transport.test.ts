import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalTransport } from "../transport/local.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LocalTransport", () => {
  let transport: LocalTransport;
  let tempDir: string;

  beforeEach(async () => {
    transport = new LocalTransport();
    tempDir = await mkdtemp(join(tmpdir(), "gh-pico-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should have name 'local'", () => {
    expect(transport.name).toBe("local");
  });

  describe("exec", () => {
    it("should execute a command and return stdout", async () => {
      const result = await transport.exec("echo hello", tempDir);
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("should capture stderr", async () => {
      const result = await transport.exec("echo error >&2", tempDir);
      expect(result.stderr.trim()).toBe("error");
      expect(result.exitCode).toBe(0);
    });

    it("should return non-zero exit code for failing commands", async () => {
      const result = await transport.exec("exit 42", tempDir);
      expect(result.exitCode).toBe(42);
    });

    it("should use the specified cwd", async () => {
      const result = await transport.exec("pwd", tempDir);
      // macOS resolves /var → /private/var, so use realpath
      const { realpath } = await import("node:fs/promises");
      const realTempDir = await realpath(tempDir);
      expect(result.stdout.trim()).toBe(realTempDir);
    });

    it("should call onData callback with streaming output", async () => {
      const chunks: string[] = [];
      const result = await transport.exec("echo chunk1; echo chunk2", tempDir, {
        onData: (data) => chunks.push(data.toString()),
      });
      expect(result.exitCode).toBe(0);
      const joined = chunks.join("");
      expect(joined).toContain("chunk1");
      expect(joined).toContain("chunk2");
    });

    it("should merge environment variables", async () => {
      const result = await transport.exec("echo $MY_TEST_VAR", tempDir, {
        env: { MY_TEST_VAR: "test_value_42" },
      });
      expect(result.stdout.trim()).toBe("test_value_42");
    });

    it("should timeout and reject", async () => {
      await expect(
        transport.exec("sleep 10", tempDir, { timeout: 100 }),
      ).rejects.toThrow("timed out");
    });

    it("should handle AbortSignal", async () => {
      const controller = new AbortController();
      const promise = transport.exec("sleep 10", tempDir, {
        signal: controller.signal,
      });
      // Abort after a short delay
      setTimeout(() => controller.abort(), 50);
      await expect(promise).rejects.toThrow();
    });

    it("should handle commands with special characters", async () => {
      const result = await transport.exec(
        `echo "hello world" && echo 'single quotes'`,
        tempDir,
      );
      expect(result.stdout).toContain("hello world");
      expect(result.stdout).toContain("single quotes");
    });

    it("should capture both stdout and stderr together", async () => {
      const result = await transport.exec(
        "echo out; echo err >&2",
        tempDir,
      );
      expect(result.stdout.trim()).toBe("out");
      expect(result.stderr.trim()).toBe("err");
    });
  });

  describe("readFile", () => {
    it("should read file contents", async () => {
      const filePath = join(tempDir, "test.txt");
      await writeFile(filePath, "hello world", "utf-8");
      const content = await transport.readFile(filePath);
      expect(content).toBe("hello world");
    });

    it("should throw for non-existent file", async () => {
      await expect(
        transport.readFile(join(tempDir, "nonexistent.txt")),
      ).rejects.toThrow();
    });
  });

  describe("writeFile", () => {
    it("should write file contents", async () => {
      const filePath = join(tempDir, "output.txt");
      await transport.writeFile(filePath, "written content");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("written content");
    });

    it("should overwrite existing file", async () => {
      const filePath = join(tempDir, "overwrite.txt");
      await writeFile(filePath, "old", "utf-8");
      await transport.writeFile(filePath, "new");
      const content = await readFile(filePath, "utf-8");
      expect(content).toBe("new");
    });
  });

  describe("exists", () => {
    it("should return true for existing file", async () => {
      const filePath = join(tempDir, "exists.txt");
      await writeFile(filePath, "", "utf-8");
      expect(await transport.exists(filePath)).toBe(true);
    });

    it("should return false for non-existent file", async () => {
      expect(await transport.exists(join(tempDir, "nope.txt"))).toBe(false);
    });

    it("should return true for existing directory", async () => {
      expect(await transport.exists(tempDir)).toBe(true);
    });
  });
});
