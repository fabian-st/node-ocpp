import { describe, expect, it } from 'vitest';
import { OcppError, ocpp16s } from '../src/index.js';
import { defer, once } from './helpers.js';

async function setup(
  serverOptions: ocpp16s.ServerOptions = {},
  clientOptions: Partial<ocpp16s.ClientOptions> = {},
) {
  const server = defer(new ocpp16s.Server({ authRequired: false, ...serverOptions }));
  const { port } = await server.listen(0);
  const url = `http://localhost:${port}/ocpp`;
  const client = defer(new ocpp16s.Client({ url, clientId: 'CP-S', ...clientOptions }));
  return { server, client, url };
}

const envelope = (body: string, identity = '<o:chargeBoxIdentity>RAW</o:chargeBoxIdentity>') =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ` +
  `xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:o="urn://Ocpp/Cs/2015/10/">` +
  `<s:Header>${identity}<a:Action>/X</a:Action><a:MessageID>urn:uuid:1</a:MessageID></s:Header>` +
  `<s:Body>${body}</s:Body></s:Envelope>`;

const post = (url: string, xml: string) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/soap+xml' }, body: xml });

describe('ocpp16s (SOAP)', () => {
  it('round-trips a call validated against the official WSDL', async () => {
    const { server, client } = await setup();
    const now = new Date('2026-03-01T10:00:00.000Z');
    server.handle('BootNotification', (payload, { session }) => {
      expect(payload).toEqual({ chargePointVendor: 'ACME', chargePointModel: 'S1' });
      expect(session.clientId).toBe('CP-S');
      expect(session.protocol).toBe('ocpp1.6');
      return { status: 'Accepted', currentTime: now, interval: 300 };
    });
    const connected = once(server, 'client_connected');
    await client.connect();
    const response = await client.send('BootNotification', {
      chargePointVendor: 'ACME',
      chargePointModel: 'S1',
    });
    expect(response).toEqual({ status: 'Accepted', currentTime: now, interval: 300 });
    await connected;
  });

  it('converts numbers, arrays and nested dates', async () => {
    const { server, client } = await setup();
    let received: ocpp16s.MeterValuesRequest | undefined;
    server.handle('MeterValues', (payload) => ((received = payload), {}));
    await client.connect();
    const timestamp = new Date('2026-03-01T10:00:00.000Z');
    await client.send('MeterValues', {
      connectorId: 1,
      transactionId: 7,
      meterValue: [{ timestamp, sampledValue: [{ value: '12.5', unit: 'kWh' }] }],
    });
    expect(received).toEqual({
      connectorId: 1,
      transactionId: 7,
      meterValue: [{ timestamp, sampledValue: [{ value: '12.5', unit: 'kWh' }] }],
    });
  });

  it('rejects invalid outbound payloads via XSD before sending', async () => {
    const { client } = await setup();
    await client.connect();
    await expect(
      client.send('StatusNotification', {
        connectorId: 1,
        errorCode: 'NoError',
        status: 'Exploded' as never,
      }),
    ).rejects.toMatchObject({ name: 'ValidationError', direction: 'outbound' });
  });

  it('answers XSD violations with SOAP faults carrying OCPP error codes', async () => {
    const { server, url } = await setup();
    server.handle('Heartbeat', () => ({ currentTime: new Date() }));

    const bad = await post(
      url,
      envelope('<o:authorizeRequest><o:idTag>x</o:idTag><o:foo/></o:authorizeRequest>'),
    );
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/Subcode><soap:Value[^>]*>ocpp:FormationViolation</);

    const type = await post(
      url,
      envelope('<o:meterValuesRequest><o:connectorId>one</o:connectorId></o:meterValuesRequest>'),
    );
    expect(await type.text()).toMatch(/TypeConstraintViolation/);

    const ok = await post(url, envelope('<o:heartbeatRequest/>'));
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body).toMatch(/<heartbeatResponse xmlns="urn:\/\/Ocpp\/Cs\/2015\/10\/"><currentTime>/);
    expect(body).toMatch(/RelatesTo[^>]*>urn:uuid:1</);
  });

  it('requires the chargeBoxIdentity header', async () => {
    const { url } = await setup();
    const res = await post(url, envelope('<o:heartbeatRequest/>', ''));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Missing chargeBoxIdentity/);
  });

  it('maps handler errors and missing handlers to faults', async () => {
    const { server, client } = await setup();
    server.handle('Authorize', () => {
      throw new ocpp16s.OcppError('SecurityError', 'Blocked card');
    });
    await client.connect();
    await expect(client.send('Authorize', { idTag: 'x' })).rejects.toMatchObject({
      code: 'SecurityError',
      message: 'Blocked card',
    });
    await expect(client.send('Heartbeat', {})).rejects.toBeInstanceOf(OcppError);
  });

  it('authorizes charge points via connection_request', async () => {
    const { server, client } = await setup({ authRequired: true });
    await client.connect();
    await expect(client.send('Heartbeat', {})).rejects.toMatchObject({ code: 'SecurityError' });

    server.on('connection_request', (request) => {
      expect(request.protocol).toBe('ocpp1.6');
      request.accept();
    });
    server.handle('Heartbeat', () => ({ currentTime: new Date() }));
    await expect(client.send('Heartbeat', {})).resolves.toHaveProperty('currentTime');
  });

  it('accepts OCPP 1.5 charge points with the same handlers', async () => {
    const { server, url } = await setup();
    server.handle('BootNotification', (payload, { session }) => {
      expect(session.protocol).toBe('ocpp1.5');
      expect(payload.chargePointVendor).toBe('Legacy');
      return { status: 'Accepted', currentTime: new Date('2026-01-01T00:00:00Z'), interval: 60 };
    });
    const res = await post(
      url,
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:o="urn://Ocpp/Cs/2012/06/">` +
        `<s:Header><o:chargeBoxIdentity>OLD</o:chargeBoxIdentity><a:MessageID>urn:uuid:2</a:MessageID><a:From><a:Address>http://old-cp:8080/</a:Address></a:From></s:Header>` +
        `<s:Body><o:bootNotificationRequest><o:chargePointVendor>Legacy</o:chargePointVendor><o:chargePointModel>M</o:chargePointModel></o:bootNotificationRequest></s:Body></s:Envelope>`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<bootNotificationResponse xmlns="urn://Ocpp/Cs/2012/06/">');

    const session = server.sessions.get('OLD')!;
    expect(session.protocol).toBe('ocpp1.5');
    expect(session.endpoint).toBe('http://old-cp:8080/');
    // TriggerMessage does not exist in OCPP 1.5:
    await expect(
      session.send('TriggerMessage', { requestedMessage: 'Heartbeat' }),
    ).rejects.toMatchObject({
      code: 'NotSupported',
    });
  });

  it('translates OCPP 1.5 meter values into 1.6 shapes', async () => {
    const { server, url } = await setup();
    let received: ocpp16s.MeterValuesRequest | undefined;
    server.handle('MeterValues', (payload) => ((received = payload), {}));
    const res = await post(
      url,
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:o="urn://Ocpp/Cs/2012/06/">` +
        `<s:Header><o:chargeBoxIdentity>OLD</o:chargeBoxIdentity></s:Header><s:Body><o:meterValuesRequest><o:connectorId>1</o:connectorId>` +
        `<o:values><o:timestamp>2026-01-01T00:00:00Z</o:timestamp><o:value unit="Amp" measurand="Current.Import">16</o:value><o:value>1200</o:value></o:values>` +
        `</o:meterValuesRequest></s:Body></s:Envelope>`,
    );
    expect(res.status).toBe(200);
    expect(received).toEqual({
      connectorId: 1,
      meterValue: [
        {
          timestamp: new Date('2026-01-01T00:00:00Z'),
          sampledValue: [
            { value: '16', unit: 'A', measurand: 'Current.Import' },
            { value: '1200' },
          ],
        },
      ],
    });
  });

  it('restricts accepted versions via `protocols`', async () => {
    const { url } = await setup({ protocols: ['ocpp1.6'] });
    const res = await post(
      url,
      envelope('<o:heartbeatRequest/>').replaceAll(
        'urn://Ocpp/Cs/2015/10/',
        'urn://Ocpp/Cs/2012/06/',
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Unsupported message namespace/);
  });

  it('serves the WSDL', async () => {
    const { url } = await setup();
    const res = await fetch(`${url}?wsdl`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('CentralSystemService');
  });

  it('calls the charge point back via its announced endpoint', async () => {
    const { server, client } = await setup({}, { server: {} });
    server.handle('BootNotification', () => ({
      status: 'Accepted',
      currentTime: new Date(),
      interval: 60,
    }));
    client.handle('RemoteStartTransaction', ({ idTag }) => ({
      status: idTag ? 'Accepted' : 'Rejected',
    }));
    await client.connect();
    await client.send('BootNotification', { chargePointVendor: 'A', chargePointModel: 'B' });

    const session = server.sessions.get('CP-S')!;
    expect(session.endpoint).toBe(client.publicUrl);
    await expect(server.send('CP-S', 'RemoteStartTransaction', { idTag: 'abc' })).resolves.toEqual({
      status: 'Accepted',
    });
  });
});
