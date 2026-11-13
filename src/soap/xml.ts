import { DOMParser, XMLSerializer, onErrorStopParsing, type Element } from '@xmldom/xmldom';
import { validateXML } from 'xmllint-wasm';
import type { ValidationIssue } from '../common/errors.js';

export const SOAP12_NS = 'http://www.w3.org/2003/05/soap-envelope';
export const SOAP11_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const WSA_NS = 'http://www.w3.org/2005/08/addressing';
export const WSA_ANONYMOUS = `${WSA_NS}/anonymous`;
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const XSD_NS = 'http://www.w3.org/2001/XMLSchema';

export const parseXml = (xml: string) =>
  new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, 'text/xml');

export const serialize = (node: Element) => new XMLSerializer().serializeToString(node);

export const escapeXml = (value: string) =>
  value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

const elementChildren = (node: Element): Element[] =>
  Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1);

const child = (node: Element | undefined, ns: string, name: string) =>
  node && elementChildren(node).find((c) => c.namespaceURI === ns && c.localName === name);

const text = (node: Element | undefined) => node?.textContent?.trim() || undefined;

/** WS-Addressing and OCPP headers of a SOAP message. */
export interface SoapHeaders {
  chargeBoxIdentity?: string | undefined;
  action?: string | undefined;
  messageId?: string | undefined;
  relatesTo?: string | undefined;
  from?: string | undefined;
  replyTo?: string | undefined;
  to?: string | undefined;
}

export interface Envelope {
  /** SOAP envelope namespace (1.1 or 1.2). */
  soapNs: string;
  headers: SoapHeaders;
  /** First element inside `Body` (the OCPP message or a `Fault`). */
  body: Element;
}

/** Parses a SOAP envelope; throws on malformed XML or structure. */
export function parseEnvelope(xml: string): Envelope {
  const root = parseXml(xml).documentElement;
  const soapNs = root?.namespaceURI;
  if (!root || root.localName !== 'Envelope' || (soapNs !== SOAP12_NS && soapNs !== SOAP11_NS)) {
    throw new Error('Not a SOAP envelope');
  }
  const body = elementChildren(child(root, soapNs, 'Body') ?? root).find(Boolean);
  if (!body || body.parentNode === root) throw new Error('SOAP body is empty');

  const header = child(root, soapNs, 'Header');
  const headerElements = header ? elementChildren(header) : [];
  const wsa = (name: string) => child(header, WSA_NS, name);
  return {
    soapNs,
    body,
    headers: {
      chargeBoxIdentity: text(headerElements.find((e) => e.localName === 'chargeBoxIdentity')),
      action: text(wsa('Action')),
      messageId: text(wsa('MessageID')),
      relatesTo: text(wsa('RelatesTo')),
      from: text(child(wsa('From'), WSA_NS, 'Address')),
      replyTo: text(child(wsa('ReplyTo'), WSA_NS, 'Address')),
      to: text(wsa('To')),
    },
  };
}

/** WS-Addressing (+ chargeBoxIdentity) header elements as required by OCPP-S. */
export function addressingHeaders(h: SoapHeaders & { identityNs?: string }): string {
  const wsa = (name: string, value: string | undefined) =>
    value === undefined
      ? ''
      : `<wsa:${name} xmlns:wsa="${WSA_NS}">${escapeXml(value)}</wsa:${name}>`;
  const address = (name: string, value: string | undefined) =>
    value === undefined
      ? ''
      : `<wsa:${name} xmlns:wsa="${WSA_NS}"><wsa:Address>${escapeXml(value)}</wsa:Address></wsa:${name}>`;
  return [
    h.chargeBoxIdentity !== undefined && h.identityNs
      ? `<ocpp:chargeBoxIdentity xmlns:ocpp="${h.identityNs}">${escapeXml(h.chargeBoxIdentity)}</ocpp:chargeBoxIdentity>`
      : '',
    wsa('Action', h.action),
    wsa('MessageID', h.messageId),
    wsa('RelatesTo', h.relatesTo),
    address('From', h.from),
    address('ReplyTo', h.replyTo),
    wsa('To', h.to),
  ].join('');
}

export function envelope(soapNs: string, body: string, headers = ''): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${soapNs}">` +
    (headers ? `<soap:Header>${headers}</soap:Header>` : '') +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

export interface FaultInit {
  /** `Sender` (client's fault) or `Receiver` (server's fault). */
  code: 'Sender' | 'Receiver';
  /** OCPP error code, rendered as fault subcode. */
  subcode?: string | undefined;
  /** Namespace of the subcode QName. */
  subcodeNs?: string | undefined;
  reason: string;
}

export function fault(soapNs: string, f: FaultInit): string {
  if (soapNs === SOAP11_NS) {
    const code = f.code === 'Sender' ? 'soap:Client' : 'soap:Server';
    return `<soap:Fault><faultcode>${code}</faultcode><faultstring>${escapeXml(f.reason)}</faultstring></soap:Fault>`;
  }
  const subcode = f.subcode
    ? `<soap:Subcode><soap:Value${f.subcodeNs ? ` xmlns:ocpp="${f.subcodeNs}"` : ''}>${f.subcodeNs ? 'ocpp:' : ''}${escapeXml(f.subcode)}</soap:Value></soap:Subcode>`
    : '';
  return (
    `<soap:Fault><soap:Code><soap:Value>soap:${f.code}</soap:Value>${subcode}</soap:Code>` +
    `<soap:Reason><soap:Text xml:lang="en">${escapeXml(f.reason)}</soap:Text></soap:Reason></soap:Fault>`
  );
}

/** Extracts the embedded XML schema from a WSDL, carrying over inherited namespace declarations. */
export function extractSchema(wsdlXml: string): string {
  const root = parseXml(wsdlXml).documentElement;
  const schema = root?.getElementsByTagNameNS(XSD_NS, 'schema')[0];
  if (!root || !schema) throw new Error('WSDL contains no XML schema');
  for (const attr of Array.from(root.attributes)) {
    if (attr.name.startsWith('xmlns') && !schema.hasAttribute(attr.name)) {
      schema.setAttributeNS(XMLNS_NS, attr.name, attr.value);
    }
  }
  return serialize(schema);
}

/** Validates XML fragments against an XSD using libxml2 (WebAssembly). */
export class XsdValidator {
  readonly #schema: { fileName: string; contents: string };

  constructor(xsd: string) {
    this.#schema = { fileName: 'ocpp.xsd', contents: xsd };
  }

  async validate(element: Element | string): Promise<ValidationIssue[]> {
    const contents = typeof element === 'string' ? element : serialize(element);
    const result = await validateXML({
      xml: [{ fileName: 'message.xml', contents }],
      schema: [this.#schema],
    });
    return result.errors.map((e) => toIssue(e.message));
  }
}

function toIssue(message: string): ValidationIssue {
  const path = /Element '(?:\{[^}]*\})?([^']+)'/.exec(message)?.[1] ?? '';
  const keyword = /Missing child element|is not complete/.test(message)
    ? 'required'
    : /not a valid value of the atomic type/.test(message)
      ? 'type'
      : /enumeration|facet|length/.test(message)
        ? 'enum'
        : 'xsd';
  return { path, message: message.trim(), keyword };
}
