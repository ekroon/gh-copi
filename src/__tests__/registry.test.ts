import { describe, it, expect, beforeEach } from "vitest";
import { TransportRegistry } from "../registry.js";
import type { RemoteTransport } from "../transport/types.js";

function makeTransport(name: string): RemoteTransport {
  return {
    name,
    async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
    async readFile() { return ""; },
    async writeFile() {},
    async exists() { return false; },
  };
}

describe("TransportRegistry", () => {
  let registry: TransportRegistry;

  beforeEach(() => {
    registry = new TransportRegistry();
  });

  describe("register/get", () => {
    it("should register and retrieve a transport by alias", () => {
      const t = makeTransport("local");
      registry.register("local", t);
      expect(registry.get("local")).toBe(t);
    });

    it("should return undefined for unknown alias", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("should track size", () => {
      expect(registry.size).toBe(0);
      registry.register("a", makeTransport("a"));
      expect(registry.size).toBe(1);
      registry.register("b", makeTransport("b"));
      expect(registry.size).toBe(2);
    });
  });

  describe("default transport", () => {
    it("should set first registered as default", () => {
      const t1 = makeTransport("first");
      const t2 = makeTransport("second");
      registry.register("t1", t1);
      registry.register("t2", t2);
      expect(registry.getDefault()).toBe(t1);
    });

    it("should return undefined when empty", () => {
      expect(registry.getDefault()).toBeUndefined();
    });

    it("should allow explicitly setting default", () => {
      registry.register("a", makeTransport("a"));
      registry.register("b", makeTransport("b"));
      registry.setDefault("b");
      expect(registry.getDefault()!.name).toBe("b");
    });

    it("should throw when setting non-existent default", () => {
      expect(() => registry.setDefault("nope")).toThrow(
        'Transport "nope" not registered',
      );
    });
  });

  describe("unregister", () => {
    it("should remove a transport", () => {
      registry.register("a", makeTransport("a"));
      registry.unregister("a");
      expect(registry.get("a")).toBeUndefined();
      expect(registry.size).toBe(0);
    });

    it("should update default when unregistering current default", () => {
      registry.register("a", makeTransport("a"));
      registry.register("b", makeTransport("b"));
      expect(registry.getDefault()!.name).toBe("a");
      registry.unregister("a");
      expect(registry.getDefault()!.name).toBe("b");
    });

    it("should set default to undefined when last transport removed", () => {
      registry.register("a", makeTransport("a"));
      registry.unregister("a");
      expect(registry.getDefault()).toBeUndefined();
    });

    it("should not affect default when unregistering non-default", () => {
      registry.register("a", makeTransport("a"));
      registry.register("b", makeTransport("b"));
      registry.unregister("b");
      expect(registry.getDefault()!.name).toBe("a");
    });
  });

  describe("list", () => {
    it("should return empty array when no transports", () => {
      expect(registry.list()).toEqual([]);
    });

    it("should list all transports with default marker", () => {
      registry.register("cs1", makeTransport("codespace:cs1"));
      registry.register("cs2", makeTransport("codespace:cs2"));
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({ alias: "cs1", name: "codespace:cs1", isDefault: true });
      expect(list[1]).toEqual({ alias: "cs2", name: "codespace:cs2", isDefault: false });
    });

    it("should reflect default changes", () => {
      registry.register("a", makeTransport("a"));
      registry.register("b", makeTransport("b"));
      registry.setDefault("b");
      const list = registry.list();
      expect(list.find(t => t.alias === "a")!.isDefault).toBe(false);
      expect(list.find(t => t.alias === "b")!.isDefault).toBe(true);
    });
  });

  describe("setupAll / teardownAll", () => {
    it("should call setup on all transports that have it", async () => {
      const setupCalls: string[] = [];
      const t1: RemoteTransport = {
        ...makeTransport("a"),
        async setup() { setupCalls.push("a"); },
      };
      const t2: RemoteTransport = {
        ...makeTransport("b"),
        async setup() { setupCalls.push("b"); },
      };
      registry.register("a", t1);
      registry.register("b", t2);
      await registry.setupAll();
      expect(setupCalls).toEqual(["a", "b"]);
    });

    it("should call teardown on all transports that have it", async () => {
      const teardownCalls: string[] = [];
      const t: RemoteTransport = {
        ...makeTransport("x"),
        async teardown() { teardownCalls.push("x"); },
      };
      registry.register("x", t);
      await registry.teardownAll();
      expect(teardownCalls).toEqual(["x"]);
    });

    it("should handle transports without setup/teardown", async () => {
      registry.register("plain", makeTransport("plain"));
      // Should not throw
      await registry.setupAll();
      await registry.teardownAll();
    });
  });
});
