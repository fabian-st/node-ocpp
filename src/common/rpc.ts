/**
 * OCPP-J RPC framing (shared by 1.6J and 2.0.1):
 *   CALL       [2, messageId, action, payload]
 *   CALLRESULT [3, messageId, payload]
 *   CALLERROR  [4, messageId, errorCode, errorDescription, errorDetails]
 */
import type { ErrorKind } from './errors.js';

export const MessageTypeId = { Call: 2, CallResult: 3, CallError: 4 } as const;

export class Call<Payload = unknown> {
  readonly type = MessageTypeId.Call;
  readonly id: string;
  readonly action: string;
  readonly payload: Payload;

  constructor(id: string, action: string, payload: Payload) {
    this.id = id;
    this.action = action;
    this.payload = payload;
  }

  toJSON() {
    return [this.type, this.id, this.action, this.payload] as const;
  }
}

export class CallResult<Payload = unknown> {
  readonly type = MessageTypeId.CallResult;
  readonly id: string;
  readonly payload: Payload;

  constructor(id: string, payload: Payload) {
    this.id = id;
    this.payload = payload;
  }

  toJSON() {
    return [this.type, this.id, this.payload] as const;
  }
}

export class CallError {
  readonly type = MessageTypeId.CallError;
  readonly id: string;
  readonly code: string;
  readonly description: string;
  readonly details: Record<string, unknown>;

  constructor(id: string, code: string, description = '', details: Record<string, unknown> = {}) {
    this.id = id;
    this.code = code;
    this.description = description;
    this.details = details;
  }

  toJSON() {
    return [this.type, this.id, this.code, this.description, this.details] as const;
  }
}

export type RpcMessage = Call | CallResult | CallError;

/** A frame that is not a well-formed OCPP-J message. */
export class RpcParseError extends Error {
  override name = 'RpcParseError';
  /** Message id, when it could be read. */
  readonly messageId: string | undefined;
  readonly kind: ErrorKind;

  constructor(message: string, kind: ErrorKind, messageId?: string) {
    super(message);
    this.kind = kind;
    this.messageId = messageId;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseMessage(text: string): RpcMessage {
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    throw new RpcParseError('Message is not valid JSON', 'RpcFrameworkError');
  }
  if (!Array.isArray(frame))
    throw new RpcParseError('Message is not an array', 'RpcFrameworkError');

  const [type, id] = frame;
  if (typeof id !== 'string') throw new RpcParseError('Message id is missing', 'RpcFrameworkError');

  switch (type) {
    case MessageTypeId.Call: {
      const [, , action, payload] = frame;
      if (frame.length !== 4 || typeof action !== 'string' || !isObject(payload)) {
        throw new RpcParseError('Malformed CALL', 'FormatViolation', id);
      }
      return new Call(id, action, payload);
    }
    case MessageTypeId.CallResult: {
      const [, , payload] = frame;
      if (frame.length !== 3 || !isObject(payload)) {
        throw new RpcParseError('Malformed CALLRESULT', 'FormatViolation', id);
      }
      return new CallResult(id, payload);
    }
    case MessageTypeId.CallError: {
      const [, , code, description, details] = frame;
      if (typeof code !== 'string' || typeof description !== 'string' || !isObject(details ?? {})) {
        throw new RpcParseError('Malformed CALLERROR', 'FormatViolation', id);
      }
      return new CallError(id, code, description, (details ?? {}) as Record<string, unknown>);
    }
    default:
      throw new RpcParseError(
        `Unknown message type ${String(type)}`,
        'MessageTypeNotSupported',
        id,
      );
  }
}
