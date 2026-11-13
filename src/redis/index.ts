/**
 * Redis cluster adapter (works with ioredis ≥ 5).
 *
 * @example
 * import { Redis } from 'ioredis';
 * import { RedisAdapter } from 'node-ocpp/redis';
 *
 * const adapter = new RedisAdapter({ redis: new Redis(process.env.REDIS_URL) });
 * const cs = new ocpp16.Server({ cluster: { adapter } });
 */
import type { ClusterAdapter } from '../common/cluster/adapter.js';

/** The subset of the ioredis client API the adapter uses. */
export interface RedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, millisecondsToken: 'PX', milliseconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  scan(
    cursor: string,
    patternToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[cursor: string, keys: string[]]>;
  eval(script: string, numKeys: number, key: string, arg: string): Promise<unknown>;
  /** Used to create the dedicated subscriber connection. */
  duplicate(): RedisSubscriberLike;
}

export interface RedisSubscriberLike {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export interface RedisAdapterOptions {
  /** Your Redis client. It is not closed by the adapter. */
  redis: RedisLike;
}

/** Atomic compare-and-delete. */
const DELETE_IF_EQUALS = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Escapes glob characters for SCAN MATCH. */
const escapeGlob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&');

export class RedisAdapter implements ClusterAdapter {
  readonly #redis: RedisLike;
  readonly #listeners = new Map<string, Set<(message: string) => void>>();
  #subscriber: RedisSubscriberLike | undefined;

  constructor({ redis }: RedisAdapterOptions) {
    this.#redis = redis;
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.#redis.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void) {
    const subscriber = this.#connect();
    let listeners = this.#listeners.get(channel);
    if (!listeners) {
      this.#listeners.set(channel, (listeners = new Set()));
      await subscriber.subscribe(channel);
    }
    listeners.add(listener);
    return async () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(channel) === listeners) {
        this.#listeners.delete(channel);
        await subscriber.unsubscribe(channel);
      }
    };
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl === undefined) await this.#redis.set(key, value);
    else await this.#redis.set(key, value, 'PX', Math.max(1, Math.ceil(ttl)));
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.#redis.get(key)) ?? undefined;
  }

  async delete(key: string, expected?: string): Promise<boolean> {
    if (expected === undefined) return (await this.#redis.del(key)) > 0;
    return Number(await this.#redis.eval(DELETE_IF_EQUALS, 1, key, expected)) === 1;
  }

  async scan(prefix: string): Promise<Map<string, string>> {
    const keys = new Set<string>();
    let cursor = '0';
    do {
      const [next, batch] = await this.#redis.scan(
        cursor,
        'MATCH',
        `${escapeGlob(prefix)}*`,
        'COUNT',
        500,
      );
      for (const key of batch) keys.add(key);
      cursor = next;
    } while (cursor !== '0');

    const result = new Map<string, string>();
    const all = [...keys];
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500);
      const values = await this.#redis.mget(...chunk);
      chunk.forEach((key, j) => {
        const value = values[j];
        if (value !== null && value !== undefined) result.set(key, value); // expired meanwhile
      });
    }
    return result;
  }

  /** Closes the subscriber connection created by the adapter. */
  async close(): Promise<void> {
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    this.#listeners.clear();
    await subscriber?.quit();
  }

  #connect(): RedisSubscriberLike {
    if (!this.#subscriber) {
      this.#subscriber = this.#redis.duplicate();
      this.#subscriber.on('message', (channel, message) => {
        for (const listener of this.#listeners.get(channel) ?? []) listener(message);
      });
    }
    return this.#subscriber;
  }
}

export type { ClusterAdapter } from '../common/cluster/adapter.js';
