import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import {
  createServer as createHttpsServer,
  type ServerOptions as TlsServerOptions,
} from 'node:https';
import type { AddressInfo } from 'node:net';
import { PayloadCodec, type PayloadValidator } from './codec.js';
import { ConnectionRequest, type ConnectionDecision } from './connection-request.js';
import { ConnectionError, type ValidationError } from './errors.js';
import { InboundDispatcher } from './inbound.js';
import { silentLogger, type Logger } from './logger.js';
import type { ProtocolSpec } from './protocol.js';
import { Router } from './router.js';
import type { OcppSession } from './session.js';
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

export interface ServerOptions<
  In extends ActionMap = ActionMap,
  Out extends ActionMap = ActionMap,
> {
  /** TCP port for `listen()`. Default: `80` in production, `8080` otherwise. */
  port?: number;
  /** Host name for `listen()`. Default: `localhost`. */
  hostname?: string;
  /** Route clients connect to, followed by their identity. Default: `/ocpp`. */
  route?: string;
  /** Actions that may be sent/received. Default: every action of the protocol. */
  actionsAllowed?: readonly (ActionName<In> | ActionName<Out>)[];
  /** Maximum number of simultaneously connected clients. Default: `511`. */
  maxConnections?: number;
  /** Milliseconds without any traffic after which a session is terminated. Default: `30000`. */
  sessionTimeout?: number;
  /** Deny connections unless a `connection_request` listener accepts them. Default: `true`. */
  authRequired?: boolean;
  /** Milliseconds to wait for a `connection_request` decision. Default: `10000`. */
  authTimeout?: number;
  /** Read HTTP Basic credentials (only secure over TLS). Default: `true`. */
  basicAuth?: boolean;
  /** Request TLS client certificates (Security Profile 3). Requires `tls`. Default: `false`. */
  certificateAuth?: boolean;
  /** Serve via HTTPS/WSS using these options (certificate, key, CA, …). */
  tls?: TlsServerOptions;
  /** Schema validation of in- and outbound payloads. Default: `true` (strict). */
  validation?: ValidationOption;
  /** Milliseconds to wait for a response to an outbound call. Default: `30000`. */
  callTimeout?: number;
  logger?: Logger;
}

export interface ServerEvents<S> {
  /** A charge point wants to connect; call `request.accept()` or `request.reject()`. */
  connection_request: [request: ConnectionRequest];
  client_connected: [session: S];
  client_disconnected: [session: S, info: { code?: number; reason: string }];
  /** A payload violated its schema while validation is in `warn` mode. */
  validation_error: [error: ValidationError, session: S];
}

/** Base class of all OCPP central system (server) implementations. */
export abstract class OcppServer<
  In extends ActionMap,
  Out extends ActionMap,
  S extends OcppSession<Out>,
