/** Request/response payload pair of a single OCPP action. */
export interface ActionDefinition {
  request: object;
  response: object;
}

/** Maps action names to their payload types, e.g. `{ Heartbeat: { request: …; response: … } }`. */
export type ActionMap = Record<string, ActionDefinition>;

export type ActionName<M extends ActionMap> = Extract<keyof M, string>;

/** Union of all request payloads of an action map. */
export type AnyRequest<M extends ActionMap> = M[ActionName<M>]['request'];

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/**
 * Reverse lookup: the action(s) whose request payload type is exactly `P`.
 * Powers the explicit-payload generic form, e.g. `send<RemoteStartTransactionRequest>(…)`.
 */
export type ActionOf<M extends ActionMap, P> = {
  [A in ActionName<M>]: Equals<M[A]['request'], P> extends true ? A : never;
}[ActionName<M>];

/** Response payload belonging to request payload type `P`. */
export type ResponseOf<M extends ActionMap, P> = M[ActionOf<M, P>]['response'];

export type Awaitable<T> = T | PromiseLike<T>;

export interface CallOptions {
  /** Milliseconds to wait for the response once the call has been transmitted. */
  timeout?: number;
  /** Aborts the call while it is still queued or awaiting its response. */
  signal?: AbortSignal;
}

/** Everything known about an inbound call while it is being handled. */
export interface CallContext<S = unknown> {
  readonly action: string;
  readonly messageId: string;
  /** The session (server side) or client (client side) the call was received on. */
  readonly session: S;
  /** Decoded, validated request payload. */
  readonly request: unknown;
  /** Response payload; set by the handler, may be inspected or replaced by middleware. */
  response?: unknown;
}

export type Handler<Req, Res, S> = (payload: Req, context: CallContext<S>) => Awaitable<Res>;

/**
 * Koa-style middleware around inbound call handling.
 * Call `next()` to continue; throw an `OcppError` to answer with a CALLERROR.
 */
export type Middleware<S> = (context: CallContext<S>, next: () => Promise<void>) => Awaitable<void>;
