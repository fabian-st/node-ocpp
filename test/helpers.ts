import { once } from 'node:events';
import { afterEach } from 'vitest';

const cleanups: (() => unknown)[] = [];

/** Registers a teardown that runs after the current test. */
export function defer<T extends { close(): unknown }>(resource: T): T {
  cleanups.push(() => resource.close());
  return resource;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { once };
