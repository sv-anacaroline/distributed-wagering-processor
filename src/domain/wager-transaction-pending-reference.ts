import { InvalidTransactionStateError } from './errors.js';
import { IntegrationEvent, type EventContext } from './integration-event.js';
import { WagerTransactionStatus, type WagerTransaction } from './wager-transaction.js';

export interface WagerTransactionPendingReferenceData {
  readonly transactionId: string;
  readonly providerId: string;
  readonly walletId: string;
  readonly referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      !transaction.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionStateError(
        'Only PENDING_REFERENCE transactions produce reference events',
      );
    }
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.at,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        walletId: transaction.walletId,
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
