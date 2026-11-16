/** Stable, transport-agnostic error codes. API/SQS mapping belongs outside the domain. */
export type DomainErrorCode =
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_LEDGER_ENTRY'
  | 'INVALID_TRANSACTION_STATE'
  | 'INVALID_REFERENCE'
  | 'INVALID_DOMAIN_STATE'
  | 'ALREADY_PROCESSED'
  | 'IDEMPOTENCY_CONFLICT';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, received: string) {
    super('CURRENCY_MISMATCH', `Expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Wallet has insufficient funds');
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INVALID_LEDGER_ENTRY', message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_TRANSACTION_STATE', message);
  }
}

export class InvalidReferenceError extends DomainError {
  constructor(message: string) {
    super('INVALID_REFERENCE', message);
  }
}

export class InvalidDomainStateError extends DomainError {
  constructor(message: string) {
    super('INVALID_DOMAIN_STATE', message);
  }
}

export class AlreadyProcessedError extends DomainError {
  constructor(message: string) {
    super('ALREADY_PROCESSED', message);
  }
}

/** Check the basic identity fields at the boundary of each factory. */
export function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidDomainStateError(`${field} must not be empty`);
  }
}

export function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new InvalidDomainStateError(`${field} must be a valid Date`);
  }
}
