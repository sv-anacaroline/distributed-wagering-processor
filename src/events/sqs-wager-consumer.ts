import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { DomainError } from '../domain/errors.js';
import {
  IdempotencyConflictError,
  InboxPayloadConflictError,
  type ProcessWager,
} from '../application/process-wager.js';
import { InvalidSqsMessageError, parseWagerRequest } from './wager-request.js';

export const WAGER_CONSUMER_NAME = 'wager-request-consumer';
export const SQS_MAX_ATTEMPTS = 5;

export type MessageOutcome = 'ack' | 'retry' | 'dlq' | 'released';

export function receiveCount(message: Message): number {
  const value = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
export function retryVisibilitySeconds(count: number): number {
  const capped = Math.min(Math.max(count, 1), SQS_MAX_ATTEMPTS);
  return Math.min(2 ** (capped - 1), 60);
}
export function isPermanentWagerError(error: unknown): boolean {
  return (
    error instanceof InvalidSqsMessageError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof DomainError
  );
}

interface SqsQueues {
  readonly incoming: string;
  readonly deadLetter: string;
}
/**
 * The broker handles visibility and retry but PostgreSQL owns deduplication.
 * DeleteMessage is executed ONLY after processFromInbox commits successfully.
 * Permanent failures are copied to DLQ before acknowledging the source.
 */
export class SqsWagerConsumer {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: SqsQueues,
    private readonly wagering: Pick<ProcessWager, 'processFromInbox'>,
  ) {}

  async processOne(message: Message, signal?: AbortSignal): Promise<MessageOutcome> {
    if (!message.ReceiptHandle) throw new Error('SQS message missing ReceiptHandle');
    if (signal?.aborted) {
      await this.release(message.ReceiptHandle);
      return 'released';
    }
    try {
      const parsed = parseWagerRequest(message.Body ?? '');
      await this.wagering.processFromInbox(parsed.command, {
        consumerName: WAGER_CONSUMER_NAME,
        messageId: parsed.messageId,
        payloadHash: parsed.payloadHash,
      });
    } catch (error: unknown) {
      // An AWS ack failure is treated as transient; the DB Inbox makes redelivery safe.
      const attempts = receiveCount(message);
      if (isPermanentWagerError(error) || attempts >= SQS_MAX_ATTEMPTS) {
        await this.toDlq(message, error);
        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.queues.incoming,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
        return 'dlq';
      }
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queues.incoming,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: retryVisibilitySeconds(attempts),
        }),
      );
      return 'retry';
    }
    // Important: a failed DeleteMessage is NOT a business failure and must
    // NEVER route an already committed financial transaction to the DLQ.
    // SQS can redeliver; Inbox/command idempotency safely return the original.
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queues.incoming,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
    return 'ack';
  }

  private async toDlq(message: Message, error: unknown): Promise<void> {
    const original = message.Body ?? '';
    const dedup = createHash('sha256')
      .update(`${message.MessageId ?? ''}:${original}`)
      .digest('hex');
    // Preserve the original envelope so operational DLQ replay is possible.
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.deadLetter,
        MessageBody: original,
        MessageGroupId: 'wager-dead-letters',
        MessageDeduplicationId: dedup,
        MessageAttributes: {
          failureKind: {
            DataType: 'String',
            StringValue: isPermanentWagerError(error) ? 'PERMANENT' : 'RETRIES_EXHAUSTED',
          },
          errorType: {
            DataType: 'String',
            StringValue: error instanceof Error ? error.name : 'UnknownError',
          },
        },
      }),
    );
  }

  private async release(receiptHandle: string): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queues.incoming,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: 0,
      }),
    );
  }

  async runOnce(signal?: AbortSignal): Promise<readonly MessageOutcome[]> {
    const received = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queues.incoming,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { ...(signal ? { abortSignal: signal } : {}) },
    );
    const messages = received.Messages ?? [];
    // All operations settle before the next batch; no unobserved promises on shutdown.
    const settled = await Promise.allSettled(
      messages.map((message) => this.processOne(message, signal)),
    );
    const failures: unknown[] = [];
    for (const item of settled) {
      if (item.status === 'rejected') failures.push(item.reason as unknown);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'One or more SQS messages could not be acknowledged or dead-lettered',
      );
    }
    return settled.map((item) => {
      if (item.status !== 'fulfilled') throw new Error('Unreachable SQS settlement');
      return item.value;
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce(signal);
      } catch (error: unknown) {
        if (signal.aborted) break;
        console.error('SQS consumer iteration failed', error);
        try {
          await sleep(500, undefined, { signal });
        } catch {
          if (signal.aborted) break;
        }
      }
    }
  }
}
