import { describe, expect, it } from 'bun:test';
import { InvalidDomainStateError } from './errors.js';
import { Money } from './money.js';
import { Wallet } from './wallet.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';
import { WalletBalanceChanged } from './wallet-balance-changed.js';

const m = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const at = (): Date => new Date('2026-01-01T00:00:00.000Z');
const wallet = (): Wallet => Wallet.open({
  id: 'w1', playerId: 'p1', initialBalance: m('100.00'), at: at(),
});
const ctx = () => ({
  eventId: 'event-1',
  correlationId: 'correlation-1',
  causationId: 'command-1',
  at: new Date('2026-01-02T00:00:00.000Z'),
});

describe('WalletBalanceChanged', () => {
  it('creates an event from a verified ledger entry and changed wallet', () => {
    const w = wallet();
    const entry = w.debit({
      ledgerEntryId: 'ledger-1', transactionId: 'bet-1', money: m('80.00'), at: ctx().at,
    });
    const event = WalletBalanceChanged.from(w, entry, ctx());
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.toJSON().version).toBe(1);
    expect(event.toJSON().aggregateId).toBe('w1');
    expect(event.toJSON().data).toEqual({
      walletId: 'w1',
      transactionId: 'bet-1',
      direction: LedgerDirection.Debit,
      money: { amount: '80.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '20.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(Object.isFrozen(event.data.balanceAfter)).toBe(true);
  });

  it('rejects an unrelated or stale ledger record', () => {
    const w = wallet();
    const unrelated = WalletLedgerEntry.create({
      id: 'l-other', walletId: 'w-other', transactionId: 't1',
      direction: LedgerDirection.Credit, money: m('1.00'),
      balanceBefore: m('100.00'), balanceAfter: m('101.00'), createdAt: ctx().at,
    });
    expect(() => WalletBalanceChanged.from(w, unrelated, ctx())).toThrow(InvalidDomainStateError);
    const proper = w.credit({
      ledgerEntryId: 'l1', transactionId: 't1', money: m('1.00'), at: ctx().at,
    });
    w.credit({
      ledgerEntryId: 'l2', transactionId: 't2', money: m('1.00'), at: ctx().at,
    });
    expect(() => WalletBalanceChanged.from(w, proper, ctx())).toThrow(InvalidDomainStateError);
  });
});
