import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../domain/wager-transaction.js';
import { payloadHash, responseSnapshot, type WagerCommand } from './wager-contracts.js';

const command = (): WagerCommand => ({
  providerId: 'provider',
  externalTransactionId: 'external',
  idempotencyKey: 'unique',
  walletId: 'wallet',
  playerId: 'player',
  roundId: 'round',
  gameId: 'game',
  kind: Kind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
});
const at = new Date('2026-11-16T20:00:00.000Z');

describe('WagerCommand idempotency', () => {
  it('hashes the canonical business payload independent of property insertion order', () => {
    const c = command();
    const reordered = { ...c, money: { currency: 'BRL', amount: '25.00' } };
    expect(payloadHash(c)).toBe(payloadHash(reordered));
    expect(payloadHash(c)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects changes to each business identity and amount', () => {
    const c = command();
    expect(payloadHash(c)).not.toBe(
      payloadHash({ ...c, money: { amount: '25.01', currency: 'BRL' } }),
    );
    expect(payloadHash(c)).not.toBe(payloadHash({ ...c, roundId: 'other' }));
    expect(payloadHash(c)).not.toBe(payloadHash({ ...c, kind: Kind.Win }));
    expect(payloadHash(c)).not.toBe(payloadHash({ ...c, referenceExternalTransactionId: 'other' }));
  });

  it('does not include the retry idempotencyKey in the canonical business payload', () => {
    expect(payloadHash(command())).toBe(payloadHash({ ...command(), idempotencyKey: 'different' }));
  });

  it('stores the original balance and version in immutable response snapshots', () => {
    const c = command();
    const tx = WagerTransaction.create({
      ...c,
      id: 'transaction',
      payloadHash: payloadHash(c),
      money: Money.from(c.money),
      createdAt: at,
    });
    tx.markProcessed(undefined, at);
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      at,
    });
    const snapshot = responseSnapshot(tx, wallet, at);
    wallet.debit({
      transactionId: 'other',
      ledgerEntryId: 'ledger',
      money: Money.from(c.money),
      at,
    });
    expect(snapshot.status).toBe(Status.Processed);
    expect(snapshot.walletVersion).toBe(1);
    expect(snapshot.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(snapshot.observedAt).toBe('2026-11-16T20:00:00.000Z');
  });

  it('preserves machine-readable failure codes in rejected snapshots', () => {
    const c = command();
    const tx = WagerTransaction.create({
      ...c,
      id: 'transaction',
      payloadHash: payloadHash(c),
      money: Money.from(c.money),
      createdAt: at,
    });
    tx.reject(FailureCode.InsufficientFunds);
    const wallet = Wallet.open({
      id: 'wallet',
      playerId: 'player',
      initialBalance: Money.zero('BRL'),
      at,
    });
    expect(responseSnapshot(tx, wallet, at).failureCode).toBe(FailureCode.InsufficientFunds);
  });
});
