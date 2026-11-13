import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CallQueue } from '../common/call-queue.js';
import { OcppClient, type ClientOptions } from '../common/client.js';
import type { PayloadValidator } from '../common/codec.js';
import { ConnectionError, OcppError } from '../common/errors.js';
import type { CallOptions } from '../common/types.js';
import { resolveValidation } from '../common/validation.js';
import { protocol } from '../ocpp16j/protocol.js';
import type { CentralSystemActions, ChargePointActions } from '../ocpp16j/types.generated.js';
import { SoapCaller } from './caller.js';
import { SoapResponder } from './responder.js';
import { WsdlRegistry } from './wsdl.js';

export interface SoapClientOptions extends ClientOptions<CentralSystemActions, ChargePointActions> {
  /** Central system SOAP endpoint, e.g. `https://cs.example.com/ocpp`. */
  url: string;
  /** Directory with the OCPP WSDL files. Default: the bundled `schemas/wsdl`. */
  wsdlDir?: string | URL;
  /**
   * Serve calls from the central system (needs the ChargePointService WSDL).
   * Its address is announced to the central system via WS-Addressing `From`.
   */
  server?: {
    port?: number;
    hostname?: string;
    route?: string;
    /** Externally reachable URL of this endpoint. Default: derived from hostname/port/route. */
    publicUrl?: string;
  };
  /** Maximum request size in bytes. Default: 1 MiB. */
  maxBodySize?: number;
}

/** OCPP 1.6S charge point (SOAP 1.2 + WS-Addressing). */
export class SoapClient extends OcppClient<CentralSystemActions, ChargePointActions> {
  declare protected readonly options: SoapClientOptions;
  readonly #pipeline = this.createPipeline();
  readonly #queue = new CallQueue({ paused: true });
  #caller: SoapCaller | undefined;
  #http: HttpServer | undefined;
  #publicUrl: string | undefined;

  constructor(options: SoapClientOptions) {
    super(protocol, options);
  }

  get connected(): boolean {
    return this.#caller !== undefined;
  }

  /** URL under which this charge point receives calls (if `server` is configured). */
  get publicUrl(): string | undefined {
    return this.#publicUrl;
  }

  /** Loads the WSDLs and, if configured, starts the endpoint for incoming calls. */
  async connect(): Promise<void> {
    if (this.#caller) return;
    const registry = await WsdlRegistry.load(this.options.wsdlDir);
    const centralSystem = registry.service('ocpp1.6', 'CentralSystem');
    if (!centralSystem) throw new Error('OCPP 1.6 CentralSystemService WSDL not found');

    if (this.options.server) await this.#listen(registry);

    this.#caller = new SoapCaller({
      service: centralSystem,
      endpoint: this.options.url,
      identity: this.clientId,
      from: this.#publicUrl,
      validation: resolveValidation(this.options.validation),
      report: (error) => this.#pipeline.codec.report(error),
      logger: this.logger,
      callTimeout: this.options.callTimeout ?? 30_000,
    });
    this.#queue.resume();
    this.emit('connected');
  }

  async close(): Promise<void> {
    this.#queue.pause();
    this.#queue.clear(new ConnectionError('Client closed'));
    const wasConnected = this.connected;
    this.#caller = undefined;
    const http = this.#http;
    this.#http = undefined;
    if (http) {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
    if (wasConnected) this.emit('disconnected', { reason: 'Client closed' });
  }

  protected async call(
    action: string,
    payload: unknown,
    options: CallOptions = {},
  ): Promise<unknown> {
    if (!this.outboundAllowed.has(action)) {
      throw new OcppError(this.spec.errorCodes.NotSupported, `Sending ${action} is not allowed`);
    }
    const { codec } = this.#pipeline;
    const wire = codec.encode(action, 'request', payload);
    const response = await this.#queue.push(() => {
      if (!this.#caller) throw new ConnectionError('Not connected');
      return this.#caller.call(action, wire, options);
    }, options.signal);
    return codec.decode(action, 'response', response);
  }

  /** XSD validation happens on the XML level instead. */
  protected override schemaValidator(): PayloadValidator | undefined {
    return undefined;
  }

  async #listen(registry: WsdlRegistry) {
    const service = registry.service('ocpp1.6', 'ChargePoint');
    if (!service) throw new Error('Receiving calls requires the OCPP 1.6 ChargePointService WSDL');
    const { port = 0, hostname = 'localhost', route = '/', publicUrl } = this.options.server!;

    const responder = new SoapResponder({
      role: 'ChargePoint',
      registry: Promise.resolve(registry),
      protocols: new Set(['ocpp1.6'] as const),
      spec: protocol,
      validation: resolveValidation(this.options.validation),
      logger: this.logger,
      maxBodySize: this.options.maxBodySize ?? 1024 * 1024,
      resolve: async (_request, envelope) => {
        const identity = envelope.headers.chargeBoxIdentity;
        if (identity !== undefined && identity !== this.clientId) {
          return {
            status: 400,
            code: 'Sender',
            subcode: 'SecurityError',
            reason: 'chargeBoxIdentity mismatch',
          };
        }
        return { session: this, ...this.#pipeline };
      },
    });

    const http = createServer((req, res) => void responder.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, hostname, () => resolve());
    });
    this.#http = http;
    const address = http.address() as AddressInfo;
    this.#publicUrl = publicUrl ?? `http://${hostname}:${address.port}${route}`;
    this.logger.info(`[${this.clientId}] receiving calls at ${this.#publicUrl}`);
  }
}
