import { createHash } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { SessionInfo, SessionRecord } from '../common/cluster/cluster.js';
import { ConnectionError } from '../common/errors.js';
import type { CallOptions } from '../common/types.js';
import type { PayloadCodec, PayloadValidator } from '../common/codec.js';
import { ConnectionRequest } from '../common/connection-request.js';
import { basicCredentials, verifiedCertificate } from '../common/http-auth.js';
import type { InboundDispatcher } from '../common/inbound.js';
import { OcppServer, type ServerOptions } from '../common/server.js';
import { resolveValidation } from '../common/validation.js';
import { protocol } from '../ocpp16j/protocol.js';
import type { CentralSystemActions, ChargePointActions } from '../ocpp16j/types.generated.js';
import { SoapResponder, type ResolvedRequest, type SoapFault } from './responder.js';
import { SoapSession } from './session.js';
import { WsdlRegistry, type OcppService, type SoapProtocol } from './wsdl.js';
import type { Envelope } from './xml.js';

export interface SoapServerOptions extends ServerOptions<ChargePointActions, CentralSystemActions> {
  /** Directory with the OCPP WSDL files (discovered by namespace). Default: the bundled `schemas/wsdl`. */
  wsdlDir?: string | URL;
  /** Accepted versions. Default: every version with a CentralSystemService WSDL present. */
  protocols?: readonly SoapProtocol[];
  /** Maximum request size in bytes. Default: 1 MiB. */
  maxBodySize?: number;
}

type Pipeline = {
  codec: PayloadCodec;
  inbound: InboundDispatcher<SoapSession<CentralSystemActions>>;
};

type Session = SoapSession<CentralSystemActions>;

/**
 * OCPP-S central system (SOAP 1.2 + WS-Addressing). Accepts OCPP 1.2, 1.5 and 1.6
 * charge points — each validated against its own WSDL — and presents them all
 * with OCPP 1.6 payload types.
 *
 * Clustered, sessions live in the shared store: any node may receive a charge point's
 * requests and call it back. Each node keeps a local copy of the sessions it deals with;
 * `client_connected`/`client_disconnected` are emitted by the node that authorized the session.
 */
export class SoapServer extends OcppServer<
  ChargePointActions,
  CentralSystemActions,
  SoapSession<CentralSystemActions>
