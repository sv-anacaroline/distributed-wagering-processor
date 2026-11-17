import { randomUUID } from 'node:crypto';
import { count, duration, log, withSpan, currentTraceparent } from '../telemetry/otel.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../domain/outbox-message.js';

export interface ClaimedEvent {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: Date;
  readonly attempts: number;
  readonly claimToken: string;
  readonly traceparent?: string | null;
}
type RawEvent = Omit<ClaimedEvent, 'claimToken'>;
export interface PublishCycle {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
}
export const OUTBOX_LEASE_SECONDS = 45;

export function eventMessage(
  event: Pick<ClaimedEvent, 'id' | 'aggregate_id' | 'payload'>,
  url: string,
): SendMessageCommand {
  const traceparent = currentTraceparent();
  return new SendMessageCommand({
    QueueUrl: url,
    ...(traceparent
      ? {
          MessageAttributes: {
            traceparent: { DataType: 'String', StringValue: traceparent },
          },
        }
      : {}),
    MessageBody: JSON.stringify(event.payload),
    MessageGroupId: event.aggregate_id,
    MessageDeduplicationId: event.id,
  });
}

/**
 * Database-backed SKIP LOCKED claim. No network work while holding SQL row
 * locks. A per-wallet head-of-line filter ensures later events do not overtake
 * an unpublished event from the same wallet across multiple publishers.
 * Claims are fenced with a fresh token so an expired worker cannot ACK/retry
 * a record already owned by another worker.
 */
export class OutboxPublisher {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly instanceId: string = randomUUID(),
  ) {}

  async claim(batchSize = 10): Promise<ClaimedEvent[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) {
      throw new Error('Outbox batch size must be 1..50');
    }
    const claimToken = `${this.instanceId}:${randomUUID()}`;
    const due = await this.em.fork().execute<RawEvent[]>(
      `with due as (
         select o.id from outbox_messages o
         where o.published_at is null
           and (o.next_attempt_at is null or o.next_attempt_at <= clock_timestamp())
           and (o.claim_expires_at is null or o.claim_expires_at <= clock_timestamp())
           and not exists (
             select 1 from outbox_messages older
             where older.aggregate_id = o.aggregate_id
               and older.published_at is null
               and older.publication_sequence < o.publication_sequence
           )
         order by o.publication_sequence
         for update of o skip locked
         limit ?
       )
       update outbox_messages o set
         claimed_by=?, claim_expires_at=clock_timestamp() + (? * interval '1 second')
       from due where o.id=due.id
       returning o.id,o.aggregate_id,o.event_type,o.payload,o.occurred_at,o.attempts,o.traceparent`,
      [batchSize, claimToken, OUTBOX_LEASE_SECONDS],
    );
    return due.map((row) => ({ ...row, claimToken }));
  }

  async publish(event: ClaimedEvent): Promise<boolean> {
    return withSpan(
      'outbox.publish',
      {
        'messaging.system': 'aws.sqs',
        'messaging.operation.name': 'publish',
        event_type: event.event_type,
        event_id: event.id,
        wallet_id: event.aggregate_id,
      },
      async () => {
        const startedAt = performance.now();
        const now = new Date();
        try {
          await this.sqs.send(eventMessage(event, this.queueUrl));
          const state = OutboxMessage.rehydrate({
            id: event.id,
            aggregateId: event.aggregate_id,
            eventType: event.event_type,
            payload: event.payload,
            occurredAt: new Date(event.occurred_at),
            attempts: event.attempts,
          });
          state.markPublished(new Date(Math.max(now.getTime(), state.occurredAt.getTime())));
          const result = await this.em.fork().execute<{ affectedRows?: number }>(
            `update outbox_messages
         set published_at=greatest(clock_timestamp(),occurred_at),
             claimed_by=null,claim_expires_at=null,next_attempt_at=null
         where id=?::uuid and claimed_by=? and published_at is null
           and claim_expires_at > clock_timestamp()`,
            [event.id, event.claimToken],
            'run',
          );
          // An expired lease may lead to another publish: consumer eventId dedup
          // remains the authoritative safety net beyond the SQS 5-minute window.
          const success = result.affectedRows === 1;
          count('wager_outbox_publish_total', {
            event_type: event.event_type,
            outcome: success ? 'published' : 'fenced',
          });
          log(success ? 'info' : 'warn', 'outbox.publish.completed', {
            event_type: event.event_type,
            event_id: event.id,
            wallet_id: event.aggregate_id,
            outcome: success ? 'published' : 'fenced',
          });
          return success;
        } catch (error: unknown) {
          const state = OutboxMessage.rehydrate({
            id: event.id,
            aggregateId: event.aggregate_id,
            eventType: event.event_type,
            payload: event.payload,
            occurredAt: new Date(event.occurred_at),
            attempts: event.attempts,
          });
          state.scheduleRetry(new Date(Math.max(Date.now(), state.occurredAt.getTime())));
          await this.em.fork().execute(
            `update outbox_messages
         set attempts=?,next_attempt_at=?,claimed_by=null,claim_expires_at=null
         where id=?::uuid and claimed_by=? and published_at is null`,
            [state.attempts, state.nextAttemptAt, event.id, event.claimToken],
          );
          count('wager_outbox_publish_total', { event_type: event.event_type, outcome: 'retry' });
          log('error', 'outbox.publish.failed', {
            event_type: event.event_type,
            event_id: event.id,
            error_type: error instanceof Error ? error.name : 'UnknownError',
            attempts: state.attempts,
          });
          return false;
        } finally {
          duration('wager_outbox_publish_duration_ms', performance.now() - startedAt, {
            event_type: event.event_type,
          });
        }
      },
      event.traceparent,
    );
  }

  async release(event: ClaimedEvent): Promise<void> {
    await this.em.fork().execute(
      `update outbox_messages set claimed_by=null,claim_expires_at=null
       where id=?::uuid and claimed_by=? and published_at is null`,
      [event.id, event.claimToken],
    );
  }

  async runOnce(signal?: AbortSignal, batchSize = 10): Promise<PublishCycle> {
    const events = await this.claim(batchSize);
    let published = 0;
    let retried = 0;
    for (const event of events) {
      if (signal?.aborted) {
        await this.release(event);
        continue;
      }
      if (await this.publish(event)) published++;
      else retried++;
    }
    return { claimed: events.length, published, retried };
  }

  async run(signal: AbortSignal, intervalMs = 500): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce(signal);
      } catch (error: unknown) {
        console.error('Outbox publish iteration failed; leases will recover', error);
      }
      try {
        await sleep(intervalMs, undefined, { signal });
      } catch {
        if (signal.aborted) break;
      }
    }
  }
}
