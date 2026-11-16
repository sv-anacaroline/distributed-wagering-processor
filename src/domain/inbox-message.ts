import {
  AlreadyProcessedError,
  assertNonEmpty,
  assertValidDate,
  InvalidDomainStateError,
} from './errors.js';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date;
}

/**
 * Database unique constraint (consumer_name, message_id) is the dedup authority,
 * not in-memory state. Store inbox + financial changes + outbox atomically in SQL.
 */
export class InboxMessage {
  private readonly _receivedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this._receivedAt = new Date(receivedAt);
    this._processedAt = processedAt ? new Date(processedAt) : undefined;
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    assertNonEmpty(props.messageId, 'inbox.messageId');
    assertNonEmpty(props.consumerName, 'inbox.consumerName');
    assertNonEmpty(props.payloadHash, 'inbox.payloadHash');
    assertValidDate(props.receivedAt, 'inbox.receivedAt');
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId, state.consumerName, state.payloadHash,
      state.receivedAt, state.processedAt,
    );
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new AlreadyProcessedError('Inbox message was already processed');
    }
    assertValidDate(at, 'inbox.processedAt');
    if (at.getTime() < this._receivedAt.getTime()) {
      throw new InvalidDomainStateError('Inbox processing cannot precede receipt');
    }
    this._processedAt = new Date(at);
  }
}