> {
  declare protected readonly options: SoapServerOptions;
  readonly #registry: Promise<WsdlRegistry>;
  readonly #responder: SoapResponder<SoapSession<CentralSystemActions>>;
  readonly #pipelines = new WeakMap<SoapSession<CentralSystemActions>, Pipeline>();
  readonly #opening = new Map<string, Promise<SoapSession<CentralSystemActions> | SoapFault>>();
  readonly #listeners = new Map<HttpServer, (req: IncomingMessage, res: ServerResponse) => void>();
  /** Sessions authorized by another node and taken over from the cluster store. */
  readonly #adopted = new WeakSet<Session>();
  readonly #records = new WeakMap<Session, SessionRecord>();

  constructor(options: SoapServerOptions = {}) {
    super(protocol, {
      sessionTimeout: 15 * 60_000,
      ...options,
      cluster: options.cluster && { namespace: 'ocpp:soap', ...options.cluster },
    });
    this.#registry = WsdlRegistry.load(options.wsdlDir);
    this.#registry.catch((error: unknown) => this.logger.error('Failed to load WSDLs', error));
    this.#responder = new SoapResponder({
      role: 'CentralSystem',
      registry: this.#registry,
      protocols: options.protocols && new Set(options.protocols),
      spec: protocol,
      validation: resolveValidation(options.validation),
      logger: this.logger,
      maxBodySize: options.maxBodySize ?? 1024 * 1024,
      resolve: (request, envelope, service) => this.#resolve(request, envelope, service),
    });
  }

  get route(): string {
    return (this.options.route ?? '/ocpp').replace(/\/+$/, '');
  }

  /** Resolves once the WSDLs are loaded; rejects if they cannot be. */
  async ready(): Promise<void> {
    await this.#registry;
  }

  override async listen(port?: number, hostname?: string) {
    await this.ready();
    return super.listen(port, hostname);
  }

  attach(server: HttpServer): this {
    const listener = (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
      if (path === this.route) void this.handleRequest(req, res);
      else if (server.listenerCount('request') === 1) res.writeHead(404).end();
    };
    this.#listeners.set(server, listener);
    server.on('request', listener);
    return this;
  }

  detach(server: HttpServer): this {
    const listener = this.#listeners.get(server);
    if (listener) server.off('request', listener);
    this.#listeners.delete(server);
    return this;
  }

  /** Handles one HTTP request; use it to mount the server in Express & co. */
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    return this.#responder.handle(request, response);
  }

  /** XSD validation happens on the XML level instead. */
  protected override schemaValidator(): PayloadValidator | undefined {
    return undefined;
  }

  async #resolve(
    request: IncomingMessage,
    envelope: Envelope,
    service: OcppService,
  ): Promise<ResolvedRequest<Session> | SoapFault> {
    const clientId = envelope.headers.chargeBoxIdentity;
    if (!clientId) {
      return {
        status: 400,
        code: 'Sender',
        subcode: 'ProtocolError',
        reason: 'Missing chargeBoxIdentity header',
      };
    }
    const password =
      this.options.basicAuth === false ? undefined : basicCredentials(request)?.password;
    const passwordHash = hashPassword(clientId, password);

    let session = this.sessions.get(clientId);
    if (
      !session ||
      !session.connected ||
      session.protocol !== service.protocol ||
      session.passwordHash !== passwordHash
    ) {
      // Several requests of a new charge point may arrive at once: authorize only once.
      let opening = this.#opening.get(clientId);
      if (!opening) {
        opening = this.#open(request, clientId, service, password, passwordHash).finally(() =>
          this.#opening.delete(clientId),
        );
        this.#opening.set(clientId, opening);
      }
      const result = await opening;
      if (!(result instanceof SoapSession)) return result;
      session = result;
    }
    session.touch(envelope.headers.from);
    this.#refresh(session);
    return { session, ...this.#pipelines.get(session)! };
  }

  async #open(
    request: IncomingMessage,
    clientId: string,
    service: OcppService,
    password: string | undefined,
    passwordHash: string | undefined,
  ): Promise<Session | SoapFault> {
    // Known to the cluster (authorized by another node) with the same credentials?
    const record = await this.cluster?.lookup(clientId);
    if (
      record &&
      record.protocol === service.protocol &&
      record.data?.['passwordHash'] === passwordHash
    ) {
      return this.#adopt(record);
    }

    const decision = await this.authorize(
      new ConnectionRequest({
        clientId,
        protocol: service.protocol,
        request,
        password,
        certificate: this.options.certificateAuth ? verifiedCertificate(request) : undefined,
      }),
    );
    if (!decision.accepted) {
      this.logger.info(`[${clientId}] rejected: ${decision.status} ${decision.reason}`);
      return {
        status: decision.status,
        code: 'Sender',
        subcode: 'SecurityError',
        reason: decision.reason,
      };
    }

    const session = await this.#create({ clientId, protocol: service.protocol, passwordHash });
    this.logger.info(`[${clientId}] connected via SOAP ${service.protocol}`);
    this.addSession(session);
    return session;
  }

  /** Takes over a session authorized by another node. */
  async #adopt(record: SessionRecord): Promise<Session> {
    const stale = this.sessions.get(record.clientId);
    if (stale?.id === record.sessionId && stale.connected) return stale;
    if (stale) this.#drop(stale);

    const data = record.data ?? {};
    const session = await this.#create({
      clientId: record.clientId,
      protocol: record.protocol as SoapProtocol,
      passwordHash: data['passwordHash'] as string | undefined,
      id: record.sessionId,
      connectedAt: new Date(record.connectedAt),
      endpoint: data['endpoint'] as string | undefined,
    });
    this.#adopted.add(session);
    this.#records.set(session, record);
    this.adoptSession(session);
    return session;
  }

  async #create(init: {
    clientId: string;
    protocol: SoapProtocol;
    passwordHash: string | undefined;
    id?: string;
    connectedAt?: Date;
    endpoint?: string | undefined;
  }): Promise<Session> {
    const registry = await this.#registry;
    let session!: Session;
    const pipeline = this.createPipeline(() => session);
    session = new SoapSession<CentralSystemActions>({
      ...init,
      service: registry.service(init.protocol, 'ChargePoint'),
      spec: this.spec,
      outbound: this.outboundAllowed,
      validation: resolveValidation(this.options.validation),
      logger: this.logger,
      callTimeout: this.options.callTimeout ?? 30_000,
      timeout: this.options.sessionTimeout!,
      codec: pipeline.codec,
      onIdle: (s) => this.#idle(s),
      onClose: (s, reason) => {
        // Adopted copies expire quietly; the authorizing node reports the disconnect.
        if (this.#adopted.has(s) && reason === 'Session timeout') this.forgetSession(s);
        else this.removeSession(s, { reason });
      },
    });
    this.#pipelines.set(session, pipeline);
    return session;
  }

  /** A session went silent locally: keep it while other nodes still see traffic. */
  async #idle(session: Session): Promise<number | undefined> {
    const record = await this.cluster?.lookup(session.clientId);
    if (!record || record.sessionId !== session.id) return undefined;
    const lastSeen = Number(record.data?.['lastSeen'] ?? 0);
    const remaining = lastSeen + this.options.sessionTimeout! - Date.now();
    return remaining > 0 ? remaining : undefined;
  }

  #refresh(session: Session) {
    const record = this.#records.get(session);
    if (!this.cluster || !record) return;
    this.cluster
      .refresh({ ...record, data: this.#data(session) }, this.options.sessionTimeout)
      .catch((error: unknown) => this.logger.error('Cluster refresh failed', error));
  }

  #data(session: Session): Record<string, unknown> {
    return {
      endpoint: session.endpoint,
      passwordHash: session.passwordHash,
      lastSeen: session.lastSeen.getTime(),
    };
  }

  #drop(session: Session) {
    session.discard();
    this.forgetSession(session);
  }

  // --- cluster hooks ------------------------------------------------------------

  protected override clusterRegistration(session: Session) {
    return { bound: false, ttl: this.options.sessionTimeout, data: this.#data(session) };
  }

  protected override onRegistered(session: Session, record: SessionRecord): void {
    this.#records.set(session, record);
    this.#refresh(session);
  }

  /** The charge point was (re-)authorized elsewhere: our copy is outdated. */
  protected override onRemoteConnected(_info: SessionInfo, record: SessionRecord): void {
    const local = this.sessions.get(record.clientId);
    if (local && local.id !== record.sessionId) this.#drop(local);
  }

  protected override onRemoteDisconnected(info: SessionInfo): void {
    const local = this.sessions.get(info.clientId);
    if (local?.id === info.sessionId) this.#drop(local);
  }

  /** Any node can call a SOAP charge point directly: adopt its session from the store. */
  protected override async sendRemote(
    clientId: string,
    action: string,
    payload: unknown,
    options: CallOptions,
  ): Promise<unknown> {
    const record = await this.cluster?.lookup(clientId);
    if (!record) throw new ConnectionError(`Client ${clientId} is not connected`);
    const session = await this.#adopt(record);
    return (session.send as (a: string, p: unknown, o: CallOptions) => Promise<unknown>).call(
      session,
      action,
      payload,
      options,
    );
  }
}

/** Passwords are only kept (and shared via the cluster store) as salted hashes. */
function hashPassword(clientId: string, password: string | undefined): string | undefined {
  return password === undefined
    ? undefined
    : createHash('sha256').update(`${clientId}:${password}`).digest('hex');
}
