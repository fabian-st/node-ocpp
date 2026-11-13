/**
 * OCPP 1.6 JSON (OCPP-J over WebSocket, subprotocol `ocpp1.6`).
 * Exported as `ocpp16j` and, as an alias, `ocpp16`.
 *
 * @example
 * const cs = new ocpp16j.Server({ authRequired: false });
 * cs.handle('Heartbeat', () => ({ currentTime: new Date() }));
 * await cs.listen(8080);
 */
import { OcppError as BaseOcppError } from '../common/errors.js';
import { WsClient, type WsClientOptions } from '../ws/client.js';
import { WsServer, type WsServerOptions } from '../ws/server.js';
import type { WsSession } from '../ws/session.js';
import { protocol, type ErrorCode } from './protocol.js';
import type { CentralSystemActions, ChargePointActions } from './types.generated.js';

export * from './types.generated.js';
export { protocol, profiles, type ErrorCode } from './protocol.js';

/** OcppError restricted to the RPC error codes of OCPP 1.6. */
export type OcppError = BaseOcppError<ErrorCode>;
export const OcppError = BaseOcppError as new (
  code: ErrorCode,
  description?: string,
  details?: Record<string, unknown>,
) => OcppError;

export type ServerOptions = WsServerOptions<ChargePointActions, CentralSystemActions>;
export type ClientOptions = WsClientOptions<CentralSystemActions, ChargePointActions>;
/** A charge point connected to an `ocpp16j.Server`. */
export type Session = WsSession<CentralSystemActions>;

/** OCPP 1.6J central system. */
export class Server extends WsServer<ChargePointActions, CentralSystemActions> {
  constructor(options: ServerOptions = {}) {
    super(protocol, options);
  }
}

/** OCPP 1.6J charge point. */
export class Client extends WsClient<CentralSystemActions, ChargePointActions> {
  constructor(options: ClientOptions) {
    super(protocol, options);
  }
}
