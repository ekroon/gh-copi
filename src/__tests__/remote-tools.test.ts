import { describe, it, expect } from "vitest";
import { createRemoteTools, shellEscape } from "../remote-tools.js";
import type { RemoteTransport, ExecResult } from "../transport/types.js";

/**
 * InMemoryTransport — a real transport implementation backed by in-memory
 * filesystem. No mocking frameworks used — this is a concrete implementation
 * of the RemoteTransport interface.
 */
class InMemoryTransport implements RemoteTransport {
  readonly name = "memory";
  files = new Map<string, string>();
  execLog: Array<{ command: string; cwd: string }> = [];
  execResult: ExecResult = { stdout: "", stderr: "", exitCode: 0 };

  async exec(command: string, cwd: string): Promise<ExecResult> {
    this.execLog.push({ command, cwd });
    return this.execResult;
  }

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
    return content;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }
}

describe("shellEscape", () => {
  it("should wrap in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("should escape embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("should handle empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("should handle special characters", () => {
    expect(shellEscape("$HOME && rm -rf /")).toBe("'$HOME && rm -rf /'");
  });

  it("should handle multiple single quotes", () => {
    expect(shellEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("should handle newlines", () => {
    expect(shellEscape("line1\nline2")).toBe("'line1\nline2'");
  });
});

describe("createRemoteTools", () => {
  it("should return 7 tools", () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    expect(tools).toHaveLength(7);
  });

  it("should have correct tool names", () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(["bash", "create", "edit", "glob", "grep", "ls", "view"]);
  });

  it("should include transport name in labels", () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    for (const tool of tools) {
      expect(tool.label).toContain("memory");
    }
  });

  it("should include workdir in bash description", () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/my/project");
    const bash = tools.find(t => t.name === "bash")!;
    expect(bash.description).toContain("/my/project");
  });

  it("should have parameters defined for all tools", () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    for (const tool of tools) {
      expect(tool.parameters).toBeDefined();
      expect(tool.parameters.type).toBe("object");
    }
  });
});

describe("bash tool", () => {
  it("should execute command via transport", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "hello\n", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const bash = tools.find(t => t.name === "bash")!;

    const result = await bash.execute("tc1", { command: "echo hello" });
    expect(result.content[0]).toEqual({ type: "text", text: "hello" });
    expect(result.details).toEqual({ exitCode: 0, command: "echo hello" });
    expect(transport.execLog[0].command).toBe("echo hello");
    expect(transport.execLog[0].cwd).toBe("/workspace");
  });

  it("should combine stdout and stderr", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "out\n", stderr: "err\n", exitCode: 1 };
    const tools = createRemoteTools(transport, "/workspace");
    const bash = tools.find(t => t.name === "bash")!;

    const result = await bash.execute("tc1", { command: "failing" });
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as any).text).toContain("out");
    expect((result.content[0] as any).text).toContain("err");
  });

  it("should return '(no output)' for empty output", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const bash = tools.find(t => t.name === "bash")!;

    const result = await bash.execute("tc1", { command: "true" });
    expect((result.content[0] as any).text).toBe("(no output)");
  });
});

describe("view tool (read file)", () => {
  it("should read file and add line numbers", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/test.txt", "line1\nline2\nline3");
    const tools = createRemoteTools(transport, "/workspace");
    const view = tools.find(t => t.name === "view")!;

    const result = await view.execute("tc1", { path: "/workspace/test.txt" });
    const text = (result.content[0] as any).text;
    expect(text).toContain("1. line1");
    expect(text).toContain("2. line2");
    expect(text).toContain("3. line3");
  });

  it("should support view_range", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/code.ts", "a\nb\nc\nd\ne");
    const tools = createRemoteTools(transport, "/workspace");
    const view = tools.find(t => t.name === "view")!;

    const result = await view.execute("tc1", {
      path: "/workspace/code.ts",
      view_range: [2, 4],
    });
    const text = (result.content[0] as any).text;
    expect(text).toContain("2. b");
    expect(text).toContain("3. c");
    expect(text).toContain("4. d");
    expect(text).not.toContain("1. a");
    expect(text).not.toContain("5. e");
  });

  it("should support view_range with -1 for end of file", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/code.ts", "a\nb\nc\nd\ne");
    const tools = createRemoteTools(transport, "/workspace");
    const view = tools.find(t => t.name === "view")!;

    const result = await view.execute("tc1", {
      path: "/workspace/code.ts",
      view_range: [4, -1],
    });
    const text = (result.content[0] as any).text;
    expect(text).toContain("4. d");
    expect(text).toContain("5. e");
    expect(text).not.toContain("3. c");
  });

  it("should resolve relative paths against workdir", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/src/main.ts", "content");
    const tools = createRemoteTools(transport, "/workspace");
    const view = tools.find(t => t.name === "view")!;

    const result = await view.execute("tc1", { path: "src/main.ts" });
    expect((result.content[0] as any).text).toContain("content");
  });

  it("should return error for non-existent file", async () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    const view = tools.find(t => t.name === "view")!;

    const result = await view.execute("tc1", { path: "/nope.txt" });
    expect((result.content[0] as any).text).toContain("Error reading file");
  });
});

