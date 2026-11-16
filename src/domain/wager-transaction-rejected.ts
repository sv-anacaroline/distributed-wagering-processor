import { InvalidTransactionStateError } from './errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type FailureCode,
} from './wager-transaction.js';

export interface WagerTransactionRejectedData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly walletId: string;
  readonly failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (transaction.status !== WagerTransactionStatus.Rejected || !transaction.failureCode) {
      throw new InvalidTransactionStateError('Only REJECTED transactions produce rejected events');
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.at,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        walletId: transaction.walletId,
        failureCode: transaction.failureCode,
      },
    });
  }
}
