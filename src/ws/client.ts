import { WebSocket, type ClientOptions as WsOptions } from 'ws';
import { OcppClient, type ClientOptions } from '../common/client.js';
import { RpcEndpoint } from '../common/endpoint.js';
import { ConnectionError } from '../common/errors.js';
import type { ProtocolSpec } from '../common/protocol.js';
import type { ActionMap, CallOptions } from '../common/types.js';
import { keepalive } from './keepalive.js';

export interface ReconnectOptions {
  /** Delay before the first retry in ms. Default: `1000`. */
  minDelay: number;
  /** Upper bound for the delay in ms. Default: `60000`. */
  maxDelay: number;
  /** Growth factor per attempt. Default: `2`. */
  factor: number;
  /** Random ± fraction applied to every delay. Default: `0.25`. */
  jitter: number;
  /** Give up after this many consecutive failures. Default: `Infinity`. */
  maxAttempts: number;
}

export interface WsClientOptions<
  In extends ActionMap = ActionMap,
  Out extends ActionMap = ActionMap,
> extends ClientOptions<In, Out> {
  /** Central system endpoint without the client id, e.g. `wss://cs.example.com/ocpp`. */
  url: string;
  /** HTTP Basic auth password (Security Profile 1/2); the username is the client id. */
  password?: string;
  /** TLS options, e.g. a client certificate for Security Profile 3. */
  tls?: Pick<WsOptions, 'ca' | 'cert' | 'key' | 'pfx' | 'passphrase' | 'rejectUnauthorized'>;
  /** Additional HTTP headers for the upgrade request. */
  headers?: Record<string, string>;
  /** Reconnect automatically with exponential backoff. Default: `true`. */
  reconnect?: boolean | Partial<ReconnectOptions>;
  /** Queue calls while disconnected and send them after reconnecting. Default: `true`. */
  offlineQueue?: boolean;
  /** Milliseconds between WebSocket pings; `0` disables keepalive. Default: `30000`. */
  pingInterval?: number;
}

const DEFAULT_RECONNECT: ReconnectOptions = {
  minDelay: 1_000,
  maxDelay: 60_000,
  factor: 2,
  jitter: 0.25,
  maxAttempts: Infinity,
};

/** OCPP-J (JSON over WebSocket) charge point. Subclassed per protocol version. */
export abstract class WsClient<In extends ActionMap, Out extends ActionMap> extends OcppClient<
  In,
  Out
> {
  declare protected readonly options: WsClientOptions<In, Out>;
  readonly #endpoint: RpcEndpoint<OcppClient<In, Out>>;
  readonly #reconnect: ReconnectOptions | undefined;
  #socket: WebSocket | undefined;
  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #closed = false;
  #waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

  protected constructor(spec: ProtocolSpec, options: WsClientOptions<In, Out>) {
    super(spec, options);
    const { reconnect = true } = options;
    this.#reconnect = reconnect
      ? { ...DEFAULT_RECONNECT, ...(reconnect === true ? {} : reconnect) }
      : undefined;
    this.#endpoint = new RpcEndpoint<OcppClient<In, Out>>({
      spec,
      ...this.createPipeline(),
      outbound: this.outboundAllowed,
      session: this,
      logger: this.logger,
      callTimeout: options.callTimeout ?? 30_000,
      label: options.clientId,
    });
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#endpoint.connected;
  }

  /** Number of calls waiting to be sent (e.g. while offline). */
  get queued(): number {
    return this.#endpoint.queued;
  }

  /**
   * Connects to the central system. Resolves once connected; with reconnect enabled,
   * failed attempts are retried until success, `maxAttempts`, or `close()`.
   */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.#closed = false;
    const connected = new Promise<void>((resolve, reject) =>
      this.#waiters.push({ resolve, reject }),
    );
    if (!this.#socket && !this.#timer) this.#open();
    return connected;
  }

  /** Disconnects for good: no reconnect, queued calls are rejected. */
  async close(code = 1000, reason = ''): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const error = new ConnectionError('Client closed');
    this.#settle(error);
    this.#endpoint.detach(error);

    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.close(code, reason);
    const timer = setTimeout(() => socket.terminate(), 5_000);
    await closed;
    clearTimeout(timer);
  }

  protected call(action: string, payload: unknown, options?: CallOptions): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ConnectionError('Client closed'));
    if (!this.connected && this.options.offlineQueue === false) {
      return Promise.reject(new ConnectionError('Not connected'));
    }
    return this.#endpoint.call(action, payload, options);
  }

  #open() {
    this.#timer = undefined;
    const { url, password, tls, headers, clientId } = this.options;
    const target = `${url.replace(/\/+$/, '')}/${encodeURIComponent(clientId)}`;
    const authorization =
      password === undefined
        ? {}
        : { authorization: `Basic ${Buffer.from(`${clientId}:${password}`).toString('base64')}` };

    const socket = new WebSocket(target, [this.spec.subprotocol], {
      ...tls,
      headers: { ...headers, ...authorization },
    });
    this.#socket = socket;
    let opened = false;
    let lastError: Error | undefined;

    socket.on('open', () => {
      if (socket.protocol !== this.spec.subprotocol) {
        lastError = new ConnectionError(
          `Server did not accept subprotocol ${this.spec.subprotocol}`,
        );
        return socket.close(1002, 'Subprotocol not negotiated');
      }
      opened = true;
      this.#attempt = 0;
      const interval = this.options.pingInterval ?? 30_000;
      keepalive(socket, { interval, timeout: interval * 2 });
      this.#endpoint.attach((text) => socket.send(text));
      this.logger.info(`[${clientId}] connected to ${target}`);
      this.emit('connected');
      this.#settle();
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) this.#endpoint.receive(data.toString());
    });
    socket.on('error', (error) => {
      lastError = error;
      this.logger.warn(`[${clientId}] ${error.message}`);
    });
    socket.once('close', (code, reasonBuffer) => {
      this.#socket = undefined;
      const reason = reasonBuffer.toString() || lastError?.message || '';
      const error = new ConnectionError(`Connection closed (${code}${reason ? ` ${reason}` : ''})`);
      this.#endpoint.detach(error, {
        keepQueue: !this.#closed && this.options.offlineQueue !== false,
      });
      if (opened) {
        this.logger.info(`[${clientId}] disconnected (${code})`);
        this.emit('disconnected', { code, reason });
      }
      if (!this.#closed) this.#retry(lastError ?? error);
    });
  }

  #retry(cause: Error) {
    const options = this.#reconnect;
    if (!options || this.#attempt >= options.maxAttempts) {
      const error = new ConnectionError(`Could not connect: ${cause.message}`, { cause });
      this.#endpoint.detach(error);
      this.#settle(error);
      return;
    }
    const base = Math.min(options.maxDelay, options.minDelay * options.factor ** this.#attempt);
    const delay = Math.max(0, Math.round(base * (1 + (Math.random() * 2 - 1) * options.jitter)));
    this.#attempt++;
    this.emit('reconnecting', { attempt: this.#attempt, delay });
    this.#timer = setTimeout(() => this.#open(), delay);
  }

  /** Resolves (or rejects) everyone waiting in `connect()`. */
  #settle(error?: Error) {
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }
}
