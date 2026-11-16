import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from './errors.js';
import { Money } from './money.js';
import { FailureCode, WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import { WagerTransactionRejected } from './wager-transaction-rejected.js';

const make = (): WagerTransaction =>
  WagerTransaction.create({
    id: 'tx1',
    providerId: 'provider1',
    externalTransactionId: 'ext1',
    idempotencyKey: 'key1',
    payloadHash: 'hash1',
    walletId: 'wallet1',
    playerId: 'player1',
    roundId: 'round1',
    gameId: 'game1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });

describe('WagerTransactionRejected', () => {
  it('rejects events for non-rejected transactions', () => {
    expect(() =>
      WagerTransactionRejected.from(make(), {
        eventId: 'e1',
        correlationId: 'c1',
        at: new Date(),
      }),
    ).toThrow(InvalidTransactionStateError);
  });
  it('serializes stable machine-readable failure codes', () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientFunds);
    const event = WagerTransactionRejected.from(tx, {
      eventId: 'e2',
      correlationId: 'c2',
      causationId: 'command-1',
      at: new Date('2026-01-02T00:00:00.000Z'),
    });
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.toJSON().version).toBe(1);
    expect(event.toJSON().data).toEqual({
      transactionId: 'tx1',
      providerId: 'provider1',
      walletId: 'wallet1',
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(event.toJSON().causationId).toBe('command-1');
  });
});
