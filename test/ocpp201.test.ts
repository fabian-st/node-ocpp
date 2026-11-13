import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ocpp16, ocpp201 } from '../src/index.js';
import { defer, once } from './helpers.js';

describe('ocpp201', () => {
  it('round-trips nested payloads with dates in arrays', async () => {
    const server = defer(new ocpp201.Server({ authRequired: false }));
    const { port } = await server.listen(0);
    const client = defer(
      new ocpp201.Client({ url: `ws://localhost:${port}/ocpp`, clientId: 'CS-1' }),
    );

    let received: ocpp201.MeterValuesRequest | undefined;
    server.handle('MeterValues', (payload) => {
      received = payload;
      return {};
    });
    await client.connect();
    const timestamp = new Date('2026-05-01T08:00:00.000Z');
    await client.send('MeterValues', {
      evseId: 1,
      meterValue: [{ timestamp, sampledValue: [{ value: 42.5 }] }],
    });
    expect(received?.meterValue[0]?.timestamp).toEqual(timestamp);
  });

  it('uses 2.0.1 error codes', async () => {
    const server = defer(new ocpp201.Server({ authRequired: false }));
    const { port } = await server.listen(0);
    server.handle('Heartbeat', () => ({ currentTime: new Date() }));
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://localhost:${port}/ocpp/RAW`, ['ocpp2.0.1']);
    await once(ws, 'open');
    ws.send(JSON.stringify([2, 'a', 'Heartbeat', { unexpected: 1 }]));
    expect(JSON.parse(String((await once(ws, 'message'))[0])).slice(0, 3)).toEqual([
      4,
      'a',
      'FormatViolation',
    ]);
    ws.send('not json');
    expect(JSON.parse(String((await once(ws, 'message'))[0])).slice(0, 3)).toEqual([
      4,
      '-1',
      'RpcFrameworkError',
    ]);
    ws.send(JSON.stringify([5, 'b']));
    expect(JSON.parse(String((await once(ws, 'message'))[0])).slice(0, 3)).toEqual([
      4,
      'b',
      'MessageTypeNotSupported',
    ]);
    ws.close();
  });

  it('shares one HTTP server with ocpp16, routed by subprotocol preference', async () => {
    const http = createServer();
    await new Promise<void>((r) => http.listen(0, r));
    defer({ close: () => new Promise((r) => http.close(r)) });
    const { port } = http.address() as AddressInfo;

    const v16 = defer(new ocpp16.Server({ authRequired: false }).attach(http));
    const v201 = defer(new ocpp201.Server({ authRequired: false }).attach(http));
    v16.handle('Heartbeat', () => ({ currentTime: new Date(0) }));
    v201.handle('Heartbeat', () => ({ currentTime: new Date(1) }));

    const a = defer(new ocpp16.Client({ url: `ws://localhost:${port}/ocpp`, clientId: 'A' }));
    const b = defer(new ocpp201.Client({ url: `ws://localhost:${port}/ocpp`, clientId: 'B' }));
    await Promise.all([a.connect(), b.connect()]);

    expect((await a.send('Heartbeat', {})).currentTime).toEqual(new Date(0));
    expect((await b.send('Heartbeat', {})).currentTime).toEqual(new Date(1));
    expect([...v16.sessions.keys()]).toEqual(['A']);
    expect([...v201.sessions.keys()]).toEqual(['B']);
  });
});
