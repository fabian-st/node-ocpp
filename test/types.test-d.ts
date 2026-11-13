import { describe, expectTypeOf, it } from 'vitest';
import { ocpp16, ocpp201 } from '../src/index.js';

declare const cs: ocpp16.Server;
declare const cp: ocpp16.Client;
declare const csms: ocpp201.Server;

describe('type inference', () => {
  it('infers handler payload and response from the action name', () => {
    cs.handle('BootNotification', async (data, ctx) => {
      expectTypeOf(data).toEqualTypeOf<ocpp16.BootNotificationRequest>();
      expectTypeOf(ctx.session).toEqualTypeOf<ocpp16.Session>();
      return { currentTime: new Date(), status: 'Accepted', interval: 120 };
    });

    // @ts-expect-error — 'Maybe' is not a RegistrationStatus
    cs.handle('BootNotification', () => ({
      currentTime: new Date(),
      status: 'Maybe',
      interval: 1,
    }));
    // @ts-expect-error — charge points cannot call RemoteStartTransaction
    cs.handle('RemoteStartTransaction', () => ({ status: 'Accepted' }));
  });

  it('accepts the payload type as explicit generic (example.ts style)', () => {
    cs.handle<ocpp16.BootNotificationRequest>('BootNotification', async (data) => {
      expectTypeOf(data).toEqualTypeOf<ocpp16.BootNotificationRequest>();
      return { currentTime: new Date(), status: 'Accepted', interval: 120 };
    });
    // @ts-expect-error — payload type does not belong to Heartbeat
    cs.handle<ocpp16.BootNotificationRequest>('Heartbeat', () => ({ currentTime: new Date() }));
  });

  it('accepts the action name as explicit generic', () => {
    cs.handle<'Heartbeat'>('Heartbeat', () => ({ currentTime: new Date() }));
  });

  it('types send() in every form', () => {
    expectTypeOf(
      cs.send('CP', 'RemoteStartTransaction', { idTag: 'x' }),
    ).resolves.toEqualTypeOf<ocpp16.RemoteStartTransactionResponse>();
    expectTypeOf(
      cs.send<ocpp16.RemoteStartTransactionRequest>('CP', 'RemoteStartTransaction', { idTag: 'x' }),
    ).resolves.toEqualTypeOf<ocpp16.RemoteStartTransactionResponse>();
    expectTypeOf(cp.send('Heartbeat', {})).resolves.toEqualTypeOf<ocpp16.HeartbeatResponse>();
    expectTypeOf(cp.send('Heartbeat', {}))
      .resolves.toHaveProperty('currentTime')
      .toEqualTypeOf<Date>();

    // @ts-expect-error — missing required idTag
    cs.send('CP', 'RemoteStartTransaction', {});
    // @ts-expect-error — unknown property
    cp.send('Heartbeat', { foo: 1 });
    // @ts-expect-error — clients cannot send Reset
    cp.send('Reset', { type: 'Hard' });
  });

  it('types 2.0.1 likewise', () => {
    csms.handle('BootNotification', (data) => {
      expectTypeOf(data.reason).toEqualTypeOf<ocpp201.BootReasonEnumType>();
      return { currentTime: new Date(), interval: 300, status: 'Accepted' };
    });
    expectTypeOf(
      csms.send('CS', 'RequestStartTransaction', {
        idToken: { idToken: 'x', type: 'ISO14443' },
        remoteStartId: 1,
      }),
    ).resolves.toEqualTypeOf<ocpp201.RequestStartTransactionResponse>();
  });

  it('types OcppError codes per version', () => {
    new ocpp16.OcppError('OccurenceConstraintViolation');
    new ocpp201.OcppError('OccurrenceConstraintViolation');
    // @ts-expect-error — 2.0.1 code, not valid in 1.6
    new ocpp16.OcppError('FormatViolation');
  });
});
