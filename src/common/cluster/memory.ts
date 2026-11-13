import type { ClusterAdapter } from './adapter.js';

/**
 * In-process adapter: lets several servers in one process form a cluster.
 * Useful for tests and as reference implementation; not for multi-process setups.
 */
export class MemoryAdapter implements ClusterAdapter {
  readonly #entries = new Map<string, { value: string; expires: number }>();
  readonly #channels = new Map<string, Set<(message: string) => void>>();

  async publish(channel: string, message: string): Promise<void> {
    // Deliver asynchronously, like a real network would.
    for (const listener of this.#channels.get(channel) ?? []) setImmediate(listener, message);
  }

  async subscribe(channel: string, listener: (message: string) => void) {
    let listeners = this.#channels.get(channel);
    if (!listeners) this.#channels.set(channel, (listeners = new Set()));
    const own = (message: string) => listener(message);
    listeners.add(own);
    return async () => {
      listeners.delete(own);
    };
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    this.#entries.set(key, { value, expires: ttl === undefined ? Infinity : Date.now() + ttl });
  }

  async get(key: string): Promise<string | undefined> {
    return this.#live(key);
  }

  async delete(key: string, expected?: string): Promise<boolean> {
    const value = this.#live(key);
    if (value === undefined || (expected !== undefined && value !== expected)) return false;
    return this.#entries.delete(key);
  }

  async scan(prefix: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const key of this.#entries.keys()) {
      const value = key.startsWith(prefix) ? this.#live(key) : undefined;
      if (value !== undefined) result.set(key, value);
    }
    return result;
  }

  #live(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (entry && entry.expires <= Date.now()) this.#entries.delete(key);
    else return entry?.value;
    return undefined;
  }
}
