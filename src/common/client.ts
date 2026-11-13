import { EventEmitter } from 'node:events';
import { PayloadCodec, type PayloadValidator } from './codec.js';
import type { ValidationError } from './errors.js';
import { InboundDispatcher } from './inbound.js';
import { silentLogger, type Logger } from './logger.js';
import type { ProtocolSpec } from './protocol.js';
import { Router } from './router.js';
import type {
  ActionMap,
  ActionName,
  ActionOf,
  AnyRequest,
  CallOptions,
  Handler,
  Middleware,
  ResponseOf,
} from './types.js';
import { JsonSchemaValidator, resolveValidation, type ValidationOption } from './validation.js';

export interface ClientOptions<
  In extends ActionMap = ActionMap,
  Out extends ActionMap = ActionMap,
> {
  /** Charge point identity. */
  clientId: string;
  /** Actions that may be sent/received. Default: every action of the protocol. */
  actionsAllowed?: readonly (ActionName<In> | ActionName<Out>)[];
  /** Schema validation of in- and outbound payloads. Default: `true` (strict). */
  validation?: ValidationOption;
  /** Milliseconds to wait for a response once a call was transmitted. Default: `30000`. */
  callTimeout?: number;
  logger?: Logger;
}

export interface ClientEvents {
  connected: [];
  disconnected: [info: { code?: number; reason: string }];
  reconnecting: [info: { attempt: number; delay: number }];
  /** A payload violated its schema while validation is in `warn` mode. */
  validation_error: [error: ValidationError];
}

/**
 * Base class of all OCPP charge point (client) implementations.
 * `In` are the actions the central system initiates, `Out` those the charge point initiates.
 */
export abstract class OcppClient<
  In extends ActionMap,
  Out extends ActionMap,
> extends EventEmitter<ClientEvents> {
  readonly clientId: string;
  protected readonly spec: ProtocolSpec;
  protected readonly options: ClientOptions<In, Out>;
  protected readonly logger: Logger;
  protected readonly router = new Router<OcppClient<In, Out>>();
  protected readonly inboundAllowed: ReadonlySet<string>;
  protected readonly outboundAllowed: ReadonlySet<string>;

  protected constructor(spec: ProtocolSpec, options: ClientOptions<In, Out>) {
    super();
    this.spec = spec;
    this.options = options;
    this.clientId = options.clientId;
    this.logger = options.logger ?? silentLogger;
    const allowed = new Set<string>(
      options.actionsAllowed ?? [...spec.clientActions, ...spec.serverActions],
    );
    this.inboundAllowed = new Set(spec.serverActions.filter((a) => allowed.has(a)));
    this.outboundAllowed = new Set(spec.clientActions.filter((a) => allowed.has(a)));
  }

  /** Protocol spoken by this client, e.g. `ocpp1.6`. */
  get protocol(): string {
    return this.spec.subprotocol;
  }

  abstract get connected(): boolean;

  /** Registers the handler for calls of `action` from the central system. */
  handle<A extends ActionName<In>>(
    action: A,
    handler: Handler<In[A]['request'], In[A]['response'], this>,
  ): this;
  handle<P extends AnyRequest<In>>(
    action: ActionOf<In, P>,
    handler: Handler<P, ResponseOf<In, P>, this>,
  ): this;
  handle(action: string, handler: Handler<any, any, any>): this {
    this.router.set(action, handler);
    return this;
  }

  /** Adds middleware wrapping every inbound call. */
  use(middleware: Middleware<this>): this {
    this.router.use(middleware as Middleware<OcppClient<In, Out>>);
    return this;
  }

  /** Sends a call to the central system and resolves with its (validated, typed) response. */
  send<A extends ActionName<Out>>(
    action: A,
    payload: Out[A]['request'],
    options?: CallOptions,
  ): Promise<Out[A]['response']>;
  send<P extends AnyRequest<Out>>(
    action: ActionOf<Out, P>,
    payload: P,
    options?: CallOptions,
  ): Promise<ResponseOf<Out, P>>;
  send(action: string, payload: unknown, options?: CallOptions): Promise<unknown> {
    return this.call(action, payload, options);
  }

  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;

  protected abstract call(
    action: string,
    payload: unknown,
    options?: CallOptions,
  ): Promise<unknown>;

  /** Payload validator used by the codec; transports validating elsewhere (SOAP/XSD) return `undefined`. */
  protected schemaValidator(): PayloadValidator | undefined {
    const validator = JsonSchemaValidator.for(this.spec);
    return (name, payload) => validator.validate(name, payload);
  }

  protected createPipeline(): {
    codec: PayloadCodec;
    inbound: InboundDispatcher<OcppClient<In, Out>>;
  } {
    const codec = new PayloadCodec({
      spec: this.spec,
      validation: resolveValidation(this.options.validation),
      validate: this.schemaValidator(),
      onWarning: (error) => {
        this.logger.warn(error.message);
        this.emit('validation_error', error);
      },
    });
    const inbound = new InboundDispatcher<OcppClient<In, Out>>({
      spec: this.spec,
      codec,
      router: this.router,
      logger: this.logger,
      known: new Set(this.spec.serverActions),
      allowed: this.inboundAllowed,
    });
    return { codec, inbound };
  }
}
