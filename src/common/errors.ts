/**
 * Version-independent error kinds. Every protocol version maps them onto its own
 * RPC error codes (e.g. `FormatViolation` is `FormationViolation` in OCPP 1.6).
 */
export type ErrorKind =
  | 'NotImplemented'
  | 'NotSupported'
  | 'InternalError'
  | 'ProtocolError'
  | 'SecurityError'
  | 'FormatViolation'
  | 'PropertyConstraintViolation'
  | 'OccurrenceConstraintViolation'
  | 'TypeConstraintViolation'
  | 'GenericError'
  | 'MessageTypeNotSupported'
  | 'RpcFrameworkError';

/**
 * An OCPP RPC error. Thrown by handlers to answer with a CALLERROR,
 * and used to reject `send()` when the peer answers with one.
 */
export class OcppError<Code extends string = string> extends Error {
  override name = 'OcppError';
  readonly code: Code;
  readonly details: Record<string, unknown>;

  constructor(code: Code, description = '', details: Record<string, unknown> = {}) {
    super(description || code);
    this.code = code;
    this.details = details;
  }

  get description(): string {
    return this.message === this.code ? '' : this.message;
  }
}

export interface ValidationIssue {
  /** JSON pointer (JSON) or element path (XML) of the offending value. */
  readonly path: string;
  readonly message: string;
  /** Failed schema keyword, e.g. `required`, `enum`, `type`; `xsd` for XML validation. */
  readonly keyword: string;
}

/** A payload did not conform to the official schema. */
export class ValidationError extends Error {
  override name = 'ValidationError';
  readonly action: string;
  readonly kind: 'request' | 'response';
  readonly direction: 'inbound' | 'outbound';
  readonly issues: readonly ValidationIssue[];
  /** The RPC error kind this violation maps to. */
  readonly errorKind: ErrorKind;

  constructor(init: {
    action: string;
    kind: 'request' | 'response';
    direction: 'inbound' | 'outbound';
    issues: readonly ValidationIssue[];
  }) {
    const first = init.issues[0];
    super(
      `Invalid ${init.direction} ${init.action}${init.kind === 'request' ? 'Request' : 'Response'}` +
        (first ? `: ${first.path || '/'} ${first.message}` : ''),
    );
    this.action = init.action;
    this.kind = init.kind;
    this.direction = init.direction;
    this.issues = init.issues;
    this.errorKind = errorKindOf(first?.keyword);
  }
}

function errorKindOf(keyword = ''): ErrorKind {
  switch (keyword) {
    case 'required':
      return 'OccurrenceConstraintViolation';
    case 'type':
      return 'TypeConstraintViolation';
    case 'additionalProperties':
    case 'xsd':
      return 'FormatViolation';
    default:
      return 'PropertyConstraintViolation';
  }
}

/** No response arrived in time. */
export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/** The connection is gone, was never established, or the session is unknown. */
export class ConnectionError extends Error {
  override name = 'ConnectionError';
}
