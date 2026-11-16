import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainStateError,
} from './errors.js';
import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import { Wallet } from './wallet.js';

const at = (): Date => new Date('2026-01-01T00:00:00.000Z');
const m = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });
const open = (initialBalance = m('100.00')): Wallet =>
  Wallet.open({ id: 'w1', playerId: 'p1', initialBalance, at: at() });
const movement = (amount: string) => ({
  ledgerEntryId: 'l1',
  transactionId: 't1',
  money: m(amount),
  at: new Date('2026-01-02T00:00:00.000Z'),
});

describe('Wallet', () => {
  it('opens with version 1, a nonnegative balance and defensive timestamp', () => {
    const timestamp = at();
    const wallet = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: m('10.00'), at: timestamp });
    expect(wallet.id).toBe('w1');
    expect(wallet.playerId).toBe('p1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    timestamp.setUTCFullYear(2030);
    const leaked = wallet.createdAt;
    leaked.setUTCFullYear(2040);
    expect(wallet.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(wallet.updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(open(Money.zero('BRL')).balance.isZero()).toBe(true);
  });

  it('rejects invalid opening state', () => {
    expect(() => open(m('0.00').subtract(m('1.00')))).toThrow(InvalidDomainStateError);
    expect(() => Wallet.open({ id: '', playerId: 'p1', initialBalance: m('1.00'), at: at() })).toThrow(InvalidDomainStateError);
    expect(() => Wallet.open({ id: 'w1', playerId: '', initialBalance: m('1.00'), at: at() })).toThrow(InvalidDomainStateError);
  });

  it('debits and returns an exact ledger entry, increasing version once', () => {
    const wallet = open();
    const entry = wallet.debit(movement('80.00'));
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('credits and returns an exact ledger entry', () => {
    const wallet = open();
    const entry = wallet.credit(movement('25.00'));
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toJSON().amount).toBe('125.00');
    expect(wallet.balance.toJSON().amount).toBe('125.00');
    expect(wallet.version).toBe(2);
  });

  it('rejects insufficient funds without changing balance or version', () => {
    const wallet = open();
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('rejects zero and negative movements and currency conflicts', () => {
    const wallet = open();
    expect(() => wallet.credit(movement('0.00'))).toThrow(InvalidDomainStateError);
    expect(() => wallet.debit({ ...movement('1.00'), money: m('0.00').subtract(m('1.00')) })).toThrow(InvalidDomainStateError);
    expect(() => wallet.credit({ ...movement('1.00'), money: m('1.00', 'USD') })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  it('rejects a malformed ledger movement atomically in memory', () => {
    const wallet = open();
    expect(() => wallet.credit({ ...movement('1.00'), ledgerEntryId: '' })).toThrow();
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('prevents timestamps moving backwards', () => {
    const wallet = open();
    expect(() => wallet.debit({ ...movement('1.00'), at: new Date('2025-01-01T00:00:00.000Z') })).toThrow(InvalidDomainStateError);
    wallet.credit(movement('1.00'));
    expect(() => wallet.debit({ ...movement('1.00'), at: at() })).toThrow(InvalidDomainStateError);
    expect(wallet.version).toBe(2);
  });

  it('rehydrates historical state without increment or replay', () => {
    const wallet = Wallet.rehydrate({
      id: 'stored', playerId: 'p1', balance: m('42.01'), version: 8,
      createdAt: at(), updatedAt: at(),
    });
    expect(wallet.balance.toJSON().amount).toBe('42.01');
    expect(wallet.version).toBe(8);
  });
});
