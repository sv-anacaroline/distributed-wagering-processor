import { InvalidDomainStateError } from './errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';
import type { MoneyProps } from './money.js';
import { Wallet } from './wallet.js';
import { WalletLedgerEntry, type LedgerDirection } from './wallet-ledger-entry.js';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (
      wallet.id !== entry.walletId ||
      !wallet.balance.equals(entry.balanceAfter) ||
      wallet.version < 1
    ) {
      throw new InvalidDomainStateError('WalletBalanceChanged requires the resulting committed wallet state');
    }
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.at,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
