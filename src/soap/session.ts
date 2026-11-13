import { CallQueue } from '../common/call-queue.js';
import type { PayloadCodec } from '../common/codec.js';
import { ConnectionError, OcppError } from '../common/errors.js';
import type { Logger } from '../common/logger.js';
import type { ProtocolSpec } from '../common/protocol.js';
import { OcppSession } from '../common/session.js';
import type { ActionMap, CallOptions } from '../common/types.js';
import type { ValidationConfig } from '../common/validation.js';
import { SoapCaller } from './caller.js';
import type { OcppService, SoapProtocol } from './wsdl.js';
import { WSA_ANONYMOUS } from './xml.js';

export interface SoapSessionInit {
  clientId: string;
  protocol: SoapProtocol;
  /** The charge point's ChargePointService, if a WSDL for its version is available. */
  service: OcppService | undefined;
  spec: ProtocolSpec;
  codec: PayloadCodec;
  outbound: ReadonlySet<string>;
  validation: ValidationConfig;
  logger: Logger;
  callTimeout: number;
  /** Milliseconds of silence after which the session expires. */
  timeout: number;
  /** HTTP Basic password the session was authorized with. */
  password: string | undefined;
  onClose: (session: SoapSession<any>, reason: string) => void;
}

/**
 * A charge point talking OCPP-S. SOAP is connectionless: the session lives
 * from the first accepted request until `sessionTimeout` passes without one.
 */
export class SoapSession<Out extends ActionMap = ActionMap> extends OcppSession<Out> {
  declare readonly protocol: SoapProtocol;
  /** @internal */ readonly password: string | undefined;
  readonly #o: SoapSessionInit;
  readonly #queue = new CallQueue();
  #endpoint: string | undefined;
  #caller: SoapCaller | undefined;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  /** @internal Created by the server. */
  constructor(init: SoapSessionInit) {
    super(init.clientId, init.protocol);
    this.#o = init;
    this.password = init.password;
  }

  get connected(): boolean {
    return !this.#closed;
  }

  /** The charge point's own SOAP endpoint (announced via WS-Addressing `From`). */
  get endpoint(): string | undefined {
    return this.#endpoint;
  }

  /** @internal Records activity (and the latest endpoint) of the charge point. */
  touch(endpoint: string | undefined): void {
    if (endpoint && endpoint !== WSA_ANONYMOUS && endpoint !== this.#endpoint) {
      this.#endpoint = endpoint;
      if (this.#caller) this.#caller.endpoint = endpoint;
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#end('Session timeout'), this.#o.timeout);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    await this.#end('Closed');
  }

  protected async call(
    action: string,
    payload: unknown,
    options: CallOptions = {},
  ): Promise<unknown> {
    const { codec, outbound, spec, service } = this.#o;
    if (this.#closed) throw new ConnectionError(`Session ${this.clientId} is closed`);
    if (!outbound.has(action))
      throw new OcppError(spec.errorCodes.NotSupported, `Sending ${action} is not allowed`);
    if (!service) throw new Error(`No ChargePointService WSDL for ${this.protocol} available`);
    if (!this.#endpoint) {
      throw new ConnectionError(`${this.clientId} did not announce its endpoint (wsa:From)`);
    }
    const wire = codec.encode(action, 'request', payload);
    const response = await this.#queue.push(
      () => this.#callerFor(service).call(action, wire, options),
      options.signal,
    );
    return codec.decode(action, 'response', response);
  }

  #callerFor(service: OcppService): SoapCaller {
    this.#caller ??= new SoapCaller({
      service,
      endpoint: this.#endpoint!,
      identity: this.clientId,
      validation: this.#o.validation,
      report: (error) => this.#o.codec.report(error),
      logger: this.#o.logger,
      callTimeout: this.#o.callTimeout,
    });
    return this.#caller;
  }

  async #end(reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#queue.clear(new ConnectionError(`Session ${this.clientId} ended: ${reason}`));
    this.#o.onClose(this, reason);
  }
}
