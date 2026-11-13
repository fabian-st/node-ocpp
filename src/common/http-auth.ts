import type { IncomingMessage } from 'node:http';
import type { PeerCertificate, TLSSocket } from 'node:tls';

/** Parses an HTTP Basic `Authorization` header. */
export function basicCredentials(request: IncomingMessage) {
  const [scheme, token] = (request.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !token) return undefined;
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return undefined;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** The peer's TLS client certificate, if one was presented and verified against the CA. */
export function verifiedCertificate(request: IncomingMessage): PeerCertificate | undefined {
  const socket = request.socket as Partial<TLSSocket>;
  if (!socket.encrypted || !socket.authorized) return undefined;
  return socket.getPeerCertificate?.();
}
