/**
 * OCPP 1.6 SOAP (OCPP-S: SOAP 1.2 + WS-Addressing).
 *
 * The server additionally accepts OCPP 1.2 and 1.5 charge points when their WSDLs are present;
 * handlers always see OCPP 1.6 payload types (shared with `ocpp16`).
 *
 * @example
 * const cs = new ocpp16s.Server({ authRequired: false });
 * cs.handle('Heartbeat', () => ({ currentTime: new Date() }));
 * await cs.listen(8080);
 */
import type { CentralSystemActions } from '../ocpp16j/types.generated.js';
import { SoapClient, type SoapClientOptions } from '../soap/client.js';
import { SoapServer, type SoapServerOptions } from '../soap/server.js';
import type { SoapSession } from '../soap/session.js';

export * from '../ocpp16j/types.generated.js';
export { protocol, profiles, OcppError, type ErrorCode } from '../ocpp16j/index.js';
export { WsdlRegistry, type SoapProtocol, type OcppService } from '../soap/wsdl.js';

export type ServerOptions = SoapServerOptions;
export type ClientOptions = SoapClientOptions;
/** A charge point connected to an `ocpp16s.Server`. */
export type Session = SoapSession<CentralSystemActions>;

/** OCPP 1.6S central system; also accepts 1.2 and 1.5 charge points. */
export class Server extends SoapServer {}

/** OCPP 1.6S charge point. */
export class Client extends SoapClient {}
