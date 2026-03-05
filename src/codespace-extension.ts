/**
 * Codespace Extension — lifecycle management and shell escape routing.
 *
 * Provides:
 * - /cs command for codespace management
 * - ! shell escape routing via user_bash event → codespace
 * - Multi-target picker when multiple transports connected
 */
import type { TransportRegistry } from "./registry.js";

/**
 * Create a pi-mono extension for codespace management.
 *
 * Intercepts ! shell escapes to route them through the active transport
 * instead of running locally.
 */
export function createCodespaceExtension(registry: TransportRegistry) {
  return {
    name: "codespace",
    description: "Codespace lifecycle and shell escape routing",

    async activate(ctx: any) {
      // Route ! shell escapes to the active transport
      ctx.on("user_bash", async (event: any) => {
        const transport = registry.getDefault();
        if (!transport || transport.name === "local") {
          return {}; // Let pi-mono handle locally
        }

        // Execute on remote transport
        return {
          operations: {
            exec: async (
              command: string,
              cwd: string,
              options: any,
            ) => {
              const result = await transport.exec(command, cwd);
              if (options?.onData) {
                options.onData(Buffer.from(result.stdout));
                if (result.stderr) {
                  options.onData(Buffer.from(result.stderr));
                }
              }
              return { exitCode: result.exitCode };
            },
          },
        };
      });

      // Register /cs command
      ctx.registerCommand("cs", {
        description: "Manage codespace connections",
        execute: async (cmdCtx: any) => {
          const args = cmdCtx.args?.trim();

          if (!args || args === "list") {
            const transports = registry.list();
            const lines = transports.map(
              (t) =>
                `  ${t.isDefault ? "▸" : " "} ${t.alias} → ${t.name}`,
            );
            ctx.ui.notify(
              `Connected transports:\n${lines.join("\n")}`,
              "info",
            );
            return;
          }

          if (args.startsWith("switch ")) {
            const alias = args.slice(7).trim();
            try {
              registry.setDefault(alias);
              ctx.ui.notify(
                `Switched to ${alias}`,
                "info",
              );
            } catch (err: any) {
              ctx.ui.notify(err.message, "error");
            }
            return;
          }

          ctx.ui.notify(
            "Usage: /cs [list|switch <alias>]",
            "info",
          );
        },
      });
    },
  };
}
