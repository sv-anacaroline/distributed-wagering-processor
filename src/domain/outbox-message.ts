import {
  AlreadyProcessedError,
  assertValidDate,
  InvalidDomainStateError,
} from './errors.js';
import type { IntegrationEvent } from './integration-event.js';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

/** Snapshot an event envelope so callers can never mutate pending payloads. */
function immutablePayload(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const copy = structuredClone(payload);
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}

/**
 * Durable publication intention, NOT the SQS publisher.
 * Save in the same SQL transaction as wallet, transaction, ledger and inbox.
 */
export class OutboxMessage {
  readonly payload: Readonly<Record<string, unknown>>;
  private readonly _occurredAt: Date;
  private _nextAttemptAt: Date | undefined;
  private _publishedAt: Date | undefined;
  private _attempts: number;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    payload: Readonly<Record<string, unknown>>,
    occurredAt: Date,
    attempts: number,
    nextAttemptAt?: Date,
    publishedAt?: Date,
  ) {
    this.payload = immutablePayload(payload);
    this._occurredAt = new Date(occurredAt);
    this._attempts = attempts;
    this._nextAttemptAt = nextAttemptAt ? new Date(nextAttemptAt) : undefined;
    this._publishedAt = publishedAt ? new Date(publishedAt) : undefined;
  }

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope = event.toJSON();
    const payload: Record<string, unknown> = {
      eventId: envelope.eventId,
      eventType: envelope.eventType,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
      occurredAt: envelope.occurredAt,
      version: envelope.version,
      data: envelope.data,
    };
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType, state.payload,
      state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt,
    );
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    assertValidDate(now, 'outbox.now');
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new AlreadyProcessedError('Outbox event was already published');
    }
    assertValidDate(at, 'outbox.publishedAt');
    if (at < this._occurredAt) {
      throw new InvalidDomainStateError('Publication cannot precede event occurrence');
    }
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Deterministic bounded exponential backoff: 1s, 2s, 4s ... max 5m. */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) {
      throw new AlreadyProcessedError('Published outbox cannot be rescheduled');
    }
    assertValidDate(now, 'outbox.retryAt');
    if (now < this._occurredAt || !Number.isSafeInteger(this._attempts + 1)) {
      throw new InvalidDomainStateError('Invalid outbox retry timestamp or attempts');
    }
    this._attempts += 1;
    const delayMs = Math.min(1_000 * 2 ** Math.min(this._attempts - 1, 9), 300_000);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
