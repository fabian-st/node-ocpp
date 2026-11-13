/**
 * One node of a horizontally scaled central system. Start several instances
 * (e.g. PORT=8080 and PORT=8081) behind a load balancer; no sticky sessions needed.
 *   npm run build && REDIS_URL=redis://localhost:6379 PORT=8080 node examples/cluster.ts
 */
import { Redis } from 'ioredis';
import { ocpp16j } from 'node-ocpp';
import { RedisAdapter } from 'node-ocpp/redis';

const adapter = new RedisAdapter({
  redis: new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
});
const cs = new ocpp16j.Server({ authRequired: false, cluster: { adapter }, logger: console });

cs.handle('BootNotification', () => ({
  currentTime: new Date(),
  status: 'Accepted',
  interval: 60,
}));

cs.on('client_connected', (session) => console.log(`${session.clientId} connected here`));
cs.on('remote_client_connected', (info) =>
  console.log(`${info.clientId} connected to ${info.nodeId}`),
);

// Works on every node, wherever the charge point's WebSocket lives.
setInterval(async () => {
  for (const clientId of await cs.clientIds()) {
    const where = await cs.locate(clientId);
    const result = await cs
      .send(clientId, 'GetConfiguration', { key: ['HeartbeatInterval'] })
      .catch((error: Error) => error.message);
    console.log(clientId, where?.local ? '(local)' : `(via ${where?.nodeId})`, result);
  }
}, 3_000);

await cs.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
process.on('SIGTERM', () => void cs.close().then(() => adapter.close()));
