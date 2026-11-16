import {
  assertNonEmpty,
  assertValidDate,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidDomainStateError,
} from './errors.js';
import type { Money } from './money.js';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.js';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletMovement {
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly money: Money;
  readonly at: Date;
}

/** Aggregate root. Persist it and the returned ledger entry in the SAME SQL transaction. */
export class Wallet {
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this._createdAt = new Date(createdAt);
    this._updatedAt = new Date(updatedAt);
  }

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): Wallet {
    assertNonEmpty(props.id, 'wallet.id');
    assertNonEmpty(props.playerId, 'wallet.playerId');
    assertValidDate(props.at, 'wallet.createdAt');
    if (props.initialBalance.isNegative()) {
      throw new InvalidDomainStateError('Opening balance cannot be negative');
    }
    // Application service must also create an OPENING transaction and ledger
    // entry (only if initialBalance > 0) in the SAME SQL transaction.
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Persisted state is reconstructed without replaying movements or events. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.balance.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(movement, LedgerDirection.Debit);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    return this.move(movement, LedgerDirection.Credit);
  }

  private move(movement: WalletMovement, direction: LedgerDirection): WalletLedgerEntry {
    assertValidDate(movement.at, 'wallet.movementAt');
    this.assertSameCurrency(movement.money);
    if (!movement.money.isPositive()) {
      throw new InvalidDomainStateError('Financial movement must be strictly positive');
    }
    if (movement.at.getTime() < this._createdAt.getTime()) {
      throw new InvalidDomainStateError('Movement cannot precede wallet creation');
    }
    if (movement.at.getTime() < this._updatedAt.getTime()) {
      throw new InvalidDomainStateError('Movement cannot precede last wallet change');
    }
    if (!Number.isSafeInteger(this._version + 1)) {
      throw new InvalidDomainStateError('Wallet version overflow');
    }
    if (direction === LedgerDirection.Debit && this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError();
    }
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this._balance.subtract(movement.money)
        : this._balance.add(movement.money);

    // Validate the ledger entry BEFORE changing the aggregate in memory.
    const entry = WalletLedgerEntry.create({
      id: movement.ledgerEntryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(movement.at);
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
