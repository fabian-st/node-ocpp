/**
 * OCPP 1.6J, 2.0.1 and 1.6S (SOAP) served from one HTTPS port.
 * WebSocket upgrades are routed by negotiated subprotocol; SOAP by path.
 *   npm run build && node examples/multi-version.ts
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { ocpp16j, ocpp16s, ocpp201 } from 'node-ocpp';

const https = createServer({
  key: readFileSync('certs/server.key'),
  cert: readFileSync('certs/server.crt'),
});

const v16 = new ocpp16j.Server({
  actionsAllowed: [...ocpp16j.profiles.Core, ...ocpp16j.profiles.SmartCharging],
});
const v201 = new ocpp201.Server({ validation: { inbound: 'warn', outbound: 'strict' } });
const soap = new ocpp16s.Server({ route: '/soap' });

for (const server of [v16, v201, soap]) {
  server.attach(https);
  // Authentication: accept known charge points only.
  server.on('connection_request', async (request) => {
    const ok = await checkCredentials(request.clientId, request.password);
    if (ok) request.accept();
    else request.reject(401);
  });
}

// One handler serves 1.6J and 1.6S (and 1.2/1.5 SOAP) charge points alike.
const heartbeat = () => ({ currentTime: new Date() });
v16.handle('Heartbeat', heartbeat);
soap.handle('Heartbeat', heartbeat);
v201.handle('Heartbeat', heartbeat);

v201.on('validation_error', (error, session) => console.warn(session.clientId, error.message));

https.listen(443);

async function checkCredentials(clientId: string, password: string | undefined) {
  return clientId.startsWith('CP-') && password === process.env.OCPP_PASSWORD;
}
