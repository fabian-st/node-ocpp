import { STATUS_CODES, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { ConnectionRequest } from '../common/connection-request.js';
import { basicCredentials, verifiedCertificate } from '../common/http-auth.js';
import type { ProtocolSpec } from '../common/protocol.js';
import { OcppServer, type ServerOptions } from '../common/server.js';
import type { ActionMap } from '../common/types.js';
import { keepalive } from './keepalive.js';
import { WsSession } from './session.js';
import { UpgradeRouter, reject, type UpgradeTarget } from './upgrade-router.js';

export interface WsServerOptions<
  In extends ActionMap = ActionMap,
  Out extends ActionMap = ActionMap,
> extends ServerOptions<In, Out> {
  /** Milliseconds between WebSocket pings; `0` disables pings. Default: `sessionTimeout / 3`. */
  pingInterval?: number;
  /** Maximum accepted frame size in bytes. Default: 1 MiB. */
  maxPayload?: number;
}

/** OCPP-J (JSON over WebSocket) central system. Subclassed per protocol version. */
export abstract class WsServer<In extends ActionMap, Out extends ActionMap>
  extends OcppServer<In, Out, WsSession<Out>>
  implements UpgradeTarget
{
  declare protected readonly options: WsServerOptions<In, Out>;
  readonly #wss: WebSocketServer;
  #pendingUpgrades = 0;

  protected constructor(spec: ProtocolSpec, options: WsServerOptions<In, Out> = {}) {
    super(spec, options);
    this.#wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: options.maxPayload ?? 1024 * 1024,
      handleProtocols: () => spec.subprotocol,
    });
  }

  /** The route (without trailing slash) clients connect to, e.g. `/ocpp`. */
  get route(): string {
    return (this.options.route ?? '/ocpp').replace(/\/+$/, '');
  }

  get subprotocol(): string {
    return this.spec.subprotocol;
  }

  /** Closes a session superseded by a newer connection of the same charge point on another node. */
  protected override evictSession(session: WsSession<Out>): void {
    void session.close(1000, 'Replaced by a newer connection');
  }

  attach(server: HttpServer): this {
    UpgradeRouter.for(server).add(this);
    return this;
  }

  detach(server: HttpServer): this {
    UpgradeRouter.for(server).delete(this);
    return this;
  }

  /** @internal Called by the upgrade router. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#upgrade(request, socket, head).catch((error: unknown) => {
      this.logger.error('Upgrade failed', error);
      reject(socket, 500, 'Internal Server Error');
    });
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    let clientId: string;
    try {
      clientId = decodeURIComponent(path.slice(this.route.length + 1));
    } catch {
      return reject(socket, 400, 'Bad Request', 'Malformed client id');
    }
    if (!clientId || clientId.includes('/')) return reject(socket, 404, 'Not Found');

    if (this.sessions.size + this.#pendingUpgrades >= (this.options.maxConnections ?? 511)) {
      return reject(socket, 503, 'Service Unavailable');
    }

    const credentials = this.options.basicAuth === false ? undefined : basicCredentials(request);
    if (credentials && credentials.username !== clientId) {
      return reject(socket, 401, 'Unauthorized', 'Username must equal the client id');
    }

    this.#pendingUpgrades++;
    let decision;
    try {
      decision = await this.authorize(
        new ConnectionRequest({
          clientId,
          protocol: this.spec.subprotocol,
          request,
          password: credentials?.password,
          certificate: this.options.certificateAuth ? verifiedCertificate(request) : undefined,
        }),
      );
    } finally {
      this.#pendingUpgrades--;
    }

    if (!decision.accepted) {
      this.logger.info(`[${clientId}] connection rejected: ${decision.status} ${decision.reason}`);
      return reject(
        socket,
        decision.status,
        STATUS_CODES[decision.status] ?? 'Error',
        decision.reason,
        decision.status === 401 ? { 'WWW-Authenticate': 'Basic realm="OCPP"' } : {},
      );
    }
    if (socket.destroyed) return;
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#open(ws, request, clientId));
  }

  #open(socket: WebSocket, request: IncomingMessage, clientId: string) {
    const sessionTimeout = this.options.sessionTimeout ?? 30_000;
    const session: WsSession<Out> = new WsSession<Out>({
      clientId,
      socket,
      request,
      spec: this.spec,
      ...this.createPipeline(() => session),
      outbound: this.outboundAllowed,
      logger: this.logger,
      callTimeout: this.options.callTimeout ?? 30_000,
    });
    keepalive(socket, {
      interval: this.options.pingInterval ?? Math.floor(sessionTimeout / 3),
      timeout: sessionTimeout,
    });
    socket.on('error', (error) => this.logger.warn(`[${clientId}] socket error`, error));
    socket.once('close', (code, reason) => {
      this.logger.info(`[${clientId}] disconnected (${code})`);
      this.removeSession(session, { code, reason: reason.toString() });
    });
    this.logger.info(`[${clientId}] connected via ${socket.protocol}`);
    this.addSession(session);
  }
}
