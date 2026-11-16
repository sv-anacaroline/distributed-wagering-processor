import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from './errors.js';
import { Money } from './money.js';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference.js';

const tx = (): WagerTransaction =>
  WagerTransaction.create({
    id: 'tx-r', providerId: 'provider1', externalTransactionId: 'refund1',
    idempotencyKey: 'key-r', payloadHash: 'hash-r', walletId: 'w1',
    playerId: 'p1', roundId: 'r1', gameId: 'g1',
    kind: WagerTransactionKind.Refund,
    money: Money.from({ amount: '20.00', currency: 'BRL' }),
    referenceExternalTransactionId: 'original-bet',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
const ctx = () => ({ eventId: 'event-r', correlationId: 'command-r', at: new Date('2026-01-02T00:00:00.000Z') });

describe('WagerTransactionPendingReference', () => {
  it('rejects events for transactions not awaiting a reference', () => {
    expect(() => WagerTransactionPendingReference.from(tx(), ctx())).toThrow(
      InvalidTransactionStateError,
    );
  });
  it('serializes the unresolved external reference and metadata', () => {
    const transaction = tx();
    transaction.markPendingReference();
    const event = WagerTransactionPendingReference.from(transaction, ctx());
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.toJSON().version).toBe(1);
    expect(event.toJSON().occurredAt).toBe('2026-01-02T00:00:00.000Z');
    expect(event.toJSON().data).toEqual({
      transactionId: 'tx-r',
      providerId: 'provider1',
      walletId: 'w1',
      referenceExternalTransactionId: 'original-bet',
    });
  });
});
