import { describe, it, expect, beforeEach } from "vitest";
import { createCodespaceExtension } from "../codespace-extension.js";
import { TransportRegistry } from "../registry.js";
import type { RemoteTransport } from "../transport/types.js";

function makeTransport(name: string, execFn?: (cmd: string, cwd: string) => Promise<any>): RemoteTransport {
  return {
    name,
    async exec(command: string, cwd: string) {
      if (execFn) return execFn(command, cwd);
      return { stdout: "remote output", stderr: "", exitCode: 0 };
    },
    async readFile() { return ""; },
    async writeFile() {},
    async exists() { return false; },
  };
}

describe("createCodespaceExtension", () => {
  let registry: TransportRegistry;

  beforeEach(() => {
    registry = new TransportRegistry();
  });

  it("should return extension with name and description", () => {
    const ext = createCodespaceExtension(registry);
    expect(ext.name).toBe("codespace");
    expect(ext.description).toContain("Codespace");
  });

  describe("user_bash event handler", () => {
    it("should let pi-mono handle locally when transport is local", async () => {
      registry.register("local", makeTransport("local"));
      const ext = createCodespaceExtension(registry);

      let userBashHandler: any;
      let csCommandHandler: any;
      const ctx = {
        on(event: string, handler: any) { if (event === "user_bash") userBashHandler = handler; },
        registerCommand(_name: string, cmd: any) { csCommandHandler = cmd; },
        ui: { notify() {} },
      };

      await ext.activate(ctx);
      const result = await userBashHandler({ command: "ls" });
      expect(result).toEqual({}); // Empty = let pi-mono handle
    });

    it("should route to remote transport when not local", async () => {
      const execCalls: string[] = [];
      registry.register("cs1", makeTransport("codespace:cs1", async (cmd) => {
        execCalls.push(cmd);
        return { stdout: "remote files", stderr: "", exitCode: 0 };
      }));

      const ext = createCodespaceExtension(registry);
      let userBashHandler: any;
      const ctx = {
        on(event: string, handler: any) { if (event === "user_bash") userBashHandler = handler; },
        registerCommand() {},
        ui: { notify() {} },
      };

      await ext.activate(ctx);
      const result = await userBashHandler({ command: "ls" });

      expect(result.operations).toBeDefined();
      expect(result.operations.exec).toBeDefined();

      // Call the exec function to verify it routes to transport
      const dataChunks: string[] = [];
      const execResult = await result.operations.exec("ls", "/workspace", {
        onData: (data: Buffer) => dataChunks.push(data.toString()),
      });

      expect(execCalls).toHaveLength(1);
      expect(execCalls[0]).toBe("ls");
      expect(execResult.exitCode).toBe(0);
      expect(dataChunks.join("")).toContain("remote files");
    });

    it("should return empty when no transport registered", async () => {
      const ext = createCodespaceExtension(registry);
      let userBashHandler: any;
      const ctx = {
        on(event: string, handler: any) { if (event === "user_bash") userBashHandler = handler; },
        registerCommand() {},
        ui: { notify() {} },
      };

      await ext.activate(ctx);
      const result = await userBashHandler({ command: "ls" });
      expect(result).toEqual({});
    });
  });

  describe("/cs command", () => {
    it("should list transports on /cs list", async () => {
      registry.register("cs1", makeTransport("codespace:cs1"));
      registry.register("cs2", makeTransport("codespace:cs2"));

      const ext = createCodespaceExtension(registry);
      let csCommandExecute: any;
      const notifications: Array<{ msg: string; level: string }> = [];
      const ctx = {
        on() {},
        registerCommand(_name: string, cmd: any) { csCommandExecute = cmd.execute; },
        ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      };

      await ext.activate(ctx);
      await csCommandExecute({ args: "list" });

      expect(notifications).toHaveLength(1);
      expect(notifications[0].msg).toContain("cs1");
      expect(notifications[0].msg).toContain("cs2");
      expect(notifications[0].msg).toContain("▸"); // Default marker
    });

    it("should list transports on /cs (no args)", async () => {
      registry.register("cs1", makeTransport("codespace:cs1"));

      const ext = createCodespaceExtension(registry);
      let csCommandExecute: any;
      const notifications: Array<{ msg: string; level: string }> = [];
      const ctx = {
        on() {},
        registerCommand(_name: string, cmd: any) { csCommandExecute = cmd.execute; },
        ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      };

      await ext.activate(ctx);
      await csCommandExecute({ args: "" });

      expect(notifications).toHaveLength(1);
      expect(notifications[0].msg).toContain("cs1");
    });

    it("should switch default transport", async () => {
      registry.register("cs1", makeTransport("codespace:cs1"));
      registry.register("cs2", makeTransport("codespace:cs2"));

      const ext = createCodespaceExtension(registry);
      let csCommandExecute: any;
      const notifications: Array<{ msg: string; level: string }> = [];
      const ctx = {
        on() {},
        registerCommand(_name: string, cmd: any) { csCommandExecute = cmd.execute; },
        ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      };

      await ext.activate(ctx);
      await csCommandExecute({ args: "switch cs2" });

      expect(notifications[0].msg).toContain("cs2");
      expect(registry.getDefault()!.name).toBe("codespace:cs2");
    });

    it("should show error for invalid switch target", async () => {
      registry.register("cs1", makeTransport("codespace:cs1"));

      const ext = createCodespaceExtension(registry);
      let csCommandExecute: any;
      const notifications: Array<{ msg: string; level: string }> = [];
      const ctx = {
        on() {},
        registerCommand(_name: string, cmd: any) { csCommandExecute = cmd.execute; },
        ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      };

      await ext.activate(ctx);
      await csCommandExecute({ args: "switch nonexistent" });

      expect(notifications[0].level).toBe("error");
    });

    it("should show usage for unknown subcommand", async () => {
      const ext = createCodespaceExtension(registry);
      let csCommandExecute: any;
      const notifications: Array<{ msg: string; level: string }> = [];
      const ctx = {
        on() {},
        registerCommand(_name: string, cmd: any) { csCommandExecute = cmd.execute; },
        ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } },
      };

      await ext.activate(ctx);
      await csCommandExecute({ args: "bogus" });

      expect(notifications[0].msg).toContain("Usage");
    });
  });
});
