import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PayloadCodec } from '../common/codec.js';
import { ValidationError } from '../common/errors.js';
import type { InboundDispatcher } from '../common/inbound.js';
import type { Logger } from '../common/logger.js';
import type { ProtocolSpec } from '../common/protocol.js';
import type { ValidationConfig } from '../common/validation.js';
import { toCurrent, toLegacy } from './legacy.js';
import type { OcppService, ServiceRole, SoapProtocol, WsdlRegistry } from './wsdl.js';
import {
  addressingHeaders,
  envelope,
  fault,
  parseEnvelope,
  SOAP11_NS,
  SOAP12_NS,
  type Envelope,
  type FaultInit,
} from './xml.js';

export interface SoapFault extends FaultInit {
  status: number;
}

export const isFault = (value: object): value is SoapFault =>
  'reason' in value && 'status' in value;

/** What a request is processed with, once its sender has been identified. */
export interface ResolvedRequest<S> {
  session: S;
  codec: PayloadCodec;
  inbound: InboundDispatcher<S>;
}

export interface SoapResponderOptions<S> {
  /** Role of *this* side, i.e. which service is being served. */
  role: ServiceRole;
  registry: Promise<WsdlRegistry>;
  /** Accepted protocol versions; `undefined` accepts every version with a WSDL. */
  protocols: ReadonlySet<SoapProtocol> | undefined;
  spec: ProtocolSpec;
  validation: ValidationConfig;
  logger: Logger;
  maxBodySize: number;
  /** Identifies/authenticates the sender; returns a fault to refuse the request. */
  resolve(
    request: IncomingMessage,
    envelope: Envelope,
    service: OcppService,
  ): Promise<ResolvedRequest<S> | SoapFault>;
}

/**
 * Serves one side of OCPP-S over HTTP:
 * parse → XSD-validate → dispatch to handler → serialize → XSD-validate → reply,
 * answering every failure with a SOAP fault carrying the OCPP error code.
 */
export class SoapResponder<S> {
  readonly #o: SoapResponderOptions<S>;

