import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { ConnectionError } from '../common/errors.js';
import { RpcEndpoint, type RpcEndpointOptions } from '../common/endpoint.js';
import { OcppSession } from '../common/session.js';
import type { ActionMap, CallOptions } from '../common/types.js';

export interface WsSessionInit<S> extends Omit<RpcEndpointOptions<S>, 'session' | 'label'> {
  clientId: string;
  socket: WebSocket;
  request: IncomingMessage;
}

/** A charge point connected via OCPP-J (WebSocket). */
export class WsSession<Out extends ActionMap = ActionMap> extends OcppSession<Out> {
  /** The HTTP upgrade request (headers, URL, socket). */
  readonly request: IncomingMessage;
  readonly #socket: WebSocket;
  readonly #endpoint: RpcEndpoint<WsSession<Out>>;

  /** @internal Created by the server. */
  constructor(init: WsSessionInit<WsSession<Out>>) {
    super(init.clientId, init.socket.protocol);
    this.request = init.request;
    this.#socket = init.socket;
    this.#endpoint = new RpcEndpoint<WsSession<Out>>({
      ...init,
      session: this,
      label: init.clientId,
    });
    this.#endpoint.attach((text) => this.#socket.send(text));
    this.#socket.on('message', (data, isBinary) => {
      if (!isBinary) this.#endpoint.receive(data.toString());
    });
    this.#socket.once('close', (code, reason) =>
      this.#endpoint.detach(new ConnectionError(`Connection closed (${code} ${reason})`)),
    );
  }

  get connected(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  get remoteAddress(): string | undefined {
    return this.request.socket.remoteAddress;
  }

  async close(code = 1000, reason = ''): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.#socket.once('close', () => resolve()));
    this.#socket.close(code, reason);
    // Don't hang on peers that never complete the closing handshake.
    const timer = setTimeout(() => this.#socket.terminate(), 5_000);
    await closed;
    clearTimeout(timer);
  }

  protected call(action: string, payload: unknown, options?: CallOptions): Promise<unknown> {
    return this.#endpoint.call(action, payload, options);
  }
}
