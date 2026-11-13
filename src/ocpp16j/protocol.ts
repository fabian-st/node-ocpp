import type { ErrorKind } from '../common/errors.js';
import type { ProtocolSpec } from '../common/protocol.js';
import { clientActions, dateFields, serverActions } from './meta.generated.js';
import type { CentralSystemActions, ChargePointActions } from './types.generated.js';

/** RPC error codes of OCPP-J 1.6 (spelling as in the specification). */
export type ErrorCode =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormationViolation'
  | 'PropertyConstraintViolation'
  | 'OccurenceConstraintViolation'
  | 'TypeConstraintViolation'
  | 'GenericError';

export const protocol: ProtocolSpec = {
  version: '1.6',
  subprotocol: 'ocpp1.6',
  clientActions,
  serverActions,
  dateFields,
  errorCodes: {
    NotImplemented: 'NotImplemented',
    NotSupported: 'NotSupported',
    InternalError: 'InternalError',
    ProtocolError: 'ProtocolError',
    SecurityError: 'SecurityError',
    FormatViolation: 'FormationViolation',
    PropertyConstraintViolation: 'PropertyConstraintViolation',
    OccurrenceConstraintViolation: 'OccurenceConstraintViolation',
    TypeConstraintViolation: 'TypeConstraintViolation',
    GenericError: 'GenericError',
    MessageTypeNotSupported: 'NotSupported',
    RpcFrameworkError: 'FormationViolation',
  } satisfies Record<ErrorKind, ErrorCode>,
  schemas: { dir: new URL('../../schemas/json/ocpp16/', import.meta.url), draft: 4 },
};

type Action = keyof ChargePointActions | keyof CentralSystemActions;

/** Feature profiles of OCPP 1.6, e.g. `actionsAllowed: [...profiles.Core, ...profiles.SmartCharging]`. */
export const profiles = {
  Core: [
    'Authorize',
    'BootNotification',
    'ChangeAvailability',
    'ChangeConfiguration',
    'ClearCache',
    'DataTransfer',
    'GetConfiguration',
    'Heartbeat',
    'MeterValues',
    'RemoteStartTransaction',
    'RemoteStopTransaction',
    'Reset',
    'StartTransaction',
    'StatusNotification',
    'StopTransaction',
    'UnlockConnector',
  ],
  FirmwareManagement: [
    'GetDiagnostics',
    'DiagnosticsStatusNotification',
    'FirmwareStatusNotification',
    'UpdateFirmware',
  ],
  LocalAuthListManagement: ['GetLocalListVersion', 'SendLocalList'],
  Reservation: ['CancelReservation', 'ReserveNow'],
  SmartCharging: ['ClearChargingProfile', 'GetCompositeSchedule', 'SetChargingProfile'],
  RemoteTrigger: ['TriggerMessage'],
} as const satisfies Record<string, readonly Action[]>;
