/**
 * Translates between OCPP 1.2 / 1.5 SOAP payloads and their OCPP 1.6 equivalents,
 * so handlers only ever deal with 1.6 shapes. Covers every structural difference
 * between the official WSDLs; enum values that have no 1.6 counterpart
 * (e.g. status `Occupied`) are passed through unchanged.
 */
import type { SoapProtocol } from './wsdl.js';

type Payload = Record<string, unknown>;
type Translate = (payload: Payload, protocol: SoapProtocol) => Payload;

const LEGACY_UNITS: Record<string, string> = { Amp: 'A', Volt: 'V' };

const asArray = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/** 1.2: `{ timestamp, value: int }`; 1.5: `{ timestamp, value: [ '12' | { attributes, $value } ] }`. */
function meterValueToCurrent(meterValue: unknown) {
  const { timestamp, value } = meterValue as { timestamp: unknown; value: unknown };
  const sampledValue = asArray(value).map((v) => {
    if (v === null || typeof v !== 'object') return { value: String(v) };
    const { attributes = {}, $value } = v as {
      attributes?: Record<string, string>;
      $value?: unknown;
    };
    const { unit, ...rest } = attributes;
    return {
      value: String($value ?? ''),
      ...rest,
      ...(unit === undefined ? {} : { unit: LEGACY_UNITS[unit] ?? unit }),
    };
  });
  return { timestamp, sampledValue };
}

const rename =
  (from: string, to: string): Translate =>
  ({ [from]: value, ...rest }) =>
    value === undefined ? rest : { ...rest, [to]: value };

/** Legacy → 1.6, applied to payloads received from legacy charge points. */
const toCurrentTable: Record<string, Translate> = {
  MeterValuesRequest: ({ values, ...rest }) => ({
    ...rest,
    ...(values === undefined ? {} : { meterValue: asArray(values).map(meterValueToCurrent) }),
  }),
  StopTransactionRequest: ({ transactionData, ...rest }, protocol) =>
    transactionData === undefined || protocol !== 'ocpp1.5'
      ? { ...rest, ...(transactionData === undefined ? {} : { transactionData }) }
      : {
          ...rest,
          transactionData: asArray(transactionData).flatMap((td) =>
            asArray((td as { values?: unknown }).values).map(meterValueToCurrent),
          ),
        },
  UnlockConnectorResponse: ({ status, ...rest }) => ({
    ...rest,
    status: status === 'Accepted' ? 'Unlocked' : status === 'Rejected' ? 'UnlockFailed' : status,
  }),
  BootNotificationResponse: rename('heartbeatInterval', 'interval'),
  SendLocalListRequest: rename('localAuthorisationList', 'localAuthorizationList'),
};

/** 1.6 → legacy, applied to payloads sent to legacy charge points. */
const toLegacyTable: Record<string, Translate> = {
  BootNotificationResponse: rename('interval', 'heartbeatInterval'),
  SendLocalListRequest: (payload, protocol) =>
    protocol === 'ocpp1.5'
      ? rename('localAuthorizationList', 'localAuthorisationList')(payload, protocol)
      : payload,
};

export function toCurrent(protocol: SoapProtocol, messageName: string, payload: Payload): Payload {
  if (protocol === 'ocpp1.6') return payload;
  return toCurrentTable[messageName]?.(payload, protocol) ?? payload;
}

export function toLegacy(protocol: SoapProtocol, messageName: string, payload: Payload): Payload {
  if (protocol === 'ocpp1.6') return payload;
  return toLegacyTable[messageName]?.(payload, protocol) ?? payload;
}
