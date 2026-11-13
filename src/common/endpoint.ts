import { randomUUID } from 'node:crypto';
import { CallQueue } from './call-queue.js';
import type { PayloadCodec } from './codec.js';
import { ConnectionError, OcppError, TimeoutError } from './errors.js';
import type { InboundDispatcher } from './inbound.js';
import type { Logger } from './logger.js';
import type { ProtocolSpec } from './protocol.js';
import {
  Call,
  CallError,
  CallResult,
  RpcParseError,
  parseMessage,
  type RpcMessage,
} from './rpc.js';
import type { CallOptions } from './types.js';

export interface RpcEndpointOptions<S> {
  spec: ProtocolSpec;
  codec: PayloadCodec;
  inbound: InboundDispatcher<S>;
  /** Actions this side may initiate. */
  outbound: ReadonlySet<string>;
  session: S;
  logger: Logger;
  /** Default response timeout in ms. */
  callTimeout: number;
  /** Used in log lines. */
  label: string;
}

interface Pending {
  id: string;
  action: string;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * One OCPP-J conversation: frames outbound calls (strictly one at a time),
 * correlates responses, and answers inbound calls via the dispatcher.
 * The transport is attachable so a client can keep its queue across reconnects.
 */
export class RpcEndpoint<S> {
  readonly #o: RpcEndpointOptions<S>;
  readonly #queue = new CallQueue({ paused: true });
  #write: ((text: string) => void) | undefined;
  #pending: Pending | undefined;

  constructor(options: RpcEndpointOptions<S>) {
    this.#o = options;
  }

  get connected(): boolean {
    return this.#write !== undefined;
  }

  /** Number of outbound calls waiting to be sent. */
  get queued(): number {
    return this.#queue.size;
  }

  attach(write: (text: string) => void): void {
    this.#write = write;
    this.#queue.resume();
  }

  /**
   * Detaches the transport. The in-flight call is rejected (its response can never arrive);
   * queued calls are kept for the next `attach()` or rejected, depending on `keepQueue`.
   */
  detach(reason: Error, { keepQueue = false } = {}): void {
    this.#write = undefined;
    this.#queue.pause();
    this.#pending?.reject(reason);
    this.#pending = undefined;
    if (!keepQueue) this.#queue.clear(reason);
  }

  async call(action: string, payload: unknown, options: CallOptions = {}): Promise<unknown> {
    if (!this.#o.outbound.has(action)) {
      throw new OcppError(this.#o.spec.errorCodes.NotSupported, `Sending ${action} is not allowed`);
    }
    const wire = this.#o.codec.encode(action, 'request', payload);
    const response = await this.#queue.push(
      () => this.#transmit(action, wire, options),
      options.signal,
    );
    return this.#o.codec.decode(action, 'response', response);
  }

  /** Feeds one received text frame into the endpoint. */
  receive(text: string): void {
    this.#o.logger.debug(`[${this.#o.label}] ←`, text);
    let message: RpcMessage;
    try {
      message = parseMessage(text);
    } catch (error) {
      if (!(error instanceof RpcParseError)) throw error;
      this.#o.logger.warn(`[${this.#o.label}] ${error.message}`, text);
      const code = this.#o.spec.errorCodes[error.kind];
      // OCPP 2.0.1: unreadable message ids are answered with id "-1".
      this.#send(new CallError(error.messageId ?? '-1', code, error.message));
      return;
    }

    if (message instanceof Call) {
      void this.#answer(message);
    } else if (this.#pending?.id === message.id) {
      const pending = this.#pending;
      this.#pending = undefined;
      if (message instanceof CallResult) pending.resolve(message.payload);
      else pending.reject(new OcppError(message.code, message.description, message.details));
    } else {
      this.#o.logger.warn(`[${this.#o.label}] Ignoring response to unknown message ${message.id}`);
    }
  }

  #transmit(action: string, payload: unknown, options: CallOptions): Promise<unknown> {
    const { signal, timeout = this.#o.callTimeout } = options;
    return new Promise((resolve, reject) => {
      if (!this.#write) return reject(new ConnectionError('Not connected'));
      signal?.throwIfAborted();

      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (this.#pending?.id === id) this.#pending = undefined;
      };
      const onAbort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`No response to ${action} within ${timeout} ms`));
      }, timeout);
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#pending = {
        id,
        action,
        resolve: (value) => (cleanup(), resolve(value)),
        reject: (error) => (cleanup(), reject(error)),
      };
      this.#send(new Call(id, action, payload));
    });
  }

  async #answer(call: Call): Promise<void> {
    const result = await this.#o.inbound.process(
      this.#o.session,
      call.id,
      call.action,
      call.payload,
    );
    this.#send(
      result.ok
        ? new CallResult(call.id, result.payload)
        : new CallError(call.id, result.error.code, result.error.description, result.error.details),
    );
  }

  #send(message: RpcMessage): void {
    if (!this.#write) {
      this.#o.logger.warn(`[${this.#o.label}] Dropping message ${message.id}: not connected`);
      return;
    }
    const text = JSON.stringify(message);
    this.#o.logger.debug(`[${this.#o.label}] →`, text);
    this.#write(text);
  }
}
