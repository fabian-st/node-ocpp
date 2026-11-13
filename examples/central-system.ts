/**
 * OCPP 1.6J central system.
 *   npm run build && node examples/central-system.ts
 */
import { ocpp16j } from 'node-ocpp';

const cs = new ocpp16j.Server({ authRequired: false, logger: console });

// Payload and response types are inferred from the action name…
cs.handle('BootNotification', async (data) => ({
  currentTime: new Date(),
  status: 'Accepted',
  interval: 120,
}));

// …or named explicitly, if you prefer.
cs.handle<ocpp16j.HeartbeatRequest>('Heartbeat', () => ({ currentTime: new Date() }));

cs.on('client_connected', async (session) => {
  const response = await cs.send<ocpp16j.RemoteStartTransactionRequest>(
    session.clientId,
    'RemoteStartTransaction',
    { idTag: '1234567890' },
  );
  console.dir(response);
});

await cs.listen();
