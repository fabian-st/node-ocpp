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
  /** Hash of the HTTP Basic password the session was authorized with. */
  passwordHash: string | undefined;
  /** Session id and start, when adopting a session known to the cluster. */
  id?: string;
  connectedAt?: Date;
  endpoint?: string | undefined;
  /** Asked when the session went silent: ms to extend it by, or `undefined` to end it. */
  onIdle: (session: SoapSession<any>) => Promise<number | undefined>;
  onClose: (session: SoapSession<any>, reason: string) => void;
}

/**
 * A charge point talking OCPP-S. SOAP is connectionless: the session lives
 * from the first accepted request until `sessionTimeout` passes without one.
 */
export class SoapSession<Out extends ActionMap = ActionMap> extends OcppSession<Out> {
  declare readonly protocol: SoapProtocol;
  /** @internal */ readonly passwordHash: string | undefined;
  readonly #o: SoapSessionInit;
  readonly #queue = new CallQueue();
  #endpoint: string | undefined;
  #caller: SoapCaller | undefined;
  #timer: NodeJS.Timeout | undefined;
  #lastSeen = Date.now();
  #closed = false;

  /** @internal Created by the server. */
  constructor(init: SoapSessionInit) {
    super(init.clientId, init.protocol, {
      ...(init.id && { id: init.id }),
      ...(init.connectedAt && { connectedAt: init.connectedAt }),
    });
    this.#o = init;
    this.passwordHash = init.passwordHash;
    this.#endpoint = init.endpoint;
    this.#schedule(init.timeout);
  }

  get connected(): boolean {
    return !this.#closed;
  }

  /** The charge point's own SOAP endpoint (announced via WS-Addressing `From`). */
  get endpoint(): string | undefined {
    return this.#endpoint;
  }

  /** When the charge point was last heard of. */
  get lastSeen(): Date {
    return new Date(this.#lastSeen);
  }

  /** @internal Records activity (and the latest endpoint) of the charge point. */
  touch(endpoint: string | undefined): void {
    if (endpoint && endpoint !== WSA_ANONYMOUS && endpoint !== this.#endpoint) {
      this.#endpoint = endpoint;
      if (this.#caller) this.#caller.endpoint = endpoint;
    }
    this.#lastSeen = Date.now();
    this.#schedule(this.#o.timeout);
  }

  async close(): Promise<void> {
    await this.#end('Closed', true);
  }

  /** @internal Ends the session silently (it ended elsewhere in the cluster). */
  discard(): void {
    void this.#end('Discarded', false);
  }

  #schedule(ms: number) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#idle(), ms);
    this.#timer.unref();
  }

  async #idle() {
    const extend = await this.#o.onIdle(this).catch(() => undefined);
    if (this.#closed) return;
    if (extend !== undefined && extend > 0) this.#schedule(extend);
    else await this.#end('Session timeout', true);
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

  async #end(reason: string, notify: boolean) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#queue.clear(new ConnectionError(`Session ${this.clientId} ended: ${reason}`));
    if (notify) this.#o.onClose(this, reason);
  }
}
