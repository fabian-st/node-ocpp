import { reviveDates, toWire } from './dates.js';
import { ValidationError, type ValidationIssue } from './errors.js';
import { messageName, type ProtocolSpec } from './protocol.js';
import type { ValidationConfig } from './validation.js';

type Kind = 'request' | 'response';

/** Schema check of a wire payload by message name (e.g. `BootNotificationRequest`). */
export type PayloadValidator = (messageName: string, payload: unknown) => ValidationIssue[];

export interface PayloadCodecOptions {
  spec: Pick<ProtocolSpec, 'dateFields'>;
  validation: ValidationConfig;
  /** Schema check of a wire payload; omitted when validation happens elsewhere (SOAP/XSD). */
  validate?: PayloadValidator | undefined;
  /** Receives violations in `warn` mode. */
  onWarning: (error: ValidationError) => void;
}

/**
 * Converts payloads between their typed form (with `Date`s) and their wire form,
 * validating against the official schema on the way.
 */
export class PayloadCodec {
  readonly #options: PayloadCodecOptions;

  constructor(options: PayloadCodecOptions) {
    this.#options = options;
  }

  /** Typed payload → wire payload. Throws `ValidationError` in strict mode. */
  encode(action: string, kind: Kind, payload: unknown): unknown {
    const wire = toWire(payload ?? {});
    this.check(action, kind, 'outbound', wire);
    return wire;
  }

  /** Wire payload → typed payload. Throws `ValidationError` in strict mode. */
  decode(action: string, kind: Kind, wire: unknown): unknown {
    this.check(action, kind, 'inbound', wire);
    return reviveDates(wire, this.#options.spec.dateFields[messageName(action, kind)]);
  }

  /** Applies the configured mode to a (possibly externally produced) list of issues. */
  report(error: ValidationError): void {
    if (this.#options.validation[error.direction] === 'strict') throw error;
    this.#options.onWarning(error);
  }

  private check(action: string, kind: Kind, direction: 'inbound' | 'outbound', wire: unknown) {
    const { validate, validation } = this.#options;
    if (!validate || validation[direction] === 'off') return;
    const issues = validate(messageName(action, kind), wire);
    if (issues.length) this.report(new ValidationError({ action, kind, direction, issues }));
  }
}
