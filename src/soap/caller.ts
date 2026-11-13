import { randomUUID } from 'node:crypto';
import { Client, HttpClient, type IHttpClient } from 'soap';
import { ConnectionError, OcppError, TimeoutError, ValidationError } from '../common/errors.js';
import type { Logger } from '../common/logger.js';
import type { CallOptions } from '../common/types.js';
import type { ValidationConfig } from '../common/validation.js';
import { toCurrent, toLegacy } from './legacy.js';
import type { OcppService } from './wsdl.js';
import { addressingHeaders, parseEnvelope, WSA_ANONYMOUS } from './xml.js';

export interface SoapCallerOptions {
  /** Service description of the *remote* side. */
  service: OcppService;
  /** Remote endpoint URL. */
  endpoint: string;
  /** chargeBoxIdentity sent with every call. */
  identity: string;
  /** Our own endpoint URL (wsa:From), so the peer can call us back. */
  from?: string | undefined;
  validation: ValidationConfig;
  /** Applies the validation mode (throws in strict mode). */
  report: (error: ValidationError) => void;
  logger: Logger;
  callTimeout: number;
}

/**
 * Performs OCPP-S calls through node-soap. A validating HTTP client sits between
 * node-soap and the network, checking request and response XML against the XSD.
 */
export class SoapCaller {
  readonly #o: SoapCallerOptions;
  readonly #client: Client;
  #action = '';

  constructor(options: SoapCallerOptions) {
    this.#o = options;
    this.#client = new Client(options.service.wsdl, options.endpoint, {
      forceSoap12Headers: options.service.soap12,
      httpClient: this.#validatingHttpClient(),
    });
  }

  set endpoint(url: string) {
    this.#o.endpoint = url;
    this.#client.setEndpoint(url);
  }

  async call(action: string, payload: unknown, options: CallOptions = {}): Promise<unknown> {
    const { service, identity, from, endpoint } = this.#o;
    if (!service.operations.has(action)) {
      throw new OcppError('NotSupported', `${action} does not exist in ${service.protocol}`);
    }
    this.#action = action;
    this.#client.clearSoapHeaders();
    this.#client.addSoapHeader(
      addressingHeaders({
        chargeBoxIdentity: identity,
        identityNs: service.namespace,
        action: `/${action}`,
        messageId: `urn:uuid:${randomUUID()}`,
        from,
        replyTo: WSA_ANONYMOUS,
        to: endpoint,
      }),
    );

    const method = this.#client[`${action}Async`] as (
      args: unknown,
      options: object,
    ) => Promise<[result: unknown]>;
    try {
      const [result] = await method.call(
        this.#client,
        toLegacy(service.protocol, `${action}Request`, asObject(payload)),
        {
          timeout: options.timeout ?? this.#o.callTimeout,
          signal: options.signal,
        },
      );
      const { attributes: _, ...response } = asObject(result);
      return toCurrent(service.protocol, `${action}Response`, response);
    } catch (error) {
      throw toError(error, action);
    }
  }

  #validatingHttpClient(): IHttpClient {
    const inner = new HttpClient();
    const check = async (
      xml: string,
      kind: 'request' | 'response',
      direction: 'inbound' | 'outbound',
    ) => {
      if (this.#o.validation[direction] === 'off') return;
      const { body } = parseEnvelope(xml);
      if (body.localName === 'Fault') return;
      const issues = await this.#o.service.xsd.validate(body);
      if (issues.length) {
        this.#o.report(new ValidationError({ action: this.#action, kind, direction, issues }));
      }
    };

    return {
      request: (url, data, callback, headers, options) => {
        check(String(data), 'request', 'outbound').then(
          () =>
            inner.request(
              url,
              data,
              (error, response, body) => {
                if (error) return callback(error, response, body);
                check(String(body), 'response', 'inbound').then(
                  () => callback(null, response, body),
                  (e: unknown) => callback(e),
                );
              },
              headers,
              options,
            ),
          (e: unknown) => callback(e),
        );
        return undefined as never;
      },
    };
  }
}

interface SoapFaultBody {
  Code?: { Value?: string; Subcode?: { Value?: string } };
  Reason?: { Text?: string | { $value?: string } };
  faultcode?: string;
  faultstring?: string;
}

/** Maps node-soap/axios errors onto the library's error types. */
function toError(error: unknown, action: string): Error {
  if (error instanceof OcppError || error instanceof ValidationError) return error;
  const e = error as {
    root?: { Envelope?: { Body?: { Fault?: SoapFaultBody } } };
    code?: string;
    message?: string;
  };
  const f = e.root?.Envelope?.Body?.Fault;
  if (f) {
    const qname = f.Code?.Subcode?.Value ?? f.Code?.Value ?? f.faultcode ?? 'GenericError';
    const reason =
      typeof f.Reason?.Text === 'object' ? f.Reason.Text.$value : (f.Reason?.Text ?? f.faultstring);
    return new OcppError(qname.replace(/^.*:/, ''), reason ?? '');
  }
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
    return new TimeoutError(`No response to ${action}`);
  }
  if (error instanceof Error && error.name === 'CanceledError') return error;
  return new ConnectionError(`${action} failed: ${e.message ?? String(error)}`, { cause: error });
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
