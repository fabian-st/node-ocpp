import type { IncomingMessage } from 'node:http';
import type { PeerCertificate } from 'node:tls';

export type ConnectionDecision =
  { accepted: true } | { accepted: false; status: number; reason: string };

export interface ConnectionRequestInit {
  clientId: string;
  protocol: string;
  request: IncomingMessage;
  password?: string;
  certificate?: PeerCertificate;
}

/**
 * A charge point asking to connect. Emitted as `connection_request`;
 * a listener decides by calling `accept()` or `reject()` (possibly asynchronously).
 */
export class ConnectionRequest {
  readonly clientId: string;
  /** Requested protocol, e.g. `ocpp1.6`. */
  readonly protocol: string;
  /** Password from HTTP Basic auth (Security Profile 1/2), if sent and `basicAuth` is enabled. */
  readonly password: string | undefined;
  /** Verified TLS client certificate (Security Profile 3), if `certificateAuth` is enabled. */
  readonly certificate: PeerCertificate | undefined;
  /** The underlying HTTP request (headers, socket, …). */
  readonly request: IncomingMessage;

  #decision: ConnectionDecision | undefined;
  readonly #decided: Promise<ConnectionDecision>;
  #settle!: (decision: ConnectionDecision) => void;

  constructor(init: ConnectionRequestInit) {
    this.clientId = init.clientId;
    this.protocol = init.protocol;
    this.password = init.password;
    this.certificate = init.certificate;
    this.request = init.request;
    this.#decided = new Promise((resolve) => (this.#settle = resolve));
  }

  get remoteAddress(): string | undefined {
    return this.request.socket.remoteAddress;
  }

  /** Whether `accept()` or `reject()` has been called. */
  get decided(): boolean {
    return this.#decision !== undefined;
  }

  accept(): void {
    this.#decide({ accepted: true });
  }

  /** @param status HTTP status sent to the charge point, 401 by default. */
  reject(status = 401, reason = 'Unauthorized'): void {
    this.#decide({ accepted: false, status, reason });
  }

  /** @internal Waits for a decision, falling back to `fallback` after `timeout` ms. */
  async wait(timeout: number, fallback: ConnectionDecision): Promise<ConnectionDecision> {
    const timer = setTimeout(() => this.#decide(fallback), timeout);
    try {
      return await this.#decided;
    } finally {
      clearTimeout(timer);
    }
  }

  #decide(decision: ConnectionDecision) {
    if (this.#decision) return;
    this.#decision = decision;
    this.#settle(decision);
  }
}
