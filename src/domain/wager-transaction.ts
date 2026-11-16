import {
  assertNonEmpty,
  assertValidDate,
  InvalidDomainStateError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from './errors.js';
import type { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  AlreadyReversed = 'ALREADY_REVERSED',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  PermanentInfrastructureError = 'PERMANENT_INFRASTRUCTURE_ERROR',
}

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

/**
 * This object decides valid transitions and reference policies.
 * SQL locks, deduplication, and committing the matching Ledger + Outbox are use-case concerns.
 */
export class WagerTransaction {
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    createdAt: Date,
    status: WagerTransactionStatus,
    referenceTransactionId?: string,
    failureCode?: FailureCode,
    processedAt?: Date,
  ) {
    this._createdAt = new Date(createdAt);
    this._status = status;
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = failureCode;
    this._processedAt = processedAt ? new Date(processedAt) : undefined;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidDomainStateError('OPENING is only available through opening()');
    }
    return WagerTransaction.createPending(props);
  }

  /** Only the internal wallet-opening flow may create OPENING transactions. */
  static opening(
    props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>,
  ): WagerTransaction {
    return WagerTransaction.createPending({ ...props, kind: WagerTransactionKind.Opening });
  }

  private static createPending(props: CreateWagerTransactionProps): WagerTransaction {
    for (const [field, value] of [
      ['id', props.id],
      ['providerId', props.providerId],
      ['externalTransactionId', props.externalTransactionId],
      ['idempotencyKey', props.idempotencyKey],
      ['payloadHash', props.payloadHash],
      ['walletId', props.walletId],
      ['playerId', props.playerId],
      ['roundId', props.roundId],
      ['gameId', props.gameId],
    ] as const) {
      assertNonEmpty(value, `wagerTransaction.${field}`);
    }
    assertValidDate(props.createdAt, 'wagerTransaction.createdAt');
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidDomainStateError('Unknown wagering transaction kind');
    }
    if (!props.money.isPositive()) {
      throw new InvalidDomainStateError('Wager amount must be positive');
    }
    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId?.trim()) {
      throw new InvalidReferenceError('REFUND/ROLLBACK require an external transaction reference');
    }
    if (
      props.referenceExternalTransactionId !== undefined &&
      ![
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
      ].includes(props.kind)
    ) {
      throw new InvalidReferenceError('Reference is not permitted for this kind');
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidReferenceError('A transaction cannot reference itself');
    }
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Only reconstructs persisted fields; no business transition is replayed. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  affectsBalance(reference?: WagerTransaction): boolean {
    return this.ledgerDirectionFor(reference) !== null;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markPendingReference(): void {
    this.assertActive();
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        'Cannot await a reference not declared by the transaction',
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertActive();
    assertValidDate(at, 'wagerTransaction.processedAt');
    if (at.getTime() < this._createdAt.getTime()) {
      throw new InvalidTransactionStateError('Processing cannot precede creation');
    }
    const referenceExpected = this.referenceExternalTransactionId !== undefined;
    if (referenceExpected && !referenceTransactionId?.trim()) {
      throw new InvalidReferenceError('Resolved reference id is required');
    }
    if (!referenceExpected && referenceTransactionId !== undefined) {
      throw new InvalidReferenceError('Unexpected resolved reference');
    }
    if (referenceTransactionId === this.id) {
      throw new InvalidReferenceError('Self-reference is forbidden');
    }
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at);
    this._failureCode = undefined;
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: FailureCode): void {
    this.assertActive();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertActive();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  /**
   * Direction can only be decided for reference operations after looking up
   * the processed transaction in the same database transaction/lock scope.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    if (this.kind === WagerTransactionKind.Loss) return null;
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;
    if (this.kind === WagerTransactionKind.Opening) return LedgerDirection.Credit;

    if (this.kind === WagerTransactionKind.Win) {
      if (this.referenceExternalTransactionId !== undefined) {
        this.assertValidReference(reference, [WagerTransactionKind.Bet], false);
      }
      return LedgerDirection.Credit;
    }

    if (this.kind === WagerTransactionKind.Refund) {
      this.assertValidReference(reference, [WagerTransactionKind.Bet], true);
      return LedgerDirection.Credit;
    }

    if (this.kind === WagerTransactionKind.Rollback) {
      this.assertValidReference(
        reference,
        [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
        true,
      );
      return reference?.kind === WagerTransactionKind.Bet
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    throw new InvalidDomainStateError('Unknown wagering transaction kind');
  }

  private assertValidReference(
    reference: WagerTransaction | undefined,
    kinds: readonly WagerTransactionKind[],
    exactAmount: boolean,
  ): void {
    if (!reference || reference.status !== WagerTransactionStatus.Processed) {
      throw new InvalidReferenceError('Reference must exist and be PROCESSED');
    }
    if (
      reference.id === this.id ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency ||
      !kinds.includes(reference.kind)
    ) {
      throw new InvalidReferenceError('Reference does not match transaction context or kind');
    }
    if (exactAmount && !this.money.equals(reference.money)) {
      throw new InvalidReferenceError('Refund/rollback must match the full original amount');
    }
  }

  private assertActive(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${this._status} is terminal`);
    }
  }
}
