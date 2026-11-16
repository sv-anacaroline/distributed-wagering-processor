import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { LedgerDirection } from '../domain/wallet-ledger-entry.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../domain/wager-transaction.js';
import { InvalidTransactionStateError } from '../domain/errors.js';
import { applyWagerRules } from './wager-rules.js';

const at = new Date('2026-11-16T20:00:00.000Z');
const money = (amount = '25.00', currency = 'BRL') => Money.from({ amount, currency });
const wallet = (balance = '100.00') =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: money(balance), at });
const tx = (
  kind: Kind,
  values: Partial<{
    id: string;
    externalTransactionId: string;
    referenceExternalTransactionId: string;
    amount: string;
    roundId: string;
    gameId: string;
    providerId: string;
    currency: string;
  }> = {},
) =>
  WagerTransaction.create({
    id: values.id ?? 'tx1',
    providerId: values.providerId ?? 'provider1',
    externalTransactionId: values.externalTransactionId ?? 'ext1',
    idempotencyKey: 'key1',
    payloadHash: 'hash1',
    walletId: 'w1',
    playerId: 'p1',
    roundId: values.roundId ?? 'round1',
    gameId: values.gameId ?? 'game1',
    kind,
    money: money(values.amount ?? '25.00', values.currency ?? 'BRL'),
    ...(values.referenceExternalTransactionId
      ? { referenceExternalTransactionId: values.referenceExternalTransactionId }
      : {}),
    createdAt: at,
  });
const applied = (
  w: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  hasActiveReversal = false,
) =>
  applyWagerRules({
    wallet: w,
    transaction,
    ...(reference ? { reference } : {}),
    hasActiveReversal,
    ledgerEntryId: 'ledger1',
    at,
  });
const bet = (): WagerTransaction => {
  const original = tx(Kind.Bet, { externalTransactionId: 'bet1', id: 'bet-id' });
  original.markProcessed(undefined, at);
  return original;
};
const reversal = (kind: Kind, amount = '25.00') =>
  tx(kind, {
    id: 'rev-id',
    externalTransactionId: 'reversal1',
    referenceExternalTransactionId: 'bet1',
    amount,
  });

