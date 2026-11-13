/**
 * OCPP 2.0.1 (OCPP-J over WebSocket, subprotocol `ocpp2.0.1`).
 *
 * @example
 * const csms = new ocpp201.Server({ authRequired: false });
 * csms.handle('Heartbeat', () => ({ currentTime: new Date() }));
 * await csms.listen(8080);
 */
import { OcppError as BaseOcppError } from '../common/errors.js';
import { WsClient, type WsClientOptions } from '../ws/client.js';
import { WsServer, type WsServerOptions } from '../ws/server.js';
import type { WsSession } from '../ws/session.js';
import { protocol, type ErrorCode } from './protocol.js';
import type { ChargingStationActions, CsmsActions } from './types.generated.js';

export * from './types.generated.js';
export { protocol, type ErrorCode } from './protocol.js';

/** OcppError restricted to the RPC error codes of OCPP 2.0.1. */
export type OcppError = BaseOcppError<ErrorCode>;
export const OcppError = BaseOcppError as new (
  code: ErrorCode,
  description?: string,
  details?: Record<string, unknown>,
) => OcppError;

export type ServerOptions = WsServerOptions<ChargingStationActions, CsmsActions>;
export type ClientOptions = WsClientOptions<CsmsActions, ChargingStationActions>;
/** A charging station connected to an `ocpp201.Server`. */
export type Session = WsSession<CsmsActions>;

/** OCPP 2.0.1 CSMS. */
export class Server extends WsServer<ChargingStationActions, CsmsActions> {
  constructor(options: ServerOptions = {}) {
    super(protocol, options);
  }
}

/** OCPP 2.0.1 charging station. */
export class Client extends WsClient<CsmsActions, ChargingStationActions> {
  constructor(options: ClientOptions) {
    super(protocol, options);
  }
}
