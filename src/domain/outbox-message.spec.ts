import { describe, expect, it } from 'bun:test';
import { AlreadyProcessedError, InvalidDomainStateError } from './errors.js';
import { Money } from './money.js';
import { OutboxMessage } from './outbox-message.js';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.js';
import { WagerTransactionProcessed } from './wager-transaction-processed.js';

const date = (day: number): Date => new Date(`2026-01-${day.toString().padStart(2, '0')}T00:00:00.000Z`);
const message = (): OutboxMessage => {
  const transaction = WagerTransaction.create({
    id: 't1', providerId: 'p1', externalTransactionId: 'ext1',
    idempotencyKey: 'key1', payloadHash: 'hash1',
    walletId: 'w1', playerId: 'player1', roundId: 'round1', gameId: 'g1',
    kind: WagerTransactionKind.Bet, money: Money.from({ amount: '25.00', currency: 'BRL' }),
    createdAt: date(1),
  });
  transaction.markProcessed(undefined, date(1));
  const event = WagerTransactionProcessed.from(transaction, {
    eventId: 'event1', correlationId: 'req1', at: date(1),
  });
  return OutboxMessage.enqueue(event);
};

describe('OutboxMessage', () => {
  it('enqueues an immutable event envelope without publishing', () => {
    const outbox = message();
    expect(outbox.id).toBe('event1');
    expect(outbox.aggregateId).toBe('w1');
    expect(outbox.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(date(1))).toBe(true);
    expect(outbox.publishedAt).toBeUndefined();
    expect(outbox.payload.eventType).toBe('WagerTransactionProcessed');
    expect(Object.isFrozen(outbox.payload)).toBe(true);
    expect(Object.isFrozen(outbox.payload.data)).toBe(true);
  });

  it('schedules deterministic exponential backoff and stops being due', () => {
    const outbox = message();
    const now = date(2);
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 1_000);
    expect(outbox.isDue(now)).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 1_000))).toBe(true);
    outbox.scheduleRetry(new Date(now.getTime() + 1_000));
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 3_000);
  });

  it('publishes only once and refuses further retries', () => {
    const outbox = message();
    outbox.scheduleRetry(date(2));
    outbox.markPublished(date(3));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(date(4))).toBe(false);
    expect(outbox.publishedAt?.toISOString()).toBe(date(3).toISOString());
    expect(outbox.nextAttemptAt).toBeUndefined();
    expect(() => outbox.markPublished(date(4))).toThrow(AlreadyProcessedError);
    expect(() => outbox.scheduleRetry(date(4))).toThrow(AlreadyProcessedError);
  });

  it('validates chronological dates before mutating', () => {
    const outbox = message();
    expect(() => outbox.markPublished(new Date('2025-01-01T00:00:00.000Z'))).toThrow(InvalidDomainStateError);
    expect(() => outbox.scheduleRetry(new Date('invalid'))).toThrow(InvalidDomainStateError);
    expect(() => outbox.scheduleRetry(new Date('2025-01-01T00:00:00.000Z'))).toThrow(InvalidDomainStateError);
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
  });

  it('rehydrates state including retry/published information without resetting it', () => {
    const original = message();
    const copy = OutboxMessage.rehydrate({
      id: original.id, aggregateId: original.aggregateId, eventType: original.eventType,
      payload: original.payload, occurredAt: date(1), attempts: 9, nextAttemptAt: date(2),
    });
    expect(copy.attempts).toBe(9);
    expect(copy.isDue(date(1))).toBe(false);
    const sent = OutboxMessage.rehydrate({
      id: original.id, aggregateId: original.aggregateId, eventType: original.eventType,
      payload: original.payload, occurredAt: date(1), attempts: 1, publishedAt: date(2),
    });
    expect(sent.isPending()).toBe(false);
  });

  it('copies Date objects defensively', () => {
    const outbox = message();
    outbox.occurredAt.setUTCFullYear(2040);
    expect(outbox.occurredAt.toISOString()).toBe(date(1).toISOString());
    outbox.scheduleRetry(date(2));
    outbox.nextAttemptAt?.setUTCFullYear(2040);
    expect(outbox.nextAttemptAt?.getUTCFullYear()).toBe(2026);
    outbox.markPublished(date(3));
    outbox.publishedAt?.setUTCFullYear(2040);
    expect(outbox.publishedAt?.getUTCFullYear()).toBe(2026);
  });
});
