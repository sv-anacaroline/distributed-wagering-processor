import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { WagerTransactionKind as Kind } from '../domain/wager-transaction.js';
import { moneyField, pageLimit, uuidField, wagerPayload, walletPayload } from './request-validation.js';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';
const valid = () => ({
  providerId: 'provider-a', externalTransactionId: 'transaction-123',
  playerId: PLAYER, walletId: WALLET, roundId: 'round-987', gameId: 'fortune-chimp',
  kind: Kind.Bet, money: { amount: '25.00', currency: 'BRL' },
});
describe('HTTP boundary validation', () => {
  it('normalizes wallet input and accepts opening zero or positive balances', () => {
    expect(walletPayload({ playerId: PLAYER.toUpperCase(), initialBalance: { amount: '0.00', currency: 'BRL' } }).playerId).toBe(PLAYER);
    expect(walletPayload({ playerId: PLAYER, initialBalance: { amount: '1000.00', currency: 'BRL' } }).initialBalance.amount).toBe('1000.00');
  });
  it('rejects invalid wallet IDs and malformed money', () => {
    expect(() => uuidField('not-a-uuid', 'walletId')).toThrow(BadRequestException);
    for (const amount of ['-1.00', '1.234', '1e3', 'NaN', '', 10]) {
      expect(() => moneyField({ amount, currency: 'BRL' })).toThrow(BadRequestException);
    }
    expect(() => walletPayload([])).toThrow(BadRequestException);
  });
  it('requires Idempotency-Key rather than silently generating one', () => {
    for (const header of [undefined, '', ' ', 42]) {
      expect(() => wagerPayload(valid(), header)).toThrow(BadRequestException);
    }
    expect(wagerPayload(valid(), 'provider-a:transaction-123').idempotencyKey).toBe('provider-a:transaction-123');
  });
  it('forbids external OPENING and invalid reference combinations', () => {
    expect(() => wagerPayload({ ...valid(), kind: Kind.Opening }, 'key')).toThrow(BadRequestException);
    expect(() => wagerPayload({ ...valid(), kind: Kind.Refund }, 'key')).toThrow(BadRequestException);
    expect(() => wagerPayload({ ...valid(), referenceExternalTransactionId: 'bet1' }, 'key')).toThrow(BadRequestException);
    expect(wagerPayload({ ...valid(), kind: Kind.Refund, referenceExternalTransactionId: 'bet1' }, 'key').referenceExternalTransactionId).toBe('bet1');
  });
  it('validates positive exact money and identifiers', () => {
    expect(() => wagerPayload({ ...valid(), money: { amount: '0.00', currency: 'BRL' } }, 'key')).toThrow(BadRequestException);
    expect(() => wagerPayload({ ...valid(), providerId: 'x y' }, 'key')).toThrow(BadRequestException);
    expect(() => wagerPayload({ ...valid(), walletId: 'invalid' }, 'key')).toThrow(BadRequestException);
  });
  it('uses a stable 50-item page default with bounded explicit limits', () => {
    expect(pageLimit(undefined)).toBe(50);
    expect(pageLimit('1')).toBe(1);
    expect(pageLimit('100')).toBe(100);
    for (const limit of ['0', '101', '-1', '1.2', 'abc', 50]) {
      expect(() => pageLimit(limit)).toThrow(BadRequestException);
    }
  });
});
