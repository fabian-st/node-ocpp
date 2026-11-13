# node-ocpp

Typed, schema-validated OCPP client and server components for Node.js (≥ 22).

| Namespace                  | Protocol                            | Transport                                                                | Validated against                              |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| `ocpp16j` (alias `ocpp16`) | OCPP 1.6J                           | JSON over WebSocket ([`ws`](https://github.com/websockets/ws))           | official JSON schemas (draft-04)               |
| `ocpp16s`                  | OCPP 1.6S (+ 1.2/1.5 charge points) | SOAP 1.2 + WS-Addressing ([`soap`](https://github.com/vpulim/node-soap)) | official WSDL/XSD (libxml2 via `xmllint-wasm`) |
| `ocpp201`                  | OCPP 2.0.1                          | JSON over WebSocket                                                      | official JSON schemas (draft-06)               |

Every namespace exposes a `Server` (central system / CSMS) and a `Client` (charge point), all derived
from the same base classes (`OcppServer`, `OcppClient`), plus TypeScript declarations of every
message generated from the official schemas.

```ts
import { ocpp16j } from 'node-ocpp';

const cs = new ocpp16j.Server({ authRequired: false });

// payload + response types are inferred from the action name
cs.handle('BootNotification', async (data) => ({
  currentTime: new Date(), // Dates are converted to/from ISO strings automatically
  status: 'Accepted',
  interval: 120,
}));

cs.on('client_connected', async (session) => {
  const response = await cs.send(session.clientId, 'RemoteStartTransaction', {
    idTag: '1234567890',
  });
  // or: cs.send<ocpp16j.RemoteStartTransactionRequest>(…) / session.send(…)
});

await cs.listen(8080);
```

```ts
const cp = new ocpp16j.Client({ url: 'ws://localhost:8080/ocpp', clientId: 'CP-001' });
cp.handle('RemoteStartTransaction', ({ idTag }) => ({ status: 'Accepted' }));
await cp.connect();
const { interval } = await cp.send('BootNotification', {
  chargePointVendor: 'ACME',
  chargePointModel: 'X',
});
```

More in [`examples/`](examples).

## Imports

```ts
import { ocpp16j, ocpp16s, ocpp201 } from 'node-ocpp'; // everything (`ocpp16` = alias of `ocpp16j`)
import { Server, Client } from 'node-ocpp/ocpp201'; // only what you use (no SOAP stack loaded)
```

## Typing

- `handle(action, handler)` / `send(action, payload)` infer request and response types from the action.
  Only actions the respective side may receive/send are accepted.
- An explicit generic is optional and may be either the action name or the request payload type:
  `send<'Reset'>(…)` or `send<ocpp16j.ResetRequest>(…)`.
- `ocpp16j.OcppError` / `ocpp201.OcppError` only accept the RPC error codes of their version.

## Handlers, middleware, errors

```ts
cs.use(async (ctx, next) => {
  // Koa-style, wraps every inbound call
  const started = Date.now();
  await next(); // ctx.response is set afterwards
  metrics.observe(ctx.action, Date.now() - started);
});

cs.handle('Authorize', ({ idTag }) => {
  if (blocked(idTag)) throw new ocpp16j.OcppError('SecurityError', 'Card blocked'); // → CALLERROR
  return { idTagInfo: { status: 'Accepted' } };
});
```

- One handler per action; registering again replaces it.
- Unknown actions are answered with `NotImplemented`, known but unhandled or disallowed actions
  with `NotSupported`, handler crashes with `InternalError`.
- `send()` rejects with `OcppError` (peer answered with CALLERROR), `ValidationError`,
  `TimeoutError` or `ConnectionError`.
- Outbound calls are queued per connection and sent strictly one at a time, as OCPP-J requires.
  `send(…, { timeout, signal })` accepts a per-call timeout and an `AbortSignal`.

## Validation

`validation: true | false | 'strict' | 'warn' | 'off' | { inbound, outbound }` (default `true` = strict).

- **strict**: invalid inbound calls are answered with the matching RPC error
  (`FormationViolation`/`FormatViolation`, `TypeConstraintViolation`, `PropertyConstraintViolation`,
  `OccurenceConstraintViolation`/`OccurrenceConstraintViolation`); invalid outbound payloads throw
  before anything is sent.
- **warn**: the message is processed and a `validation_error` event is emitted.

SOAP messages are validated as XML against the XSD embedded in the WSDL of their protocol version.

## Server options

| Key                 | Default                                   | Purpose                                                                           |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `port` / `hostname` | `8080` (`80` in production) / `localhost` | used by `listen()`                                                                |
| `route`             | `/ocpp`                                   | clients connect to `<route>/<clientId>` (SOAP: the endpoint path)                 |
| `actionsAllowed`    | all actions                               | actions that may be sent/received, e.g. `[...ocpp16j.profiles.Core]`              |
| `maxConnections`    | `511`                                     | concurrent sessions (OCPP-J)                                                      |
| `sessionTimeout`    | `30000` (SOAP: 15 min)                    | ms without traffic before a session ends                                          |
| `pingInterval`      | `sessionTimeout / 3`                      | WebSocket ping interval, `0` disables (OCPP-J)                                    |
| `authRequired`      | `true`                                    | deny unless a `connection_request` listener accepts                               |
| `authTimeout`       | `10000`                                   | ms to wait for that decision                                                      |
| `basicAuth`         | `true`                                    | pass HTTP Basic passwords to `connection_request` (username must equal client id) |
| `certificateAuth`   | `false`                                   | request TLS client certificates (Security Profile 3; requires `tls`)              |
| `tls`               | –                                         | `https.ServerOptions`; makes `listen()` serve HTTPS/WSS                           |
| `validation`        | `true`                                    | see above                                                                         |
| `callTimeout`       | `30000`                                   | ms to wait for responses to outbound calls                                        |
| `logger`            | silent                                    | anything with `debug/info/warn/error` (console, pino, …)                          |
| `protocols`         | all with WSDL                             | **SOAP only**: accepted versions (`ocpp1.2`, `ocpp1.5`, `ocpp1.6`)                |
| `wsdlDir`           | bundled `schemas/wsdl`                    | **SOAP only**                                                                     |

### Authentication

```ts
cs.on('connection_request', async (request) => {
  // request.clientId, .protocol, .password (Basic auth), .certificate (verified mTLS), .request
  if (await isKnown(request.clientId, request.password)) request.accept();
  else request.reject(401);
});
```

### Several versions on one port

```ts
const http = createServer();
new ocpp16j.Server().attach(http); // WebSocket upgrades are routed by negotiated subprotocol,
new ocpp201.Server().attach(http); // honouring the charge point's order of preference
new ocpp16s.Server({ route: '/soap' }).attach(http);
http.listen(8080);
```

`ocpp16s.Server#handleRequest(req, res)` mounts the SOAP server in Express & co.

### Events

`connection_request`, `client_connected (session)`, `client_disconnected (session, { code, reason })`,
`validation_error (error, session)`.

## Client options (OCPP-J)

`url`, `clientId`, `password` (Basic auth), `tls` (client certificate, CA, …), `headers`,
`reconnect` (`true` or `{ minDelay, maxDelay, factor, jitter, maxAttempts }`),
`offlineQueue` (default `true`: calls made while disconnected are sent after reconnecting),
`pingInterval`, `validation`, `callTimeout`, `actionsAllowed`, `logger`.

Events: `connected`, `disconnected`, `reconnecting`, `validation_error`.

The SOAP client takes `url`, `clientId` and optionally `server: { port, hostname, route, publicUrl }`
to receive calls from the central system (announced via WS-Addressing `From`).

## OCPP-S legacy charge points (1.2 / 1.5)

The SOAP server identifies the version of each request by its XML namespace and validates it against
that version's WSDL (WSDL files are discovered by namespace, file names don't matter). Handlers always
see OCPP 1.6 shapes; the structural differences are translated in both directions
(`heartbeatInterval` ⇄ `interval`, `values` ⇄ `meterValue[].sampledValue[]`, 1.5 `transactionData`,
`localAuthorisationList`, `UnlockStatus`, units `Amp`/`Volt`). Enum values without a 1.6 equivalent
(e.g. status `Occupied`) are passed through, so check `session.protocol` where it matters. Calling an
action the charge point's version does not have rejects with `NotSupported`.

## Generated types

`src/<version>/types.generated.ts` and `meta.generated.ts` are generated from
`schemas/json/<version>` and committed:

```sh
npm run generate
```

The generator (`scripts/generate-types.ts`) de-duplicates the 2.0.1 definitions, names the inline
1.6 types after the specification (`AuthorizationStatus`, `ChargePointStatus`, `KeyValue`, …),
turns `date-time` fields into `Date` and records their paths for runtime conversion.

## Development

```sh
npm test            # vitest (incl. type tests in test/*.test-d.ts)
npm run typecheck
npm run build
```

### Layout

```
src/common/   transport-independent core: base classes, router, codec, validation, RPC framing
src/ws/       OCPP-J transport (server, client, session, upgrade routing)
src/soap/     OCPP-S transport (WSDL registry, XSD validation, responder, caller, legacy adapter)
src/ocpp16j/  OCPP 1.6J  — Server, Client, generated types (also exported as `ocpp16`)
src/ocpp16s/  OCPP 1.6S  — Server, Client (shares the 1.6 types)
src/ocpp201/  OCPP 2.0.1 — Server, Client, generated types
```
