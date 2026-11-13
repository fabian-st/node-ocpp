import { describe, expect, it, vi } from 'vitest';
import { ConnectionError, OcppError, TimeoutError, ocpp16, ocpp16s } from '../src/index.js';
import type { ClusterAdapter } from '../src/index.js';
import { defer, once } from './helpers.js';

/** Runs the suite against any adapter; exported for the Redis variant. */
export function clusterSuite(
  name: string,
  createAdapter: () => ClusterAdapter | Promise<ClusterAdapter>,
) {
  describe(`cluster (${name})`, () => {
    async function nodes() {
      const adapter = await createAdapter();
      const namespace = `test:${Math.random().toString(36).slice(2)}`;
      const node = async (nodeId: string) => {
        const server = defer(
          new ocpp16.Server({ authRequired: false, cluster: { adapter, nodeId, namespace } }),
        );
        const { port } = await server.listen(0);
        return { server, url: `ws://localhost:${port}/ocpp` };
      };
      const [a, b] = await Promise.all([node('A'), node('B')]);
      const client = (url: string, clientId = 'CP-1') =>
        defer(new ocpp16.Client({ url, clientId, reconnect: false }));
      return { a, b, client, adapter, namespace };
    }

    it('routes send() to the node holding the connection, reviving dates', async () => {
      const { a, b, client } = await nodes();
      const cp = client(a.url);
      const scheduleStart = new Date('2026-06-01T00:00:00.000Z');
      cp.handle('GetCompositeSchedule', ({ duration }) => ({
        status: 'Accepted',
        scheduleStart,
        chargingSchedule: {
          duration,
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 16 }],
        },
      }));
      const announced = once(b.server, 'remote_client_connected');
      await cp.connect();
      await announced;

      const response = await b.server.send('CP-1', 'GetCompositeSchedule', {
        connectorId: 1,
        duration: 60,
      });
      expect(response.scheduleStart).toEqual(scheduleStart);
      expect(response.chargingSchedule?.duration).toBe(60);
    });

    it('provides cluster-wide presence and events', async () => {
      const { a, b, client } = await nodes();
      const cp = client(a.url);
      const connected = once(b.server, 'remote_client_connected');
      await cp.connect();
      const [info] = await connected;
      expect(info).toMatchObject({
        clientId: 'CP-1',
        nodeId: 'A',
        protocol: 'ocpp1.6',
        local: false,
      });

      expect(await b.server.isConnected('CP-1')).toBe(true);
      expect(await b.server.locate('CP-1')).toMatchObject({ nodeId: 'A', local: false });
      expect(await a.server.locate('CP-1')).toMatchObject({ nodeId: 'A', local: true });
      expect(await b.server.clientIds()).toEqual(['CP-1']);
      expect(b.server.sessions.size).toBe(0);

      const disconnected = once(b.server, 'remote_client_disconnected');
      await cp.close();
      const [gone] = await disconnected;
      expect(gone).toMatchObject({ clientId: 'CP-1', nodeId: 'A' });
      expect(await b.server.isConnected('CP-1')).toBe(false);
      expect(await b.server.clientIds()).toEqual([]);
    });

    it('propagates OCPP errors, validation errors and unknown clients', async () => {
      const { a, b, client } = await nodes();
      const cp = client(a.url);
      cp.handle('Reset', () => {
        throw new ocpp16.OcppError('NotSupported', 'No reset today');
      });
      const announced = once(b.server, 'remote_client_connected');
      await cp.connect();
      await announced;

      await expect(b.server.send('CP-1', 'Reset', { type: 'Soft' })).rejects.toMatchObject({
        constructor: OcppError,
        code: 'NotSupported',
        description: 'No reset today',
      });
      await expect(
        b.server.send('CP-1', 'Reset', { type: 'Never' as never }),
      ).rejects.toMatchObject({
        name: 'ValidationError',
        direction: 'outbound',
      });
      await expect(b.server.send('NOBODY', 'Reset', { type: 'Soft' })).rejects.toBeInstanceOf(
        ConnectionError,
      );
    });

    it('applies timeouts and cancels remote calls via AbortSignal', async () => {
      const { a, b, client } = await nodes();
      const cp = client(a.url);
      const started = vi.fn();
      cp.handle('ClearCache', () => (started(), new Promise(() => {})));
      const announced = once(b.server, 'remote_client_connected');
      await cp.connect();
      await announced;

      await expect(
        b.server.send('CP-1', 'ClearCache', {}, { timeout: 100 }),
      ).rejects.toBeInstanceOf(TimeoutError);

      const controller = new AbortController();
      const pending = b.server.send('CP-1', 'ClearCache', {}, { signal: controller.signal });
      controller.abort(new Error('changed my mind'));
      await expect(pending).rejects.toThrow('changed my mind');
    });

    it('evicts a stale connection when the charge point reconnects to another node', async () => {
      const { a, b, client } = await nodes();
      const first = client(a.url);
      const announced = once(b.server, 'remote_client_connected');
      await first.connect();
      await announced;

      const evicted = once(a.server, 'client_disconnected');
      const second = client(b.url);
      await second.connect();
      const [session, info] = await evicted;
      expect(session.clientId).toBe('CP-1');
      expect(info.reason).toMatch(/Replaced/);

      expect(await a.server.locate('CP-1')).toMatchObject({ nodeId: 'B', local: false });
      second.handle('ClearCache', () => ({ status: 'Accepted' }));
      await expect(a.server.send('CP-1', 'ClearCache', {})).resolves.toEqual({
        status: 'Accepted',
      });
    });

    describe('SOAP (shared session store)', () => {
      async function soapNodes(sessionTimeout = 60_000) {
        const adapter = await createAdapter();
        const namespace = `test:${Math.random().toString(36).slice(2)}`;
        const node = async (nodeId: string, authRequired: boolean) => {
          const server = defer(
            new ocpp16s.Server({
              authRequired,
              sessionTimeout,
              cluster: { adapter, nodeId, namespace },
            }),
          );
          const { port } = await server.listen(0);
          server.handle('Heartbeat', () => ({ currentTime: new Date() }));
          server.handle('BootNotification', () => ({
            status: 'Accepted',
            currentTime: new Date(),
            interval: 60,
          }));
          return { server, url: `http://localhost:${port}/ocpp` };
        };
        // Only A may authorize; B must rely on the shared store.
        return { a: await node('A', false), b: await node('B', true) };
      }

      it('lets any node serve and call a charge point authorized elsewhere', async () => {
        const { a, b } = await soapNodes();
        const connectedA = vi.fn();
        const connectedB = vi.fn();
        a.server.on('client_connected', connectedA);
        b.server.on('client_connected', connectedB);
        const remote = once(b.server, 'remote_client_connected');

        const cp = defer(new ocpp16s.Client({ url: a.url, clientId: 'CP-S', server: {} }));
        cp.handle('RemoteStartTransaction', () => ({ status: 'Accepted' }));
        await cp.connect();
        await cp.send('BootNotification', { chargePointVendor: 'A', chargePointModel: 'B' });
        expect((await remote)[0]).toMatchObject({
          clientId: 'CP-S',
          nodeId: 'A',
          protocol: 'ocpp1.6',
        });

        // B calls the charge point directly, using the endpoint from the store.
        await expect(
          b.server.send('CP-S', 'RemoteStartTransaction', { idTag: 'x' }),
        ).resolves.toEqual({
          status: 'Accepted',
        });
        // The same charge point talking to B is not authorized again.
        const viaB = defer(new ocpp16s.Client({ url: b.url, clientId: 'CP-S' }));
        await viaB.connect();
        await expect(viaB.send('Heartbeat', {})).resolves.toHaveProperty('currentTime');

        expect(connectedA).toHaveBeenCalledTimes(1);
        expect(connectedB).not.toHaveBeenCalled();
        expect(await b.server.clientIds()).toEqual(['CP-S']);
      });

      it('keeps sessions alive while any node sees traffic and reports expiry once', async () => {
        const { a, b } = await soapNodes(400);
        const viaA = defer(new ocpp16s.Client({ url: a.url, clientId: 'CP-T' }));
        const viaB = defer(new ocpp16s.Client({ url: b.url, clientId: 'CP-T' }));
        await Promise.all([viaA.connect(), viaB.connect()]);
        await viaA.send('Heartbeat', {});

        const disconnectedA = vi.fn();
        const disconnectedB = vi.fn();
        a.server.on('client_disconnected', disconnectedA);
        b.server.on('client_disconnected', disconnectedB);
        const remoteGone = once(b.server, 'remote_client_disconnected');

        // Traffic only via B for longer than the timeout: A must not expire the session.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 150));
          await viaB.send('Heartbeat', {});
        }
        expect(disconnectedA).not.toHaveBeenCalled();
        expect(await a.server.isConnected('CP-T')).toBe(true);

        // Silence: the authorizing node reports the disconnect, the other one learns about it.
        const [info, reason] = await remoteGone;
        expect(info).toMatchObject({ clientId: 'CP-T', nodeId: 'A' });
        expect(reason).toBe('Session timeout');
        expect(disconnectedA).toHaveBeenCalledTimes(1);
        expect(disconnectedB).not.toHaveBeenCalled();
        expect(await b.server.isConnected('CP-T')).toBe(false);
      });
    });

    it('ignores sessions of crashed nodes', async () => {
      const { b, adapter, namespace } = await nodes();
      await adapter.set(
        `${namespace}:session:GHOST`,
        JSON.stringify({
          clientId: 'GHOST',
          sessionId: 'x',
          nodeId: 'dead',
          protocol: 'ocpp1.6',
          connectedAt: 0,
          bound: true,
        }),
      );
      expect(await b.server.clientIds()).toEqual([]);
      expect(await b.server.isConnected('GHOST')).toBe(false);
      expect(await adapter.get(`${namespace}:session:GHOST`)).toBeUndefined();
    });
  });
}
