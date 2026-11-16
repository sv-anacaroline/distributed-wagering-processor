import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from './errors.js';
import { Money } from './money.js';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import { WagerTransactionProcessed } from './wager-transaction-processed.js';

const makeTransaction = (): WagerTransaction =>
  WagerTransaction.create({
    id: 't1',
    providerId: 'provider',
    externalTransactionId: 'ext1',
    idempotencyKey: 'key1',
    payloadHash: 'hash1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: 'r1',
    gameId: 'g1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '1.20', currency: 'BRL' }),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });

describe('WagerTransactionProcessed', () => {
  it('creates a versioned event only after processing', () => {
    const transaction = makeTransaction();
    const ctx = { eventId: 'e1', correlationId: 'c1', at: new Date('2026-01-02T00:00:00.000Z') };
    expect(() => WagerTransactionProcessed.from(transaction, ctx)).toThrow(
      InvalidTransactionStateError,
    );
    transaction.markProcessed(undefined, ctx.at);
    const event = WagerTransactionProcessed.from(transaction, ctx);
    expect(event.toJSON()).toEqual({
      eventId: 'e1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'w1',
      correlationId: 'c1',
      occurredAt: '2026-01-02T00:00:00.000Z',
      version: 1,
      data: {
        transactionId: 't1',
        providerId: 'provider',
        walletId: 'w1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '1.20', currency: 'BRL' },
      },
    });
  });

  it('includes resolved references without mutating the event', () => {
    const t = WagerTransaction.create({
      id: 'refund1',
      providerId: 'provider',
      externalTransactionId: 'refund-ext',
      idempotencyKey: 'key2',
      payloadHash: 'hash2',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'r1',
      gameId: 'g1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '1.20', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    t.markProcessed('t1', new Date('2026-01-02T00:00:00.000Z'));
    const event = WagerTransactionProcessed.from(t, {
      eventId: 'e2',
      correlationId: 'c2',
      causationId: 'request1',
      at: new Date('2026-01-03T00:00:00.000Z'),
    });
    expect(event.toJSON().causationId).toBe('request1');
    expect(event.toJSON().data.referenceTransactionId).toBe('t1');
    expect(Object.isFrozen(event.data.money)).toBe(true);
  });
});
