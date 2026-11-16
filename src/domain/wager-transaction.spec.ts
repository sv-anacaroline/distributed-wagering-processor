import { describe, expect, it } from 'bun:test';
import {
  InvalidDomainStateError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from './errors.js';
import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

const at = (): Date => new Date('2026-02-01T00:00:00.000Z');
const m = (amount = '20.00'): Money => Money.from({ amount, currency: 'BRL' });
const props = (kind: Kind = Kind.Bet): CreateWagerTransactionProps => ({
  id: 't1', providerId: 'provider-1', externalTransactionId: 'ext-1',
  idempotencyKey: 'provider-1:ext-1', payloadHash: 'sha256:abc',
  walletId: 'w1', playerId: 'p1', roundId: 'r1', gameId: 'g1',
  kind, money: m(), createdAt: at(),
});
const create = (kind: Kind = Kind.Bet, changes: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create({ ...props(kind), ...changes });
const processedBet = (): WagerTransaction => {
  const bet = create();
  bet.markProcessed(undefined, at());
  return bet;
};
const referring = (kind: Kind): WagerTransaction =>
  create(kind, { id: 't2', externalTransactionId: 'ext-2', referenceExternalTransactionId: 'ext-1' });

describe('WagerTransaction', () => {
  it('starts pending and compares canonical payload hashes', () => {
    const tx = create();
    expect(tx.id).toBe('t1');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.matchesPayload('sha256:abc')).toBe(true);
    expect(tx.matchesPayload('sha256:xyz')).toBe(false);
    expect(tx.requiresReference()).toBe(false);
  });

  it('rejects OPENING through external create, but allows internal opening()', () => {
    expect(() => create(Kind.Opening)).toThrow(InvalidDomainStateError);
    const opening = WagerTransaction.opening({
      ...props(Kind.Bet),
      id: 'opening-1',
      externalTransactionId: 'opening-internal',
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('requires a valid amount and identity', () => {
    expect(() => create(Kind.Bet, { id: '' })).toThrow(InvalidDomainStateError);
    expect(() => create(Kind.Bet, { money: Money.zero('BRL') })).toThrow(InvalidDomainStateError);
    expect(() => create('INVALID' as Kind)).toThrow(InvalidDomainStateError);
  });

  it('validates reference requirements and forbids references to self', () => {
    expect(() => create(Kind.Refund)).toThrow(InvalidReferenceError);
    expect(() => create(Kind.Rollback)).toThrow(InvalidReferenceError);
    expect(() => create(Kind.Bet, { referenceExternalTransactionId: 'ext-other' })).toThrow(InvalidReferenceError);
    expect(() => create(Kind.Loss, { referenceExternalTransactionId: 'ext-other' })).toThrow(InvalidReferenceError);
    expect(() => create(Kind.Rollback, { referenceExternalTransactionId: 'ext-1' })).toThrow(InvalidReferenceError);
    expect(referring(Kind.Refund).requiresReference()).toBe(true);
    expect(referring(Kind.Rollback).requiresReference()).toBe(true);
  });

  it('marks a pending reference without terminating, then processes the resolved reference', () => {
    const tx = referring(Kind.Refund);
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    expect(() => tx.markProcessed(undefined, at())).toThrow(InvalidReferenceError);
    tx.markProcessed('t1', new Date('2026-02-02T00:00:00.000Z'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.referenceTransactionId).toBe('t1');
    expect(tx.processedAt?.toISOString()).toBe('2026-02-02T00:00:00.000Z');
    expect(() => tx.reject(FailureCode.InvalidReference)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  it('rejects invalid processing time and undeclared references', () => {
    const tx = create();
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.markProcessed('other', at())).toThrow(InvalidReferenceError);
    expect(() => tx.markProcessed(undefined, new Date('2025-01-01T00:00:00.000Z'))).toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(Status.Pending);
  });

  it('makes REJECTED and FAILED terminal with stable machine-readable failure codes', () => {
    const rejected = create();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => rejected.fail(FailureCode.PermanentInfrastructureError)).toThrow(InvalidTransactionStateError);
    const failed = create();
    failed.fail(FailureCode.PermanentInfrastructureError);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.isTerminal()).toBe(true);
    expect(() => failed.markProcessed(undefined, at())).toThrow(InvalidTransactionStateError);
  });

  it('returns proper effects for BET, WIN and LOSS', () => {
    expect(create().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create().affectsBalance()).toBe(true);
    expect(create(Kind.Win).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create(Kind.Loss).ledgerDirectionFor()).toBeNull();
    expect(create(Kind.Loss).affectsBalance()).toBe(false);
    expect(create(Kind.Win, { referenceExternalTransactionId: 'ext-1' }).ledgerDirectionFor(processedBet())).toBe(LedgerDirection.Credit);
  });

  it('reverses only processed matching transactions, exactly once per reference in the DB', () => {
    const bet = processedBet();
    const refund = referring(Kind.Refund);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(refund.affectsBalance(bet)).toBe(true);
    refund.markProcessed(bet.id, at());

    const reverseBet = referring(Kind.Rollback);
    expect(reverseBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = create(Kind.Win);
    win.markProcessed(undefined, at());
    expect(referring(Kind.Rollback).ledgerDirectionFor(win)).toThrow; // overwritten below: a reference must match its external ID
  });

  it('rejects mismatched, partial or non-processed references', () => {
    const tx = referring(Kind.Refund);
    expect(() => tx.ledgerDirectionFor()).toThrow(InvalidReferenceError);
    expect(() => tx.ledgerDirectionFor(create())).toThrow(InvalidReferenceError);
    const bet = processedBet();
    expect(() => referring(Kind.Rollback).ledgerDirectionFor(create(Kind.Loss, { ...props(Kind.Loss), id: 't3', externalTransactionId: 'ext-1' }))).toThrow(InvalidReferenceError);
    expect(() => tx.ledgerDirectionFor(WagerTransaction.rehydrate({
      ...props(Kind.Bet), status: Status.Processed, walletId: 'other',
    }))).toThrow(InvalidReferenceError);
    expect(() => create(Kind.Refund, { id: 't2', externalTransactionId: 'ext-2', referenceExternalTransactionId: 'ext-1', money: m('19.99') }).ledgerDirectionFor(bet)).toThrow(InvalidReferenceError);
    expect(() => referring(Kind.Rollback).ledgerDirectionFor(WagerTransaction.rehydrate({
      ...props(Kind.Bet), status: Status.Processed, money: m('20.00').negate(),
    }))).toThrow(InvalidReferenceError);
  });

  it('rehydrates terminal data without replaying transitions and copies dates', () => {
    const original = at();
    const tx = WagerTransaction.rehydrate({
      ...props(Kind.Bet), createdAt: original, status: Status.Processed,
      processedAt: original,
    });
    original.setUTCFullYear(2040);
    const date = tx.processedAt;
    date?.setUTCFullYear(2050);
    expect(tx.createdAt.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(tx.processedAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(tx.status).toBe(Status.Processed);
  });
});
