import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

export interface UpgradeTarget {
  readonly route: string;
  readonly subprotocol: string;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
}

const routers = new WeakMap<HttpServer, UpgradeRouter>();

/**
 * Lets several OCPP servers (e.g. 1.6 and 2.0.1) share one HTTP server:
 * WebSocket upgrades are routed by path and negotiated subprotocol,
 * honouring the client's order of preference.
 */
export class UpgradeRouter {
  static for(server: HttpServer): UpgradeRouter {
    let router = routers.get(server);
    if (!router) routers.set(server, (router = new UpgradeRouter(server)));
    return router;
  }

  readonly #server: HttpServer;
  readonly #targets = new Set<UpgradeTarget>();

  private constructor(server: HttpServer) {
    this.#server = server;
  }

  add(target: UpgradeTarget): void {
    for (const other of this.#targets) {
      if (other.subprotocol === target.subprotocol && other.route === target.route) {
        throw new Error(`${target.subprotocol} is already served on ${target.route}`);
      }
    }
    if (this.#targets.size === 0) this.#server.on('upgrade', this.#onUpgrade);
    this.#targets.add(target);
  }

  delete(target: UpgradeTarget): void {
    this.#targets.delete(target);
    if (this.#targets.size === 0) this.#server.off('upgrade', this.#onUpgrade);
  }

  readonly #onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const candidates = [...this.#targets].filter((t) => path.startsWith(`${t.route}/`));
    if (candidates.length === 0) {
      // Leave foreign upgrade requests to other listeners, if there are any.
      if (this.#server.listenerCount('upgrade') === 1) reject(socket, 404, 'Not Found');
      return;
    }

    const offered = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const target = offered
      .map((p) => candidates.find((t) => t.subprotocol === p))
      .find((t) => t !== undefined);

    if (!target) {
      const supported = candidates.map((t) => t.subprotocol).join(', ');
      return reject(socket, 400, 'Bad Request', `Supported subprotocols: ${supported}`);
    }
    target.handleUpgrade(request, socket, head);
  };
}

/** Answers an upgrade request with a plain HTTP error and closes the socket. */
export function reject(
  socket: Duplex,
  status: number,
  statusText: string,
  body = statusText,
  headers: Record<string, string> = {},
): void {
  if (!socket.writable) return void socket.destroy();
  const head = Object.entries({
    Connection: 'close',
    'Content-Type': 'text/plain',
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers,
  })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\n${head}\r\n\r\n${body}`);
}
