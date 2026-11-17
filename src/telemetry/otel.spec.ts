import { describe, expect, it } from 'bun:test';
import {
  currentTraceparent,
  parseTraceparent,
  sanitizedAttributes,
  startSpan,
  withSpan,
} from './otel.js';

describe('W3C trace context and privacy invariants', () => {
  it('creates valid IDs and rejects zeroed or malformed parents', () => {
    const root = startSpan('http.request');
    const parent = root.run(() => currentTraceparent());
    expect(parent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(parseTraceparent(parent)?.traceId).toBe(parent?.split('-')[1]);
    expect(parseTraceparent('00-' + '0'.repeat(32) + '-' + '1'.repeat(16) + '-01')).toBeNull();
    expect(parseTraceparent('00-' + '1'.repeat(32) + '-' + '0'.repeat(16) + '-01')).toBeNull();
    expect(parseTraceparent('untrusted')).toBeNull();
    root.end();
  });

  it('preserves trace IDs across nested asynchronous operations', async () => {
    const root = startSpan('sqs.wager.consume');
    await root.run(async () => {
      const outer = currentTraceparent();
      const inner = await withSpan('postgres.financial.transaction', {}, async () => {
        await Promise.resolve();
        return currentTraceparent();
      });
      expect(outer?.split('-')[1]).toBe(inner?.split('-')[1]);
      expect(outer?.split('-')[2]).not.toBe(inner?.split('-')[2]);
    });
    root.end();
  });

  it('continues persisted Outbox context after the original span ended', async () => {
    const source = startSpan('wager.process');
    const parent = source.run(() => currentTraceparent());
    source.end();
    const published = await withSpan(
      'outbox.publish',
      { event_type: 'WalletBalanceChanged' },
      () => Promise.resolve(currentTraceparent()),
      parent,
    );
    expect(published?.split('-')[1]).toBe(parent?.split('-')[1]);
    expect(published?.split('-')[2]).not.toBe(parent?.split('-')[2]);
  });

  it('redacts credentials and financial fields from exported attributes', () => {
    const values = sanitizedAttributes({
      authorization: 'Bearer fake-token',
      'auth.api_key': 'secret',
      'wallet.balance': '99.00',
      money: '99.00',
      'request.payload': 'private',
      event_id: 'event-1',
      route: '/wallets/:walletId',
      status: 200,
    });
    expect(Object.keys(values).sort()).toEqual(['event_id', 'route', 'status']);
  });
});