> extends EventEmitter<ServerEvents<S>> {
  protected readonly spec: ProtocolSpec;
  protected readonly options: ServerOptions<In, Out>;
  protected readonly logger: Logger;
  protected readonly router = new Router<S>();
  /** Actions charge points may send (`known` ∩ `actionsAllowed`). */
  protected readonly inboundAllowed: ReadonlySet<string>;
  /** Actions this server may send. */
  protected readonly outboundAllowed: ReadonlySet<string>;
  readonly #sessions = new Map<string, S>();
  #httpServer: HttpServer | undefined;

  protected constructor(spec: ProtocolSpec, options: ServerOptions<In, Out>) {
    super();
    this.spec = spec;
    this.options = options;
    this.logger = options.logger ?? silentLogger;
    const allowed = new Set<string>(
      options.actionsAllowed ?? [...spec.clientActions, ...spec.serverActions],
    );
    this.inboundAllowed = new Set(spec.clientActions.filter((a) => allowed.has(a)));
    this.outboundAllowed = new Set(spec.serverActions.filter((a) => allowed.has(a)));
  }

  /** Currently connected sessions by client id. */
  get sessions(): ReadonlyMap<string, S> {
    return this.#sessions;
  }

  /** Registers the handler for calls of `action` from charge points (replaces any previous one). */
  handle<A extends ActionName<In>>(
    action: A,
    handler: Handler<In[A]['request'], In[A]['response'], S>,
  ): this;
  handle<P extends AnyRequest<In>>(
    action: ActionOf<In, P>,
    handler: Handler<P, ResponseOf<In, P>, S>,
  ): this;
  handle(action: string, handler: Handler<any, any, S>): this {
    this.router.set(action, handler);
    return this;
  }

  /** Adds middleware wrapping every inbound call. */
  use(middleware: Middleware<S>): this {
    this.router.use(middleware);
    return this;
  }

  /** Sends a call to a connected charge point. */
  send<A extends ActionName<Out>>(
    clientId: string,
    action: A,
    payload: Out[A]['request'],
    options?: CallOptions,
  ): Promise<Out[A]['response']>;
  send<P extends AnyRequest<Out>>(
    clientId: string,
    action: ActionOf<Out, P>,
    payload: P,
    options?: CallOptions,
  ): Promise<ResponseOf<Out, P>>;
  async send(clientId: string, action: string, payload: unknown, options?: CallOptions) {
    const session = this.#sessions.get(clientId);
    if (!session) throw new ConnectionError(`Client ${clientId} is not connected`);
    return (session.send as (a: string, p: unknown, o?: CallOptions) => Promise<unknown>)(
      action,
      payload,
      options,
    );
  }

  /**
   * Starts a dedicated HTTP(S) server and attaches to it.
   * To share a server between several OCPP servers, create it yourself and use `attach()`.
   */
  async listen(
    port = this.options.port ?? (process.env.NODE_ENV === 'production' ? 80 : 8080),
    hostname = this.options.hostname ?? 'localhost',
  ): Promise<AddressInfo> {
    if (this.#httpServer) throw new Error('Server is already listening');
    const { tls, certificateAuth } = this.options;
    const server = tls
      ? createHttpsServer({
          ...tls,
          // Verification result is exposed to `connection_request`; basic-auth clients may share the port.
          requestCert: certificateAuth || tls.requestCert,
          rejectUnauthorized: tls.rejectUnauthorized ?? false,
        })
      : createHttpServer();
    this.#httpServer = server;
    this.attach(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, hostname, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    this.logger.info(`OCPP ${this.spec.version} server listening on ${hostname}:${address.port}`);
    return address;
  }

  /** Serves OCPP on an existing HTTP(S) server. */
  abstract attach(server: HttpServer): this;

  /** Stops serving on `server`. */
  abstract detach(server: HttpServer): this;

  /** Closes all sessions and, if started via `listen()`, the HTTP server. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#sessions.values()].map((s) => s.close()));
    const server = this.#httpServer;
    if (server) {
      this.#httpServer = undefined;
      this.detach(server);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // --- for subclasses ---------------------------------------------------------

  /** Lets `connection_request` listeners decide; applies `authRequired` when nobody does. */
  protected async authorize(request: ConnectionRequest): Promise<ConnectionDecision> {
    const authRequired = this.options.authRequired ?? true;
    const fallback: ConnectionDecision = authRequired
      ? { accepted: false, status: 401, reason: 'Unauthorized' }
      : { accepted: true };
    if (this.listenerCount('connection_request') === 0) return fallback;
    this.emit('connection_request', request);
    return request.wait(this.options.authTimeout ?? 10_000, fallback);
  }

  /** Payload validator used by the codec; transports validating elsewhere (SOAP/XSD) return `undefined`. */
  protected schemaValidator(): PayloadValidator | undefined {
    const validator = JsonSchemaValidator.for(this.spec);
    return (name, payload) => validator.validate(name, payload);
  }

  /** Building blocks every session needs: codec (with warnings bound to the session) and dispatcher. */
  protected createPipeline(session: () => S) {
    const codec = new PayloadCodec({
      spec: this.spec,
      validation: resolveValidation(this.options.validation),
      validate: this.schemaValidator(),
      onWarning: (error) => {
        this.logger.warn(error.message);
        this.emit('validation_error', error, session());
      },
    });
    const inbound = new InboundDispatcher<S>({
      spec: this.spec,
      codec,
      router: this.router,
      logger: this.logger,
      known: new Set(this.spec.clientActions),
      allowed: this.inboundAllowed,
    });
    return { codec, inbound };
  }

  /** Registers a session, replacing (and closing) an older one with the same id. */
  protected addSession(session: S): void {
    const previous = this.#sessions.get(session.clientId);
    this.#sessions.set(session.clientId, session);
    if (previous && previous !== session) {
      this.logger.info(`[${session.clientId}] replaced by a new connection`);
      void previous.close();
    }
    this.emit('client_connected', session);
  }

  protected removeSession(session: S, info: { code?: number; reason: string }): void {
    if (this.#sessions.get(session.clientId) === session) this.#sessions.delete(session.clientId);
    this.emit('client_disconnected', session, info);
  }
}
