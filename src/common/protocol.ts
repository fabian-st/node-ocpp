import type { ErrorKind } from './errors.js';

/** Everything the runtime needs to know about one OCPP-J protocol version. */
export interface ProtocolSpec {
  /** e.g. `1.6` */
  readonly version: string;
  /** WebSocket subprotocol, e.g. `ocpp1.6` */
  readonly subprotocol: string;
  /** Actions initiated by the charge point. */
  readonly clientActions: readonly string[];
  /** Actions initiated by the central system. */
  readonly serverActions: readonly string[];
  /** Paths of date-time fields per message name (see `meta.generated.ts`). */
  readonly dateFields: Readonly<Record<string, readonly (readonly string[])[]>>;
  /** RPC error code used for each error kind. */
  readonly errorCodes: Readonly<Record<ErrorKind, string>>;
  readonly schemas: {
    /** Directory containing `<Action>Request.json` / `<Action>Response.json`. */
    readonly dir: URL;
    readonly draft: 4 | 6;
  };
}

export const messageName = (action: string, kind: 'request' | 'response') =>
  `${action}${kind === 'request' ? 'Request' : 'Response'}`;
