/**
 * node-ocpp — typed, schema-validated OCPP components.
 *
 *   import { ocpp16j, ocpp16s, ocpp201 } from 'node-ocpp';   // `ocpp16` is an alias of `ocpp16j`
 *
 * Each namespace is also available as a subpath (`node-ocpp/ocpp16j`, …) so unused
 * transports (e.g. the SOAP stack) are never loaded.
 */
export * as ocpp16j from './ocpp16j/index.js';
/** Alias of `ocpp16j`. */
export * as ocpp16 from './ocpp16j/index.js';
export * as ocpp16s from './ocpp16s/index.js';
export * as ocpp201 from './ocpp201/index.js';

export {
  OcppError,
  ValidationError,
  TimeoutError,
  ConnectionError,
  type ErrorKind,
  type ValidationIssue,
} from './common/errors.js';
export { OcppServer, type ServerOptions, type ServerEvents } from './common/server.js';
export { OcppClient, type ClientOptions, type ClientEvents } from './common/client.js';
export { OcppSession } from './common/session.js';
export { ConnectionRequest, type ConnectionDecision } from './common/connection-request.js';
export { Call, CallResult, CallError, MessageTypeId, type RpcMessage } from './common/rpc.js';
export type { Logger } from './common/logger.js';
export type { ProtocolSpec } from './common/protocol.js';
export type { ValidationMode, ValidationConfig, ValidationOption } from './common/validation.js';
export type {
  ActionDefinition,
  ActionMap,
  ActionName,
  ActionOf,
  AnyRequest,
  ResponseOf,
  CallContext,
  CallOptions,
  Handler,
  Middleware,
} from './common/types.js';
export { WsServer, type WsServerOptions } from './ws/server.js';
export { WsClient, type WsClientOptions, type ReconnectOptions } from './ws/client.js';
export { WsSession } from './ws/session.js';
export { SoapServer, type SoapServerOptions } from './soap/server.js';
export { SoapClient, type SoapClientOptions } from './soap/client.js';
export { SoapSession } from './soap/session.js';
