import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionError, OcppError, TimeoutError, ValidationError, ocpp16 } from '../src/index.js';
import { defer, once, sleep } from './helpers.js';

async function setup(
  serverOptions: ocpp16.ServerOptions = {},
  clientOptions: Partial<ocpp16.ClientOptions> = {},
) {
  const server = defer(new ocpp16.Server({ authRequired: false, ...serverOptions }));
  const { port } = await server.listen(0);
  const client = defer(
    new ocpp16.Client({ url: `ws://localhost:${port}/ocpp`, clientId: 'CP-1', ...clientOptions }),
  );
  return { server, client, port };
}

/** A raw WebSocket peer for protocol-level assertions. */
async function rawClient(port: number, id = 'RAW') {
  const ws = new WebSocket(`ws://localhost:${port}/ocpp/${id}`, ['ocpp1.6']);
  await once(ws, 'open');
  const next = async () => JSON.parse(String((await once(ws, 'message'))[0])) as unknown[];
  return { ws, next, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
}

describe('ocpp16 (JSON)', () => {
  it('round-trips a typed call with automatic Date conversion', async () => {
    const { server, client } = await setup();
    const now = new Date('2026-01-01T12:00:00.000Z');
    server.handle('BootNotification', async (payload, { session }) => {
      expect(payload.chargePointVendor).toBe('ACME');
      expect(session.clientId).toBe('CP-1');
      return { currentTime: now, status: 'Accepted', interval: 120 };
    });

    await client.connect();
    const response = await client.send('BootNotification', {
      chargePointVendor: 'ACME',
      chargePointModel: 'X1',
    });
    expect(response.currentTime).toBeInstanceOf(Date);
    expect(response.currentTime.getTime()).toBe(now.getTime());
    expect(response.status).toBe('Accepted');
  });

  it('lets the server call the client (example.ts flow)', async () => {
    const { server, client } = await setup();
    client.handle('RemoteStartTransaction', ({ idTag }) => ({
      status: idTag === '1234567890' ? 'Accepted' : 'Rejected',
    }));

    const connected = once(server, 'client_connected');
    await client.connect();
    const [session] = (await connected) as [ocpp16.Session];

    const response = await server.send<ocpp16.RemoteStartTransactionRequest>(
      session.clientId,
      'RemoteStartTransaction',
      { idTag: '1234567890' },
    );
    expect(response).toEqual({ status: 'Accepted' });
    await expect(session.send('RemoteStartTransaction', { idTag: 'x' })).resolves.toEqual({
      status: 'Rejected',
    });
  });

  it('rejects invalid outbound payloads before sending', async () => {
    const { client } = await setup();
    await client.connect();
    const error = await client
      .send('Authorize', { idTag: 'x'.repeat(21) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      direction: 'outbound',
      errorKind: 'PropertyConstraintViolation',
    });
  });

  it('answers invalid inbound calls with the 1.6 error codes', async () => {
    const { server, port } = await setup();
    server.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
    const raw = await rawClient(port);

    raw.send([2, 'a', 'Authorize', {}]);
    expect((await raw.next()).slice(0, 3)).toEqual([4, 'a', 'OccurenceConstraintViolation']);

    raw.send([2, 'b', 'Authorize', { idTag: 42 }]);
    expect((await raw.next()).slice(0, 3)).toEqual([4, 'b', 'TypeConstraintViolation']);

    raw.send([2, 'c', 'Authorize', { idTag: 'ok', extra: true }]);
    expect((await raw.next()).slice(0, 3)).toEqual([4, 'c', 'FormationViolation']);

    raw.send([2, 'd', 'Teleport', {}]);
    expect((await raw.next()).slice(0, 3)).toEqual([4, 'd', 'NotImplemented']);

    raw.send([2, 'e', 'Heartbeat', {}]);
    expect((await raw.next()).slice(0, 3)).toEqual([4, 'e', 'NotSupported']);

    raw.send([2, 'f', 'Authorize', { idTag: 'ok' }]);
    expect(await raw.next()).toEqual([3, 'f', { idTagInfo: { status: 'Accepted' } }]);
    raw.ws.close();
  });

  it("emits validation_error and processes the message in 'warn' mode", async () => {
    const { server, port } = await setup({ validation: { inbound: 'warn' } });
    server.handle('Authorize', () => ({ idTagInfo: { status: 'Accepted' } }));
    const warning = once(server, 'validation_error');
    const raw = await rawClient(port);
    raw.send([2, 'a', 'Authorize', { idTag: 'x'.repeat(30) }]);
    expect(await raw.next()).toEqual([3, 'a', { idTagInfo: { status: 'Accepted' } }]);
    const [error, session] = await warning;
    expect(error).toBeInstanceOf(ValidationError);
    expect((session as ocpp16.Session).clientId).toBe('RAW');
    raw.ws.close();
  });

  it('maps thrown OcppErrors to CALLERROR and rejects send() with them', async () => {
    const { server, client } = await setup();
    server.handle('Authorize', () => {
      throw new ocpp16.OcppError('SecurityError', 'Nope', { hint: 1 });
    });
    await client.connect();
    const error = await client.send('Authorize', { idTag: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OcppError);
    expect(error).toMatchObject({
      code: 'SecurityError',
      description: 'Nope',
      details: { hint: 1 },
    });
  });

  it('answers handler crashes and invalid handler responses with InternalError', async () => {
    const { server, client } = await setup();
    server.handle('Authorize', () => {
      throw new Error('boom');
    });
    server.handle('Heartbeat', () => ({}) as never);
    await client.connect();
    await expect(client.send('Authorize', { idTag: 'x' })).rejects.toMatchObject({
      code: 'InternalError',
    });
    await expect(client.send('Heartbeat', {})).rejects.toMatchObject({ code: 'InternalError' });
  });

  it('runs middleware around handlers', async () => {
    const { server, client } = await setup();
    const order: string[] = [];
    server.use(async (ctx, next) => {
      order.push(`before ${ctx.action}`);
      await next();
      order.push('after');
    });
    server.use((ctx, next) => {
      if ((ctx.request as { idTag: string }).idTag === 'blocked') {
        ctx.response = { idTagInfo: { status: 'Blocked' } };
        return;
      }
      return next();
    });
    server.handle(
      'Authorize',
      () => (order.push('handler'), { idTagInfo: { status: 'Accepted' } }),
    );
    await client.connect();

    expect(await client.send('Authorize', { idTag: 'ok' })).toEqual({
      idTagInfo: { status: 'Accepted' },
    });
    expect(await client.send('Authorize', { idTag: 'blocked' })).toEqual({
      idTagInfo: { status: 'Blocked' },
    });
    expect(order).toEqual(['before Authorize', 'handler', 'after', 'before Authorize', 'after']);
  });

  it('sends concurrent calls strictly one after another', async () => {
    const { server, client } = await setup();
    let active = 0;
    let maxActive = 0;
    server.handle('Heartbeat', async () => {
      maxActive = Math.max(maxActive, ++active);
      await sleep(20);
      active--;
      return { currentTime: new Date() };
    });
    await client.connect();
    await Promise.all([1, 2, 3].map(() => client.send('Heartbeat', {})));
    expect(maxActive).toBe(1);
  });

  it('times out unanswered calls', async () => {
    const { server, client } = await setup();
    server.handle('Heartbeat', () => new Promise(() => {}));
    await client.connect();
    await expect(client.send('Heartbeat', {}, { timeout: 50 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('enforces actionsAllowed in both directions', async () => {
    const { server, client } = await setup({ actionsAllowed: ocpp16.profiles.Core });
    server.handle('FirmwareStatusNotification', () => ({}));
    const connected = once(server, 'client_connected');
    await client.connect();
    await connected;
    await expect(
      client.send('FirmwareStatusNotification', { status: 'Idle' }),
    ).rejects.toMatchObject({
      code: 'NotSupported',
    });
    await expect(
      server.send('CP-1', 'TriggerMessage', { requestedMessage: 'Heartbeat' }),
    ).rejects.toMatchObject({
      code: 'NotSupported',
    });
  });

  describe('authentication', () => {
    it('denies connections when nobody accepts them (authRequired)', async () => {
      const { client } = await setup({ authRequired: true }, { reconnect: false });
      await expect(client.connect()).rejects.toThrow(/401/);
    });

    it('passes basic-auth credentials to connection_request', async () => {
      const { server, client } = await setup(
        { authRequired: true },
        { password: 's3cret', reconnect: false },
      );
      server.on('connection_request', (request) => {
        expect(request.clientId).toBe('CP-1');
        expect(request.protocol).toBe('ocpp1.6');
        if (request.password === 's3cret') request.accept();
        else request.reject(403, 'Wrong password');
      });
      await expect(client.connect()).resolves.toBeUndefined();
    });

    it('supports asynchronous rejections with custom status', async () => {
      const { server, client } = await setup({ authRequired: false }, { reconnect: false });
      server.on('connection_request', async (request) => {
        await sleep(5);
        request.reject(403, 'Banned');
      });
      await expect(client.connect()).rejects.toThrow(/403/);
    });
  });

  it('reconnects and delivers calls queued while offline', async () => {
    const { server, client } = await setup(
      {},
      { reconnect: { minDelay: 20, maxDelay: 50, jitter: 0 } },
    );
    const received = vi.fn(() => ({ currentTime: new Date() }));
    server.handle('Heartbeat', received);
    await client.connect();

    const disconnected = once(client, 'disconnected');
    await server.sessions.get('CP-1')!.close(1012, 'restart');
    await disconnected;
    expect(client.connected).toBe(false);

    const pending = client.send('Heartbeat', {});
    expect(client.queued).toBe(1);
    await expect(pending).resolves.toHaveProperty('currentTime');
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('rejects queued calls when the client is closed', async () => {
    const { client } = await setup({}, { reconnect: false });
    const pending = client.send('Heartbeat', {});
    await client.close();
    await expect(pending).rejects.toBeInstanceOf(ConnectionError);
  });

  it('replaces an existing session with the same client id', async () => {
    const { server, client, port } = await setup();
    await client.connect();
    const first = server.sessions.get('CP-1')!;
    const disconnected = once(server, 'client_disconnected');
    const second = defer(
      new ocpp16.Client({ url: `ws://localhost:${port}/ocpp`, clientId: 'CP-1', reconnect: false }),
    );
    await second.connect();
    const [session] = await disconnected;
    expect(session).toBe(first);
    expect(server.sessions.get('CP-1')).not.toBe(first);
    expect(server.sessions.size).toBe(1);
  });

  it('rejects unsupported subprotocols', async () => {
    const { port } = await setup();
    const ws = new WebSocket(`ws://localhost:${port}/ocpp/X`, ['ocpp2.0.1']);
    const [, response] = await once(ws, 'unexpected-response');
    expect(response.statusCode).toBe(400);
  });
});

describe('naming', () => {
  it('exports ocpp16 as an alias of ocpp16j', async () => {
    const root = await import('../src/index.js');
    expect(root.ocpp16).toBe(root.ocpp16j);
  });
});