  constructor(options: SoapResponderOptions<S>) {
    this.#o = options;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let soapNs = SOAP12_NS;
    try {
      const registry = await this.#o.registry;
      if (
        request.method === 'GET' &&
        new URL(request.url ?? '/', 'http://x').search.toLowerCase() === '?wsdl'
      ) {
        return this.#serveWsdl(registry, response);
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' }).end();
        return;
      }

      const xml = await readBody(request, this.#o.maxBodySize);
      if (xml === undefined) return void response.writeHead(413).end();

      let message: Envelope;
      try {
        message = parseEnvelope(xml);
        soapNs = message.soapNs;
      } catch (error) {
        return this.#fault(response, soapNs, {
          status: 400,
          code: 'Sender',
          subcode: this.#code('FormatViolation'),
          reason: `Malformed SOAP message: ${(error as Error).message}`,
        });
      }

      const service = registry.byNamespace(message.body.namespaceURI);
      if (
        !service ||
        service.role !== this.#o.role ||
        (this.#o.protocols && !this.#o.protocols.has(service.protocol))
      ) {
        return this.#fault(response, soapNs, {
          status: 400,
          code: 'Sender',
          subcode: this.#code('NotSupported'),
          reason: `Unsupported message namespace ${message.body.namespaceURI ?? '(none)'}`,
        });
      }
      const action = service.actionByElement.get(message.body.localName ?? '');
      if (!action) {
        return this.#fault(response, soapNs, {
          status: 400,
          code: 'Sender',
          subcode: this.#code('NotImplemented'),
          subcodeNs: service.namespace,
          reason: `Unknown operation ${message.body.localName}`,
        });
      }

      const resolved = await this.#o.resolve(request, message, service);
      if (isFault(resolved))
        return this.#fault(response, soapNs, { subcodeNs: service.namespace, ...resolved });

      const inboundIssue = await this.#validate(
        service,
        message.body,
        action,
        'request',
        'inbound',
        resolved.codec,
      );
      if (inboundIssue) {
        return this.#fault(response, soapNs, {
          status: 400,
          code: 'Sender',
          subcode: this.#code(inboundIssue.errorKind),
          subcodeNs: service.namespace,
          reason: inboundIssue.message,
        });
      }

      const parsed = service.wsdl.xmlToObject(xml) as { Body?: Record<string, unknown> };
      const { attributes: _, ...raw } = asObject(parsed.Body?.[message.body.localName ?? '']);
      const args = toCurrent(service.protocol, `${action}Request`, raw);
      const messageId = message.headers.messageId ?? '';
      const result = await resolved.inbound.process(resolved.session, messageId, action, args);
      if (!result.ok) {
        const receiver = result.error.code === this.#code('InternalError');
        return this.#fault(response, soapNs, {
          status: receiver ? 500 : 400,
          code: receiver ? 'Receiver' : 'Sender',
          subcode: result.error.code,
          subcodeNs: service.namespace,
          reason: result.error.description || result.error.code,
        });
      }

      const operation = service.operations.get(action)!;
      const body = service.wsdl.objectToDocumentXML(
        operation.responseElement,
        toLegacy(service.protocol, `${action}Response`, asObject(result.payload)),
        operation.responseAlias ?? 'tns',
        service.namespace,
      ) as string;
      const outboundIssue = await this.#validate(
        service,
        body,
        action,
        'response',
        'outbound',
        resolved.codec,
      );
      if (outboundIssue) {
        this.#o.logger.error(`Invalid ${action} response`, outboundIssue);
        return this.#fault(response, soapNs, {
          status: 500,
          code: 'Receiver',
          subcode: this.#code('InternalError'),
          subcodeNs: service.namespace,
          reason: 'Invalid response payload',
        });
      }

      const headers = addressingHeaders({
        action: `/${action}Response`,
        relatesTo: message.headers.messageId,
        to: message.headers.replyTo,
      });
      this.#write(response, soapNs, 200, envelope(soapNs, body, headers));
    } catch (error) {
      this.#o.logger.error('Failed to process SOAP request', error);
      if (!response.headersSent) {
        this.#fault(response, soapNs, {
          status: 500,
          code: 'Receiver',
          subcode: this.#code('InternalError'),
          reason: 'Internal error',
        });
      }
    }
  }

  /** XSD validation; returns the error to refuse with, or undefined to continue. */
  async #validate(
    service: OcppService,
    element: Parameters<OcppService['xsd']['validate']>[0],
    action: string,
    kind: 'request' | 'response',
    direction: 'inbound' | 'outbound',
    codec: PayloadCodec,
  ): Promise<ValidationError | undefined> {
    if (this.#o.validation[direction] === 'off') return undefined;
    const issues = await service.xsd.validate(element);
    if (!issues.length) return undefined;
    try {
      codec.report(new ValidationError({ action, kind, direction, issues }));
      return undefined;
    } catch (error) {
      if (error instanceof ValidationError) return error;
      throw error;
    }
  }

  #serveWsdl(registry: WsdlRegistry, response: ServerResponse) {
    const services = this.#o.protocols ? [...this.#o.protocols] : registry.protocols(this.#o.role);
    const latest = services.sort().at(-1);
    const service = latest && registry.service(latest, this.#o.role);
    if (!service) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    createReadStream(service.file).pipe(response);
  }

  #code(kind: keyof ProtocolSpec['errorCodes']) {
    return this.#o.spec.errorCodes[kind];
  }

  #fault(response: ServerResponse, soapNs: string, f: SoapFault) {
    this.#write(response, soapNs, f.status, envelope(soapNs, fault(soapNs, f)));
  }

  #write(response: ServerResponse, soapNs: string, status: number, body: string) {
    const type = soapNs === SOAP11_NS ? 'text/xml' : 'application/soap+xml';
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` }).end(body);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.removeAllListeners('data');
        request.resume();
        resolve(undefined);
      } else chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}
