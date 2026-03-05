/**
 * TransportRegistry — manages multiple RemoteTransport instances.
 *
 * Supports multi-target mode where tools can route to different transports.
 */
import type { RemoteTransport } from "./transport/types.js";

export class TransportRegistry {
  private transports = new Map<string, RemoteTransport>();
  private defaultAlias?: string;

  /** Register a transport under an alias */
  register(alias: string, transport: RemoteTransport): void {
    this.transports.set(alias, transport);
    if (!this.defaultAlias) {
      this.defaultAlias = alias;
    }
  }

  /** Unregister a transport */
  unregister(alias: string): void {
    this.transports.delete(alias);
    if (this.defaultAlias === alias) {
      this.defaultAlias = this.transports.keys().next().value;
    }
  }

  /** Get a transport by alias */
  get(alias: string): RemoteTransport | undefined {
    return this.transports.get(alias);
  }

  /** Get the default transport */
  getDefault(): RemoteTransport | undefined {
    if (this.defaultAlias) {
      return this.transports.get(this.defaultAlias);
    }
    return undefined;
  }

  /** Set the default transport */
  setDefault(alias: string): void {
    if (!this.transports.has(alias)) {
      throw new Error(`Transport "${alias}" not registered`);
    }
    this.defaultAlias = alias;
  }

  /** List all registered transports */
  list(): Array<{ alias: string; name: string; isDefault: boolean }> {
    return Array.from(this.transports.entries()).map(([alias, transport]) => ({
      alias,
      name: transport.name,
      isDefault: alias === this.defaultAlias,
    }));
  }

  /** Number of registered transports */
  get size(): number {
    return this.transports.size;
  }

  /** Set up all transports */
  async setupAll(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.setup?.();
    }
  }

  /** Tear down all transports */
  async teardownAll(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.teardown?.();
    }
  }
}