describe('applyWagerRules', () => {
  it('BET debits exactly and produces one ledger', () => {
    const w = wallet();
    const result = applied(w, tx(Kind.Bet));
    expect(result.transaction.status).toBe(Status.Processed);
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('75.00');
    expect(w.version).toBe(2);
  });

  it('BET with insufficient funds is REJECTED without ledger or version change', () => {
    const w = wallet('20.00');
    const result = applied(w, tx(Kind.Bet));
    expect(result.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.transaction.status).toBe(Status.Rejected);
    expect(result.ledgerEntry).toBeUndefined();
    expect(w.version).toBe(1);
    expect(w.balance.toJSON().amount).toBe('20.00');
  });

  it('WIN credits exactly, with or without a resolved BET', () => {
    const w = wallet();
    expect(applied(w, tx(Kind.Win)).ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    const referenced = tx(Kind.Win, {
      id: 'win',
      externalTransactionId: 'win1',
      referenceExternalTransactionId: 'bet1',
    });
    const result = applied(w, referenced, bet());
    expect(result.transaction.referenceTransactionId).toBe('bet-id');
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('150.00');
  });

  it('LOSS marks PROCESSED without ledger, balance or version changes', () => {
    const w = wallet();
    const result = applied(w, tx(Kind.Loss));
    expect(result.transaction.status).toBe(Status.Processed);
    expect(result.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(1);
  });

  it('REFUND credits exactly one processed BET', () => {
    const w = wallet();
    const result = applied(w, reversal(Kind.Refund), bet());
    expect(result.transaction.status).toBe(Status.Processed);
    expect(result.transaction.referenceTransactionId).toBe('bet-id');
    expect(result.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(w.balance.toJSON().amount).toBe('125.00');
  });

  it('ROLLBACK reverses a BET with credit and WIN/REFUND with debit', () => {
    const w = wallet();
    expect(applied(w, reversal(Kind.Rollback), bet()).ledgerEntry?.direction).toBe(
      LedgerDirection.Credit,
    );
    const win = tx(Kind.Win, { id: 'win-id', externalTransactionId: 'win1' });
    win.markProcessed(undefined, at);
    const rollWin = tx(Kind.Rollback, {
      id: 'r-win',
      externalTransactionId: 'rollback-win',
      referenceExternalTransactionId: 'win1',
    });
    expect(applied(w, rollWin, win).ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    const refund = reversal(Kind.Refund);
    refund.markProcessed('bet-id', at);
    const rollRefund = tx(Kind.Rollback, {
      id: 'r-refund',
      externalTransactionId: 'rollback-refund',
      referenceExternalTransactionId: 'reversal1',
    });
    expect(applied(w, rollRefund, refund).ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toJSON().amount).toBe('75.00');
  });

  it('rejects debit reversals with a distinct code and no ledger', () => {
    const w = wallet('10.00');
    const win = tx(Kind.Win, { id: 'win-id', externalTransactionId: 'win1' });
    win.markProcessed(undefined, at);
    const rollWin = tx(Kind.Rollback, {
      id: 'roll-id',
      externalTransactionId: 'roll1',
      referenceExternalTransactionId: 'win1',
    });
    const result = applied(w, rollWin, win);
    expect(result.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(result.ledgerEntry).toBeUndefined();
    expect(w.version).toBe(1);
  });

  it('REFUND must equal the complete original amount', () => {
    const w = wallet();
    const result = applied(w, reversal(Kind.Refund, '24.99'), bet());
    expect(result.transaction.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect(w.version).toBe(1);
  });

  it('forbids REFUND and ROLLBACK crossing the same already-compensated BET', () => {
    const w = wallet();
    const result = applied(w, reversal(Kind.Rollback), bet(), true);
    expect(result.transaction.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(result.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('100.00');
  });

  it('holds an out-of-order reference as PENDING_REFERENCE', () => {
    const w = wallet();
    const result = applied(w, reversal(Kind.Refund));
    expect(result.transaction.status).toBe(Status.PendingReference);
    expect(result.ledgerEntry).toBeUndefined();
    expect(w.version).toBe(1);
  });

  it('holds a reference still pending and rejects a terminal non-processed reference', () => {
    const pending = bet();
    const w = wallet();
    const waiting = tx(Kind.Bet, { id: 'bet-pending', externalTransactionId: 'bet1' });
    expect(applied(w, reversal(Kind.Rollback), waiting).transaction.status).toBe(
      Status.PendingReference,
    );
    expect(pending.status).toBe(Status.Processed);
    const rejected = tx(Kind.Bet, { id: 'bad-bet', externalTransactionId: 'bet1' });
    rejected.reject(FailureCode.InsufficientFunds);
    expect(applied(w, reversal(Kind.Refund), rejected).transaction.failureCode).toBe(
      FailureCode.ReferenceNotProcessed,
    );
  });

  it('rejects reference context mismatches without mutating wallet', () => {
    const w = wallet();
    const bad = bet();
    const otherRound = tx(Kind.Bet, {
      id: 'bet-id',
      externalTransactionId: 'bet1',
      roundId: 'other',
    });
    otherRound.markProcessed(undefined, at);
    expect(applied(w, reversal(Kind.Rollback), otherRound).transaction.failureCode).toBe(
      FailureCode.InvalidReference,
    );
    expect(w.version).toBe(1);
    expect(bad.status).toBe(Status.Processed);
  });

  it('cannot reprocess a terminal transaction', () => {
    const w = wallet();
    const transaction = tx(Kind.Loss);
    applied(w, transaction);
    expect(() => applied(w, transaction)).toThrow(InvalidTransactionStateError);
  });

  it('preserves wallet state when currency differs', () => {
    const w = wallet();
    const result = applied(w, tx(Kind.Bet, { currency: 'USD' }));
    expect(result.transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(w.version).toBe(1);
  });
});

describe('financial invariants — table-driven and reversible sequences', () => {
  it('enforces exact-balance and one-cent boundary cases without rounding', () => {
    const cases: Array<{
      readonly balance: string;
      readonly stake: string;
      readonly expected: string;
      readonly status: Status;
    }> = [
      { balance: '0.00', stake: '0.01', expected: '0.00', status: Status.Rejected },
      { balance: '0.01', stake: '0.01', expected: '0.00', status: Status.Processed },
      { balance: '0.01', stake: '0.02', expected: '0.01', status: Status.Rejected },
      { balance: '10.00', stake: '9.99', expected: '0.01', status: Status.Processed },
      { balance: '10.00', stake: '10.00', expected: '0.00', status: Status.Processed },
      { balance: '10.00', stake: '10.01', expected: '10.00', status: Status.Rejected },
      {
        balance: '999999999999999999.99',
        stake: '0.01',
        expected: '999999999999999999.98',
        status: Status.Processed,
      },
    ];
    for (const item of cases) {
      const w = wallet(item.balance);
      const result = applied(w, tx(Kind.Bet, { amount: item.stake }));
      expect(result.transaction.status).toBe(item.status);
      expect(w.balance.toJSON().amount).toBe(item.expected);
      expect(w.version).toBe(item.status === Status.Processed ? 2 : 1);
      expect(result.ledgerEntry?.isBalanced() ?? true).toBe(true);
      expect(result.ledgerEntry !== undefined).toBe(item.status === Status.Processed);
    }
  });

  it('keeps exact ledger continuity under a debit followed by an equal credit', () => {
    for (const amount of ['0.01', '0.10', '25.00', '80.00', '100.00']) {
      const w = wallet();
      const debit = applied(w, tx(Kind.Bet, { id: 'bet', amount }));
      const credit = applied(
        w,
        tx(Kind.Win, { id: 'win', externalTransactionId: 'win-ext', amount }),
      );
      expect(debit.ledgerEntry?.isBalanced()).toBe(true);
      expect(credit.ledgerEntry?.isBalanced()).toBe(true);
      if (!debit.ledgerEntry || !credit.ledgerEntry) throw new Error('Missing ledger movement');
      expect(debit.ledgerEntry.balanceAfter.equals(credit.ledgerEntry.balanceBefore)).toBe(true);
      expect(w.balance.toJSON().amount).toBe('100.00');
      expect(w.version).toBe(3);
    }
  });

  it('never consumes wallet version for LOSS or a rejected command', () => {
    const w = wallet('0.01');
    for (const index of [1, 2, 3, 4]) {
      const loss = applied(w, tx(Kind.Loss, { id: 'loss-' + index }));
      expect(loss.transaction.status).toBe(Status.Processed);
      expect(loss.ledgerEntry).toBeUndefined();
    }
    const rejected = applied(w, tx(Kind.Bet, { amount: '0.02' }));
    expect(rejected.transaction.status).toBe(Status.Rejected);
    expect(rejected.ledgerEntry).toBeUndefined();
    expect(w.balance.toJSON().amount).toBe('0.01');
    expect(w.version).toBe(1);
  });
});
