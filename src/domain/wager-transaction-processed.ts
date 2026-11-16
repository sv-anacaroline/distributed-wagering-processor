import { InvalidTransactionStateError } from './errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';
import type { MoneyProps } from './money.js';
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionKind,
} from './wager-transaction.js';

export interface WagerTransactionProcessedData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (transaction.status !== WagerTransactionStatus.Processed) {
      throw new InvalidTransactionStateError('Only PROCESSED transactions produce processed events');
    }
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.at,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(transaction.referenceTransactionId
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
      },
    });
  }
}
