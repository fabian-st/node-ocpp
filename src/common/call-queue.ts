interface Entry {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Runs outbound calls strictly one after another, as OCPP-J requires
 * ("a party SHOULD NOT send a CALL while a previous one is outstanding").
 * While paused (e.g. offline) calls accumulate and are sent once resumed.
 */
export class CallQueue {
  readonly #entries: Entry[] = [];
  #busy = false;
  #paused: boolean;

  constructor({ paused = false } = {}) {
    this.#paused = paused;
  }

  get size(): number {
    return this.#entries.length;
  }

  push<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted();
      const entry: Entry = { run, resolve: resolve as (v: unknown) => void, reject, signal };
      if (signal) {
        entry.onAbort = () => {
          const i = this.#entries.indexOf(entry);
          if (i >= 0) this.#entries.splice(i, 1);
          reject(signal.reason);
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#entries.push(entry);
      this.#next();
    });
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    this.#next();
  }

  /** Rejects every call that has not been started yet. */
  clear(reason: Error): void {
    for (const entry of this.#entries.splice(0)) {
      this.#detach(entry);
      entry.reject(reason);
    }
  }

  #next(): void {
    if (this.#busy || this.#paused) return;
    const entry = this.#entries.shift();
    if (!entry) return;
    this.#detach(entry);
    this.#busy = true;
    entry
      .run()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.#busy = false;
        this.#next();
      });
  }

  #detach(entry: Entry) {
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
  }
}
