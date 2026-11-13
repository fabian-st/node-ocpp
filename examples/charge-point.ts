/**
 * OCPP 1.6J charge point with auto-reconnect and offline queueing.
 *   npm run build && node examples/charge-point.ts
 */
import { ocpp16j } from 'node-ocpp';

const cp = new ocpp16j.Client({
  url: 'ws://localhost:8080/ocpp',
  clientId: 'CP-001',
  password: process.env.OCPP_PASSWORD, // HTTP Basic auth (Security Profile 1/2)
  reconnect: { minDelay: 1_000, maxDelay: 30_000 },
  logger: console,
});

cp.handle('RemoteStartTransaction', ({ idTag, connectorId }) => {
  console.log(`Remote start for ${idTag} on connector ${connectorId ?? 'any'}`);
  return { status: 'Accepted' };
});

cp.handle('Reset', ({ type }) => {
  if (type === 'Hard') throw new ocpp16j.OcppError('NotSupported', 'Hard reset unavailable');
  return { status: 'Accepted' };
});

cp.on('reconnecting', ({ attempt, delay }) => console.log(`reconnect #${attempt} in ${delay} ms`));

await cp.connect();
const { interval } = await cp.send('BootNotification', {
  chargePointVendor: 'ACME',
  chargePointModel: 'Example',
});

setInterval(() => void cp.send('Heartbeat', {}).catch(console.error), interval * 1000);
