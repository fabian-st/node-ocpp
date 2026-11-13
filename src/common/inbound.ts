import type { PayloadCodec } from './codec.js';
import { OcppError, ValidationError } from './errors.js';
import type { Logger } from './logger.js';
import type { ProtocolSpec } from './protocol.js';
import type { Router } from './router.js';

export interface InboundOptions<S> {
  spec: ProtocolSpec;
  codec: PayloadCodec;
  router: Router<S>;
  logger: Logger;
  /** Actions the peer may initiate according to the protocol. */
  known: ReadonlySet<string>;
  /** Subset of `known` the application accepts (`actionsAllowed`). */
  allowed: ReadonlySet<string>;
}

export type InboundResult = { ok: true; payload: unknown } | { ok: false; error: OcppError };

/**
 * Transport-independent processing of one inbound call:
 * decode + validate → middleware/handler → encode + validate,
 * with every failure mapped onto the protocol's RPC error codes.
 */
export class InboundDispatcher<S> {
  readonly #o: InboundOptions<S>;

  constructor(options: InboundOptions<S>) {
    this.#o = options;
  }

  async process(
    session: S,
    messageId: string,
    action: string,
    wire: unknown,
  ): Promise<InboundResult> {
    const { codec, router, known, allowed, spec, logger } = this.#o;
    const code = (kind: keyof ProtocolSpec['errorCodes']) => spec.errorCodes[kind];
    try {
      if (!known.has(action))
        throw new OcppError(code('NotImplemented'), `Unknown action ${action}`);
      if (!allowed.has(action))
        throw new OcppError(code('NotSupported'), `${action} is not supported`);

      const request = codec.decode(action, 'request', wire);
      const response = await router.dispatch({ action, messageId, session, request });
      return { ok: true, payload: codec.encode(action, 'response', response) };
    } catch (error) {
      if (error instanceof OcppError) return { ok: false, error };
      if (error instanceof ValidationError) {
        if (error.direction === 'inbound') {
          return {
            ok: false,
            error: new OcppError(code(error.errorKind), error.message, { issues: error.issues }),
          };
        }
        logger.error(`Handler for ${action} produced an invalid response`, error);
        return {
          ok: false,
          error: new OcppError(code('InternalError'), 'Invalid response payload'),
        };
      }
      logger.error(`Handler for ${action} failed`, error);
      return { ok: false, error: new OcppError(code('InternalError'), 'Internal error') };
    }
  }
}
