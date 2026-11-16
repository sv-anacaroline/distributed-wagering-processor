import {
  assertNonEmpty,
  assertValidDate,
  CurrencyMismatchError,
  InvalidLedgerEntryError,
} from './errors.js';
import type { Money } from './money.js';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly _createdAt: Date;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    createdAt: Date,
  ) {
    this._createdAt = new Date(createdAt);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    assertNonEmpty(props.id, 'ledgerEntry.id');
    assertNonEmpty(props.walletId, 'ledgerEntry.walletId');
    assertNonEmpty(props.transactionId, 'ledgerEntry.transactionId');
    assertValidDate(props.createdAt, 'ledgerEntry.createdAt');
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError('Unknown ledger direction');
    }
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger amount must be positive');
    }
    for (const balance of [props.balanceBefore, props.balanceAfter]) {
      if (balance.currency !== props.money.currency) {
        throw new CurrencyMismatchError(props.money.currency, balance.currency);
      }
      if (balance.isNegative()) {
        throw new InvalidLedgerEntryError('Ledger balances must not be negative');
      }
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('Ledger movement must reconcile exactly');
    }
    return entry;
  }

  /** Rehydration never replays movements or validates historical transitions. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
