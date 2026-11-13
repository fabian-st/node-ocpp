import { OcppError } from './errors.js';
import type { CallContext, Handler, Middleware } from './types.js';

/** Holds one handler per action plus a middleware chain, and runs inbound calls through them. */
export class Router<S> {
  readonly #handlers = new Map<string, Handler<any, any, S>>();
  readonly #middleware: Middleware<S>[] = [];

  /** Registers (or replaces) the handler of `action`. */
  set(action: string, handler: Handler<any, any, S>): void {
    this.#handlers.set(action, handler);
  }

  delete(action: string): boolean {
    return this.#handlers.delete(action);
  }

  has(action: string): boolean {
    return this.#handlers.has(action);
  }

  use(middleware: Middleware<S>): void {
    this.#middleware.push(middleware);
  }

  /** Runs middleware and handler; resolves with the response payload. */
  async dispatch(context: CallContext<S>): Promise<unknown> {
    let index = -1;
    const run = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      const middleware = this.#middleware[i];
      if (middleware) return void (await middleware(context, () => run(i + 1)));

      const handler = this.#handlers.get(context.action);
      if (!handler) {
        throw new OcppError('NotSupported', `No handler registered for ${context.action}`);
      }
      context.response = await handler(context.request, context);
    };
    await run(0);
    return context.response;
  }
}
