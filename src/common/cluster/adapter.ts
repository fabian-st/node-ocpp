/**
 * The primitives the cluster needs from a shared backend (Redis, NATS, Postgres, …):
 * fire-and-forget pub/sub plus a small key-value store with optional expiry.
 * All OCPP-specific cluster logic lives in the library; adapters stay dumb.
 */
export interface ClusterAdapter {
  /** Delivers `message` to every current subscriber of `channel` (at most once). */
  publish(channel: string, message: string): Promise<void>;

  /** Subscribes to `channel`; resolves with an unsubscribe function once active. */
  subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>>;

  /** Stores `value` under `key`, expiring after `ttl` ms if given. */
  set(key: string, value: string, ttl?: number): Promise<void>;

  get(key: string): Promise<string | undefined>;

  /**
   * Deletes `key` — if `expected` is given, only while its value still equals `expected`
   * (atomically). Resolves with whether a key was deleted.
   */
  delete(key: string, expected?: string): Promise<boolean>;

  /** All entries whose key starts with `prefix`. */
  scan(prefix: string): Promise<Map<string, string>>;

  /** Releases resources the adapter created itself (not those passed in by the user). */
  close?(): Promise<void>;
}
