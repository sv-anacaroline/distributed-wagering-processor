import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidDomainStateError,
  InvalidLedgerEntryError,
} from './errors.js';
import { Money } from './money.js';
import { LedgerDirection, WalletLedgerEntry, type LedgerEntryState } from './wallet-ledger-entry.js';

const m = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const base = (): LedgerEntryState => ({
  id: 'l1',
  walletId: 'w1',
  transactionId: 't1',
  direction: LedgerDirection.Debit,
  money: m('80.00'),
  balanceBefore: m('100.00'),
  balanceAfter: m('20.00'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
});

describe('WalletLedgerEntry', () => {
  it('creates an exact debit entry', () => {
    const entry = WalletLedgerEntry.create(base());
    expect(entry.id).toBe('l1');
    expect(entry.walletId).toBe('w1');
    expect(entry.transactionId).toBe('t1');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);
  });

  it('creates an exact credit entry', () => {
    const entry = WalletLedgerEntry.create({
      ...base(),
      direction: LedgerDirection.Credit,
      balanceAfter: m('180.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects incorrect arithmetic and negative balances', () => {
    expect(() => WalletLedgerEntry.create({ ...base(), balanceAfter: m('19.99') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create({ ...base(), balanceBefore: m('20.00'), balanceAfter: m('0.00') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base(), balanceAfter: m('0.00').subtract(m('1.00')) })).toThrow(InvalidLedgerEntryError);
  });

  it('requires a positive amount and known direction', () => {
    expect(() => WalletLedgerEntry.create({ ...base(), money: Money.zero('BRL') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() => WalletLedgerEntry.create({ ...base(), direction: 'OTHER' as LedgerDirection })).toThrow(
      InvalidLedgerEntryError,
    );
  });

  it('rejects inconsistent currencies and missing identifiers', () => {
    expect(() => WalletLedgerEntry.create({ ...base(), balanceAfter: m('20.00', 'USD') })).toThrow(CurrencyMismatchError);
    expect(() => WalletLedgerEntry.create({ ...base(), id: '' })).toThrow(InvalidDomainStateError);
    expect(() => WalletLedgerEntry.create({ ...base(), walletId: '' })).toThrow(InvalidDomainStateError);
    expect(() => WalletLedgerEntry.create({ ...base(), transactionId: '' })).toThrow(InvalidDomainStateError);
  });

  it('copies timestamps defensively', () => {
    const state = base();
    const entry = WalletLedgerEntry.create(state);
    state.createdAt.setFullYear(2030);
    const leaked = entry.createdAt;
    leaked.setFullYear(2040);
    expect(entry.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rehydrates historical state without applying transitions', () => {
    const historical = WalletLedgerEntry.rehydrate({ ...base(), balanceAfter: m('99.00') });
    expect(historical.isBalanced()).toBe(false);
    expect(historical.money.toJSON().amount).toBe('80.00');
  });
});
