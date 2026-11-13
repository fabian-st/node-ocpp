import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { toWire } from '../dates.js';
import { ConnectionError, OcppError, TimeoutError, ValidationError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { OcppSession } from '../session.js';
import type { CallOptions } from '../types.js';
import type { ClusterAdapter } from './adapter.js';

export interface ClusterOptions {
  adapter: ClusterAdapter;
  /**
   * Prefix of all keys and channels; every node of one logical OCPP server must use the same.
   * Default: `ocpp:<subprotocol>` (WebSocket) or `ocpp:soap`.
   */
  namespace?: string;
  /** Unique id of this node. Default: `<hostname>:<pid>:<random>`. */
  nodeId?: string;
  /** Milliseconds after which a node that stopped heartbeating is considered dead. Default: `15000`. */
  nodeTtl?: number;
}

/** Where a session lives in the cluster. */
export interface SessionInfo {
  clientId: string;
  sessionId: string;
  /** Node holding (WebSocket) or having authorized (SOAP) the session. */
  nodeId: string;
  protocol: string;
  connectedAt: Date;
  /** Whether this node holds the session. */
  local: boolean;
}

/** @internal Stored per client id. */
export interface SessionRecord {
  clientId: string;
  sessionId: string;
  nodeId: string;
  protocol: string;
  connectedAt: number;
  /** `true`: lives as long as its node (WebSocket). `false`: expires by TTL (SOAP). */
  bound: boolean;
  data?: Record<string, unknown>;
}

/** @internal What the cluster needs from the server it belongs to. */
export interface ClusterHost {
  localSession(clientId: string): OcppSession<any> | undefined;
  remoteConnected(info: SessionInfo, record: SessionRecord): void;
  remoteDisconnected(info: SessionInfo, reason: string): void;
  /** Close a local session superseded by a newer connection on another node. */
  evict(session: OcppSession<any>): void;
}

type InboxMessage =
  | {
      t: 'call';
      id: string;
      from: string;
      clientId: string;
      action: string;
      payload: unknown;
      timeout: number;
    }
  | { t: 'cancel'; id: string }
  | { t: 'result'; id: string; payload: unknown }
  | { t: 'error'; id: string; error: SerializedError };

type EventMessage = { origin: string } & (
  | { t: 'connected'; record: SessionRecord }
  | { t: 'disconnected'; record: SessionRecord; reason: string }
);

interface SerializedError {
  type: 'OcppError' | 'ValidationError' | 'TimeoutError' | 'ConnectionError' | 'Error';
  message: string;
  code?: string;
  details?: Record<string, unknown>;
  validation?: ConstructorParameters<typeof ValidationError>[0];
}

/** Extra time a routed call may take on top of its timeout (network, queueing). */
const GRACE = 2_000;

const defaultNodeId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * One node's membership in a cluster of OCPP servers: heartbeat, session registry,
 * call routing to the node holding a connection, cluster-wide events and eviction.
 */
export class Cluster {
  readonly nodeId: string;
  readonly namespace: string;
  readonly #adapter: ClusterAdapter;
  readonly #host: ClusterHost;
  readonly #logger: Logger;
  readonly #nodeTtl: number;
  readonly #ready: Promise<void>;
  readonly #unsubscribe: (() => Promise<void>)[] = [];
  /** Node-bound records registered by this node, by client id. */
  readonly #local = new Map<string, SessionRecord>();
  /** Calls this node routed elsewhere, awaiting a reply. */
  readonly #pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** Calls other nodes routed to this node, still running. */
  readonly #running = new Map<string, AbortController>();
  readonly #alive = new Map<string, number>();
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: ClusterOptions & { namespace: string }, host: ClusterHost, logger: Logger) {
    this.#adapter = options.adapter;
    this.namespace = options.namespace;
    this.nodeId = options.nodeId ?? defaultNodeId;
    this.#nodeTtl = options.nodeTtl ?? 15_000;
    this.#host = host;
    this.#logger = logger;
    this.#ready = this.#start();
    this.#ready.catch((error: unknown) => logger.error('Failed to join cluster', error));
  }

  /** Resolves once subscribed and announced. */
  ready(): Promise<void> {
    return this.#ready;
  }

  // --- registry ---------------------------------------------------------------

  /** Announces a new session to the cluster. */
  async register(
    session: OcppSession<any>,
    {
      bound,
      ttl,
      data,
    }: { bound: boolean; ttl?: number | undefined; data?: Record<string, unknown> },
  ): Promise<SessionRecord> {
    await this.#ready;
    const record: SessionRecord = {
      clientId: session.clientId,
      sessionId: session.id,
      nodeId: this.nodeId,
      protocol: session.protocol,
      connectedAt: session.connectedAt.getTime(),
      bound,
      ...(data && { data }),
    };
    if (bound) this.#local.set(record.clientId, record);
    await this.#adapter.set(this.#sessionKey(record.clientId), JSON.stringify(record), ttl);
    await this.#emit({ origin: this.nodeId, t: 'connected', record });
    return record;
  }

  /** Rewrites a record (e.g. to extend its TTL), without announcing anything. */
  async refresh(record: SessionRecord, ttl?: number): Promise<void> {
    await this.#ready;
    await this.#adapter.set(this.#sessionKey(record.clientId), JSON.stringify(record), ttl);
  }

  /** Removes a session's record (if still current) and announces the disconnect. */
  async unregister(session: OcppSession<any>, reason: string): Promise<void> {
    await this.#ready;
    const own = this.#local.get(session.clientId);
    if (own?.sessionId === session.id) this.#local.delete(session.clientId);
    const current = await this.#remove(session.clientId, session.id);
    const record: SessionRecord = current ?? {
      clientId: session.clientId,
      sessionId: session.id,
      nodeId: own?.nodeId ?? this.nodeId,
      protocol: session.protocol,
      connectedAt: session.connectedAt.getTime(),
      bound: own !== undefined,
    };
    await this.#emit({ origin: this.nodeId, t: 'disconnected', record, reason });
  }

  /** Deletes the record of `clientId` if it still belongs to `sessionId`; returns it. */
  async #remove(clientId: string, sessionId: string): Promise<SessionRecord | undefined> {
    const key = this.#sessionKey(clientId);
    const raw = await this.#adapter.get(key);
    const current = raw === undefined ? undefined : (JSON.parse(raw) as SessionRecord);
    if (raw === undefined || current?.sessionId !== sessionId) return undefined;
    await this.#adapter.delete(key, raw);
    return current;
  }

  /** The current record of `clientId`, if its session is alive. */
  async lookup(clientId: string): Promise<SessionRecord | undefined> {
    await this.#ready;
    const key = this.#sessionKey(clientId);
    const raw = await this.#adapter.get(key);
    if (raw === undefined) return undefined;
    const record = JSON.parse(raw) as SessionRecord;
    if (record.bound && !(await this.#isAlive(record.nodeId))) {
      await this.#adapter.delete(key, raw); // left behind by a crashed node
      return undefined;
    }
    return record;
  }

  /** All live session records. */
  async records(): Promise<SessionRecord[]> {
    await this.#ready;
    const [sessions, nodes] = await Promise.all([
      this.#adapter.scan(this.#sessionKey('')),
      this.#adapter.scan(this.#nodeKey('')),
    ]);
    const alive = new Set([...nodes.keys()].map((k) => k.slice(this.#nodeKey('').length)));
    return [...sessions.values()]
      .map((raw) => JSON.parse(raw) as SessionRecord)
      .filter((r) => !r.bound || alive.has(r.nodeId));
  }

  info(record: SessionRecord): SessionInfo {
    return {
      clientId: record.clientId,
      sessionId: record.sessionId,
      nodeId: record.nodeId,
      protocol: record.protocol,
      connectedAt: new Date(record.connectedAt),
      local: this.#host.localSession(record.clientId)?.id === record.sessionId,
    };
  }

  // --- routed calls -----------------------------------------------------------

  /**
   * Sends a call to a charge point connected to another node. Resolves with the
   * (validated) wire payload of the response; the caller revives dates.
   */
  async call(
    record: SessionRecord,
    action: string,
    payload: unknown,
    options: CallOptions,
    defaultTimeout: number,
  ): Promise<unknown> {
    await this.#ready;
    const { signal } = options;
    signal?.throwIfAborted();
    const id = randomUUID();
    const timeout = options.timeout ?? defaultTimeout;

    return new Promise((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.#pending.delete(id);
        settle();
      };
      const timer = setTimeout(
        () =>
          finish(() => reject(new TimeoutError(`No response to ${action} within ${timeout} ms`))),
        timeout + GRACE,
      );
      const onAbort = () => {
        void this.#send(record.nodeId, { t: 'cancel', id });
        finish(() => reject(signal!.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      this.#send(record.nodeId, {
        t: 'call',
        id,
        from: this.nodeId,
        clientId: record.clientId,
        action,
        payload: toWire(payload),
        timeout,
      }).catch((error: unknown) => finish(() => reject(error)));
    });
  }

  /** Leaves the cluster: records of this node are removed, pending calls rejected. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#heartbeat);
    await this.#ready.catch(() => {});
    for (const pending of this.#pending.values())
      pending.reject(new ConnectionError('Cluster closed'));
    for (const running of this.#running.values())
      running.abort(new ConnectionError('Cluster closed'));
    await Promise.allSettled([
      ...[...this.#local.values()].map((r) => this.#remove(r.clientId, r.sessionId)),
      this.#adapter.delete(this.#nodeKey(this.nodeId)),
    ]);
    await Promise.allSettled(this.#unsubscribe.map((unsubscribe) => unsubscribe()));
  }

  // --- internals --------------------------------------------------------------

  async #start() {
    this.#unsubscribe.push(
      await this.#adapter.subscribe(this.#inbox(this.nodeId), (m) => this.#onInbox(m)),
      await this.#adapter.subscribe(`${this.namespace}:events`, (m) => this.#onEvent(m)),
    );
    const beat = () =>
      this.#adapter
        .set(this.#nodeKey(this.nodeId), JSON.stringify({ since: Date.now() }), this.#nodeTtl)
        .catch((error: unknown) => this.#logger.error('Cluster heartbeat failed', error));
    await beat();
    this.#heartbeat = setInterval(beat, Math.floor(this.#nodeTtl / 3));
    this.#heartbeat.unref();
  }

  #onInbox(raw: string) {
    const message = JSON.parse(raw) as InboxMessage;
    switch (message.t) {
      case 'call':
        return void this.#serve(message);
      case 'cancel':
        return this.#running.get(message.id)?.abort(new Error('Cancelled by caller'));
      case 'result':
        return this.#pending.get(message.id)?.resolve(message.payload);
      case 'error':
        return this.#pending.get(message.id)?.reject(deserializeError(message.error));
    }
  }

  async #serve(call: Extract<InboxMessage, { t: 'call' }>) {
    const controller = new AbortController();
    this.#running.set(call.id, controller);
    try {
      const session = this.#host.localSession(call.clientId);
      if (!session) throw new ConnectionError(`Client ${call.clientId} is not connected`);
      // The deadline covers queueing on this node as well.
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(call.timeout)]);
      const send = session.send as (a: string, p: unknown, o: CallOptions) => Promise<unknown>;
      const response = await send.call(session, call.action, call.payload, {
        timeout: call.timeout,
        signal,
      });
      await this.#send(call.from, { t: 'result', id: call.id, payload: toWire(response) });
    } catch (error) {
      await this.#send(call.from, { t: 'error', id: call.id, error: serializeError(error) });
    } finally {
      this.#running.delete(call.id);
    }
  }

  #onEvent(raw: string) {
    const message = JSON.parse(raw) as EventMessage;
    const { record } = message;
    if (message.origin === this.nodeId) return;
    if (message.t === 'disconnected') {
      return this.#host.remoteDisconnected(this.info(record), message.reason);
    }

    // A charge point connected elsewhere: the newer of two connections wins.
    const own = this.#local.get(record.clientId);
    const local = this.#host.localSession(record.clientId);
    if (record.bound && own && local && local.id === own.sessionId) {
      const newer =
        record.connectedAt > own.connectedAt ||
        (record.connectedAt === own.connectedAt && record.nodeId > this.nodeId);
      if (newer) {
        this.#logger.info(`[${record.clientId}] superseded by a connection on ${record.nodeId}`);
        this.#host.evict(local);
      } else {
        // Our connection is newer: make sure the registry points to us.
        void this.refresh(own).catch((e: unknown) =>
          this.#logger.error('Cluster refresh failed', e),
        );
      }
    }
    this.#host.remoteConnected(this.info(record), record);
  }

  async #isAlive(nodeId: string): Promise<boolean> {
    if (nodeId === this.nodeId) return true;
    if ((this.#alive.get(nodeId) ?? 0) > Date.now()) return true;
    const alive = (await this.#adapter.get(this.#nodeKey(nodeId))) !== undefined;
    if (alive) this.#alive.set(nodeId, Date.now() + this.#nodeTtl / 3);
    return alive;
  }

  #send(nodeId: string, message: InboxMessage) {
    return this.#adapter.publish(this.#inbox(nodeId), JSON.stringify(message));
  }

  #emit(message: EventMessage) {
    return this.#adapter.publish(`${this.namespace}:events`, JSON.stringify(message));
  }

  #sessionKey = (clientId: string) => `${this.namespace}:session:${clientId}`;
  #nodeKey = (nodeId: string) => `${this.namespace}:node:${nodeId}`;
  #inbox = (nodeId: string) => `${this.namespace}:inbox:${nodeId}`;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof OcppError) {
    return {
      type: 'OcppError',
      message: error.description,
      code: error.code,
      details: error.details,
    };
  }
  if (error instanceof ValidationError) {
    const { action, kind, direction, issues } = error;
    return {
      type: 'ValidationError',
      message: error.message,
      validation: { action, kind, direction, issues },
    };
  }
  const { name, message } =
    error instanceof Error ? error : { name: 'Error', message: String(error) };
  if (name === 'TimeoutError') return { type: 'TimeoutError', message };
  if (name === 'ConnectionError') return { type: 'ConnectionError', message };
  return { type: 'Error', message };
}

function deserializeError(e: SerializedError): Error {
  switch (e.type) {
    case 'OcppError':
      return new OcppError(e.code ?? 'GenericError', e.message, e.details);
    case 'ValidationError':
      return new ValidationError(e.validation!);
    case 'TimeoutError':
      return new TimeoutError(e.message);
    case 'ConnectionError':
      return new ConnectionError(e.message);
    default:
      return new Error(e.message);
  }
}