describe("create tool (write file)", () => {
  it("should write file content", async () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    const create = tools.find(t => t.name === "create")!;

    await create.execute("tc1", {
      path: "/workspace/new.txt",
      file_text: "new content",
    });
    expect(transport.files.get("/workspace/new.txt")).toBe("new content");
  });

  it("should resolve relative paths", async () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    const create = tools.find(t => t.name === "create")!;

    await create.execute("tc1", {
      path: "relative.txt",
      file_text: "data",
    });
    expect(transport.files.get("/workspace/relative.txt")).toBe("data");
  });

  it("should return success message with full path", async () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    const create = tools.find(t => t.name === "create")!;

    const result = await create.execute("tc1", {
      path: "/workspace/file.txt",
      file_text: "x",
    });
    expect((result.content[0] as any).text).toBe("File written: /workspace/file.txt");
  });
});

describe("edit tool", () => {
  it("should replace old_str with new_str", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/code.ts", "const x = 1;\nconst y = 2;");
    const tools = createRemoteTools(transport, "/workspace");
    const edit = tools.find(t => t.name === "edit")!;

    const result = await edit.execute("tc1", {
      path: "/workspace/code.ts",
      old_str: "const x = 1;",
      new_str: "const x = 42;",
    });
    expect(transport.files.get("/workspace/code.ts")).toBe("const x = 42;\nconst y = 2;");
    expect((result.content[0] as any).text).toContain("File edited");
  });

  it("should error when old_str not found", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/code.ts", "hello");
    const tools = createRemoteTools(transport, "/workspace");
    const edit = tools.find(t => t.name === "edit")!;

    const result = await edit.execute("tc1", {
      path: "/workspace/code.ts",
      old_str: "nonexistent",
      new_str: "replacement",
    });
    expect((result.content[0] as any).text).toContain("not found");
  });

  it("should error when old_str has multiple occurrences", async () => {
    const transport = new InMemoryTransport();
    transport.files.set("/workspace/code.ts", "foo bar foo");
    const tools = createRemoteTools(transport, "/workspace");
    const edit = tools.find(t => t.name === "edit")!;

    const result = await edit.execute("tc1", {
      path: "/workspace/code.ts",
      old_str: "foo",
      new_str: "baz",
    });
    expect((result.content[0] as any).text).toContain("found 2 times");
    // File should NOT be modified
    expect(transport.files.get("/workspace/code.ts")).toBe("foo bar foo");
  });

  it("should error for non-existent file", async () => {
    const transport = new InMemoryTransport();
    const tools = createRemoteTools(transport, "/workspace");
    const edit = tools.find(t => t.name === "edit")!;

    const result = await edit.execute("tc1", {
      path: "/workspace/nope.ts",
      old_str: "a",
      new_str: "b",
    });
    expect((result.content[0] as any).text).toContain("Error editing file");
  });
});

describe("grep tool", () => {
  it("should execute grep command via transport", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "src/main.ts:5:hello\n", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const grep = tools.find(t => t.name === "grep")!;

    const result = await grep.execute("tc1", { pattern: "hello" });
    expect((result.content[0] as any).text).toContain("src/main.ts:5:hello");
    expect(transport.execLog[0].command).toContain("rg");
    expect(transport.execLog[0].command).toContain("'hello'");
  });

  it("should include glob filter when specified", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "", stderr: "", exitCode: 1 };
    const tools = createRemoteTools(transport, "/workspace");
    const grep = tools.find(t => t.name === "grep")!;

    await grep.execute("tc1", { pattern: "test", glob: "*.ts" });
    expect(transport.execLog[0].command).toContain("--glob");
    expect(transport.execLog[0].command).toContain("'*.ts'");
  });

  it("should return '(no matches)' for empty output", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "", stderr: "", exitCode: 1 };
    const tools = createRemoteTools(transport, "/workspace");
    const grep = tools.find(t => t.name === "grep")!;

    const result = await grep.execute("tc1", { pattern: "nonexistent" });
    expect((result.content[0] as any).text).toBe("(no matches)");
  });
});

describe("glob tool (find files)", () => {
  it("should execute find command via transport", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "./src/main.ts\n./src/app.ts\n", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const glob = tools.find(t => t.name === "glob")!;

    const result = await glob.execute("tc1", { pattern: "*.ts" });
    expect((result.content[0] as any).text).toContain("main.ts");
    expect(transport.execLog[0].command).toContain("find");
  });

  it("should return '(no files found)' for empty output", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const glob = tools.find(t => t.name === "glob")!;

    const result = await glob.execute("tc1", { pattern: "*.xyz" });
    expect((result.content[0] as any).text).toBe("(no files found)");
  });
});

describe("ls tool", () => {
  it("should execute ls command via transport", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = {
      stdout: "total 8\n-rw-r--r--  1 user group  42 Jan  1 00:00 file.txt\n",
      stderr: "",
      exitCode: 0,
    };
    const tools = createRemoteTools(transport, "/workspace");
    const ls = tools.find(t => t.name === "ls")!;

    const result = await ls.execute("tc1", {});
    expect((result.content[0] as any).text).toContain("file.txt");
    expect(transport.execLog[0].command).toContain("ls -la");
  });

  it("should use custom path when specified", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "stuff\n", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const ls = tools.find(t => t.name === "ls")!;

    await ls.execute("tc1", { path: "/tmp" });
    expect(transport.execLog[0].command).toContain("'/tmp'");
  });

  it("should return '(empty directory)' for empty output", async () => {
    const transport = new InMemoryTransport();
    transport.execResult = { stdout: "", stderr: "", exitCode: 0 };
    const tools = createRemoteTools(transport, "/workspace");
    const ls = tools.find(t => t.name === "ls")!;

    const result = await ls.execute("tc1", {});
    expect((result.content[0] as any).text).toBe("(empty directory)");
  });
});
