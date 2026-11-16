import { describe, expect, it } from 'bun:test';
import {
  AlreadyProcessedError,
  assertNonEmpty,
  assertValidDate,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainStateError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from './errors.js';
import type { DomainError, DomainErrorCode } from './errors.js';

describe('domain errors', () => {
  it('exposes stable codes for each error', () => {
    const cases: Array<[DomainError, DomainErrorCode]> = [
      [new InvalidMoneyError('invalid'), 'INVALID_MONEY'],
      [new CurrencyMismatchError('BRL', 'USD'), 'CURRENCY_MISMATCH'],
      [new InsufficientFundsError(), 'INSUFFICIENT_FUNDS'],
      [new InvalidLedgerEntryError('invalid'), 'INVALID_LEDGER_ENTRY'],
      [new InvalidTransactionStateError('invalid'), 'INVALID_TRANSACTION_STATE'],
      [new InvalidReferenceError('invalid'), 'INVALID_REFERENCE'],
      [new InvalidDomainStateError('invalid'), 'INVALID_DOMAIN_STATE'],
      [new AlreadyProcessedError('invalid'), 'ALREADY_PROCESSED'],
    ];
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message).not.toBeEmpty();
    }
  });

  it('rejects blank identifiers and accepts non-empty identifiers', () => {
    expect(() => assertNonEmpty(' ', 'id')).toThrow(InvalidDomainStateError);
    expect(() => assertNonEmpty('', 'id')).toThrow('id must not be empty');
    expect(() => assertNonEmpty('abc', 'id')).not.toThrow();
  });

  it('rejects invalid dates and accepts valid timestamps', () => {
    expect(() => assertValidDate(new Date('invalid'), 'createdAt')).toThrow(
      InvalidDomainStateError,
    );
    expect(() => assertValidDate(new Date('2026-01-01T00:00:00.000Z'), 'at')).not.toThrow();
  });
});
