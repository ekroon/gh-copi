import { describe, it, expect } from "vitest";
import { parseArgs } from "../main.js";

describe("parseArgs", () => {
  // Helper: simulates process.argv (first 2 elements are node + script)
  function parse(...args: string[]) {
    return parseArgs(["node", "gh-pico", ...args]);
  }

  describe("defaults", () => {
    it("should return defaults with no arguments", () => {
      const result = parse();
      expect(result.codespaces).toEqual([]);
      expect(result.ssh).toBeUndefined();
      expect(result.devcontainer).toBe(false);
      expect(result.resume).toBe(false);
      expect(result.workdir).toBe(process.cwd());
    });
  });

  describe("-c / --codespace", () => {
    it("should parse single codespace name with -c", () => {
      const result = parse("-c", "my-cs");
      expect(result.codespaces).toEqual(["my-cs"]);
    });

    it("should parse single codespace name with --codespace", () => {
      const result = parse("--codespace", "my-cs");
      expect(result.codespaces).toEqual(["my-cs"]);
    });

    it("should parse comma-separated codespace names", () => {
      const result = parse("-c", "cs1,cs2,cs3");
      expect(result.codespaces).toEqual(["cs1", "cs2", "cs3"]);
    });

    it("should accumulate multiple -c flags", () => {
      const result = parse("-c", "cs1", "-c", "cs2");
      expect(result.codespaces).toEqual(["cs1", "cs2"]);
    });
  });

  describe("--ssh", () => {
    it("should parse user@host:path format", () => {
      const result = parse("--ssh", "user@server:/home/project");
      expect(result.ssh).toEqual({
        host: "user@server",
        remotePath: "/home/project",
      });
    });

    it("should default to /workspace when no path given", () => {
      const result = parse("--ssh", "user@server");
      expect(result.ssh).toEqual({
        host: "user@server",
        remotePath: "/workspace",
      });
    });

    it("should handle host with port-like path", () => {
      const result = parse("--ssh", "user@server:/work/project");
      expect(result.ssh!.host).toBe("user@server");
      expect(result.ssh!.remotePath).toBe("/work/project");
    });
  });

  describe("--devcontainer", () => {
    it("should set devcontainer flag", () => {
      const result = parse("--devcontainer");
      expect(result.devcontainer).toBe(true);
    });
  });

  describe("--resume", () => {
    it("should set resume flag", () => {
      const result = parse("--resume");
      expect(result.resume).toBe(true);
    });
  });

  describe("--workdir / -w", () => {
    it("should parse workdir with --workdir", () => {
      const result = parse("--workdir", "/tmp/project");
      expect(result.workdir).toBe("/tmp/project");
    });

    it("should parse workdir with -w", () => {
      const result = parse("-w", "/tmp/project");
      expect(result.workdir).toBe("/tmp/project");
    });
  });

  describe("combined flags", () => {
    it("should handle codespace + resume + workdir together", () => {
      const result = parse("-c", "my-cs", "--resume", "-w", "/tmp");
      expect(result.codespaces).toEqual(["my-cs"]);
      expect(result.resume).toBe(true);
      expect(result.workdir).toBe("/tmp");
    });
  });
});
