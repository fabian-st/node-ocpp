type LogFn = (message: string, ...meta: unknown[]) => void;

/** Compatible with `console`, pino, winston, bunyan & co. */
export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

const noop = () => {};

/** The default: silent. */
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
