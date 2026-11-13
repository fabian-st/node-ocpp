import type { ErrorKind } from '../common/errors.js';
import type { ProtocolSpec } from '../common/protocol.js';
import { clientActions, dateFields, serverActions } from './meta.generated.js';

/** RPC error codes of OCPP 2.0.1. */
export type ErrorCode = ErrorKind;

export const protocol: ProtocolSpec = {
  version: '2.0.1',
  subprotocol: 'ocpp2.0.1',
  clientActions,
  serverActions,
  dateFields,
  errorCodes: {
    NotImplemented: 'NotImplemented',
    NotSupported: 'NotSupported',
    InternalError: 'InternalError',
    ProtocolError: 'ProtocolError',
    SecurityError: 'SecurityError',
    FormatViolation: 'FormatViolation',
    PropertyConstraintViolation: 'PropertyConstraintViolation',
    OccurrenceConstraintViolation: 'OccurrenceConstraintViolation',
    TypeConstraintViolation: 'TypeConstraintViolation',
    GenericError: 'GenericError',
    MessageTypeNotSupported: 'MessageTypeNotSupported',
    RpcFrameworkError: 'RpcFrameworkError',
  } satisfies Record<ErrorKind, ErrorCode>,
  schemas: { dir: new URL('../../schemas/json/ocpp201/', import.meta.url), draft: 6 },
};
