import { assertNonEmpty, assertValidDate } from './errors.js';

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly at: Date;
}

export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: T;
}

export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

/** Deeply freeze a structured-cloned integration event payload. */
function frozenCopy<T>(data: T): Readonly<T> {
  const copy = structuredClone(data);
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const nested of Object.values(value)) freeze(nested);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy as Readonly<T>;
}

/**
 * Pure, immutable, versioned envelope. It describes an event, not a publication.
 * The use case persists its OutboxMessage in the same SQL transaction as the ledger.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    assertNonEmpty(props.eventId, 'event.eventId');
    assertNonEmpty(props.aggregateId, 'event.aggregateId');
    assertNonEmpty(props.correlationId, 'event.correlationId');
    if (props.causationId !== undefined) assertNonEmpty(props.causationId, 'event.causationId');
    assertValidDate(props.occurredAt, 'event.occurredAt');
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt);
    this.data = frozenCopy(props.data);
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }
}
