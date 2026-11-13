import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
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

/**
 * OCPP-S central system (SOAP 1.2 + WS-Addressing). Accepts OCPP 1.2, 1.5 and 1.6
 * charge points — each validated against its own WSDL — and presents them all
 * with OCPP 1.6 payload types.
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

  constructor(options: SoapServerOptions = {}) {
    super(protocol, { sessionTimeout: 15 * 60_000, ...options });
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
  ): Promise<ResolvedRequest<SoapSession<CentralSystemActions>> | SoapFault> {
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

    let session = this.sessions.get(clientId);
    if (!session || session.protocol !== service.protocol || session.password !== password) {
      // Several requests of a new charge point may arrive at once: authorize only once.
      let opening = this.#opening.get(clientId);
      if (!opening) {
        opening = this.#open(request, clientId, service, password).finally(() =>
          this.#opening.delete(clientId),
        );
        this.#opening.set(clientId, opening);
      }
      const result = await opening;
      if (!(result instanceof SoapSession)) return result;
      session = result;
    }
    session.touch(envelope.headers.from);
    return { session, ...this.#pipelines.get(session)! };
  }

  async #open(
    request: IncomingMessage,
    clientId: string,
    service: OcppService,
    password: string | undefined,
  ): Promise<SoapSession<CentralSystemActions> | SoapFault> {
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

    const registry = await this.#registry;
    const validation = resolveValidation(this.options.validation);
    let session!: SoapSession<CentralSystemActions>;
    const pipeline = this.createPipeline(() => session);
    session = new SoapSession<CentralSystemActions>({
      clientId,
      protocol: service.protocol,
      service: registry.service(service.protocol, 'ChargePoint'),
      spec: this.spec,
      outbound: this.outboundAllowed,
      validation,
      logger: this.logger,
      callTimeout: this.options.callTimeout ?? 30_000,
      timeout: this.options.sessionTimeout!,
      password,
      onClose: (s, reason) => this.removeSession(s, { reason }),
      codec: pipeline.codec,
    });
    this.#pipelines.set(session, pipeline);
    this.logger.info(`[${clientId}] connected via SOAP ${service.protocol}`);
    this.addSession(session);
    return session;
  }
}
