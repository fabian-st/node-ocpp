import { Redis } from 'ioredis';
import { describe, it } from 'vitest';
import { RedisAdapter } from '../src/redis/index.js';
import { clusterSuite } from './cluster-suite.js';
import { defer } from './helpers.js';

/** Runs against a real Redis when REDIS_URL is set, e.g. `REDIS_URL=redis://localhost:6379 npm test`. */
const url = process.env.REDIS_URL;

if (url) {
  clusterSuite('redis', () => {
    const redis = new Redis(url);
    defer({ close: () => redis.quit() });
    return defer(new RedisAdapter({ redis }));
  });
} else {
  describe('cluster (redis)', () => it.skip('set REDIS_URL to run against Redis', () => {}));
}
