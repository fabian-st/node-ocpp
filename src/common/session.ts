import { randomUUID } from 'node:crypto';
import type {
  ActionMap,
  ActionName,
  ActionOf,
  AnyRequest,
  CallOptions,
  ResponseOf,
} from './types.js';

/** Server-side view of one connected charge point. */
export abstract class OcppSession<Out extends ActionMap = ActionMap> {
  /** Charge point identity (last URL segment for OCPP-J, `chargeBoxIdentity` for SOAP). */
  /** Unique id of this session (stable across cluster nodes). */
  readonly id: string;
  readonly clientId: string;
  /** Negotiated protocol, e.g. `ocpp1.6` or `ocpp2.0.1`. */
  readonly protocol: string;
  readonly connectedAt: Date;
  /** Free-form storage for application data attached to this session. */
  readonly data = new Map<string, unknown>();

  protected constructor(
    clientId: string,
    protocol: string,
    { id = randomUUID(), connectedAt = new Date() }: { id?: string; connectedAt?: Date } = {},
  ) {
    this.id = id;
    this.clientId = clientId;
    this.protocol = protocol;
    this.connectedAt = connectedAt;
  }

  abstract get connected(): boolean;

  /** Sends a call to the charge point and resolves with its (validated, typed) response. */
  send<A extends ActionName<Out>>(
    action: A,
    payload: Out[A]['request'],
    options?: CallOptions,
  ): Promise<Out[A]['response']>;
  send<P extends AnyRequest<Out>>(
    action: ActionOf<Out, P>,
    payload: P,
    options?: CallOptions,
  ): Promise<ResponseOf<Out, P>>;
  send(action: string, payload: unknown, options?: CallOptions): Promise<unknown> {
    return this.call(action, payload, options);
  }

  /** Ends the session. Queued calls are rejected. */
  abstract close(): Promise<void>;

  protected abstract call(
    action: string,
    payload: unknown,
    options?: CallOptions,
  ): Promise<unknown>;
}
