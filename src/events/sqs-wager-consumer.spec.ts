import { describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { InvalidSqsMessageError } from './wager-request.js';
import { TransientProcessingError } from '../application/process-wager.js';
import { ProviderWalletMismatchError } from '../domain/errors.js';
import {
  SqsWagerConsumer,
  isPermanentWagerError,
  receiveCount,
  retryVisibilitySeconds,
} from './sqs-wager-consumer.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const payload = (changes: Record<string, unknown> = {}) =>
  JSON.stringify({
    messageId: 'msg-one',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'tx1',
      idempotencyKey: 'key1',
      playerId,
      walletId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...changes,
    },
  });
const message = (body = payload(), attempts = '1', groupId = walletId): Message => ({
  Body: body,
  MessageId: 'aws-id',
  ReceiptHandle: 'handle',
  Attributes: { ApproximateReceiveCount: attempts, MessageGroupId: groupId },
});
const queues = { incoming: 'http://sqs/request', deadLetter: 'http://sqs/dlq' };
type SentCommand =
  | ChangeMessageVisibilityCommand
  | DeleteMessageCommand
  | SendMessageCommand
  | ReceiveMessageCommand;

function setup(process: () => Promise<unknown>, incoming: Message[] = []) {
  const sent: SentCommand[] = [];
  const sqs = {
    send: (command: SentCommand): Promise<unknown> => {
      sent.push(command);
      if (command instanceof ReceiveMessageCommand) return Promise.resolve({ Messages: incoming });
      return Promise.resolve({});
    },
  };
  const worker = new SqsWagerConsumer(sqs as never, queues, {
    processFromInbox: process as never,
  });
  return { worker, sent };
}
describe('SQS wager worker delivery policy', () => {
  it('acknowledges only AFTER SQL use case resolves successfully', async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { worker, sent } = setup(() => committed);
    const processing = worker.processOne(message());
    await Promise.resolve();
    expect(sent).toHaveLength(0);
    release();
    expect(await processing).toBe('ack');
    expect(sent[0]).toBeInstanceOf(DeleteMessageCommand);
  });
  it('routes a business REJECTED result to ACK, not DLQ', async () => {
    const { worker, sent } = setup(() => Promise.resolve({ status: 'REJECTED' }));
    expect(await worker.processOne(message())).toBe('ack');
    expect(sent.some((cmd) => cmd instanceof SendMessageCommand)).toBe(false);
  });
  it('uses bounded exponential visibility backoff for transient infrastructure errors', async () => {
    for (const attempt of [1, 2, 3, 4]) {
      const { worker, sent } = setup(() => Promise.reject(new Error('connection lost')));
      expect(await worker.processOne(message(payload(), String(attempt)))).toBe('retry');
      const cmd = sent[0];
      expect(cmd).toBeInstanceOf(ChangeMessageVisibilityCommand);
      if (!(cmd instanceof ChangeMessageVisibilityCommand)) throw new Error('Missing retry');
      expect(cmd.input.VisibilityTimeout).toBe(retryVisibilitySeconds(attempt));
    }
  });
  it('sends poison messages directly to DLQ, THEN deletes the source', async () => {
    const { worker, sent } = setup(() => Promise.resolve());
    expect(await worker.processOne(message('not-json'))).toBe('dlq');
    expect(sent[0]).toBeInstanceOf(SendMessageCommand);
    expect(sent[1]).toBeInstanceOf(DeleteMessageCommand);
    const cmd = sent[0];
    if (!(cmd instanceof SendMessageCommand)) throw new Error('Missing DLQ send');
    expect(cmd.input.MessageBody).toBe('not-json');
    expect(cmd.input.MessageDeduplicationId).toHaveLength(64);
  });
  it('DLQs a transient failure after the fifth receive', async () => {
    const { worker, sent } = setup(() => Promise.reject(new Error('db unavailable')));
    expect(await worker.processOne(message(payload(), '5'))).toBe('dlq');
    expect(sent[0]).toBeInstanceOf(SendMessageCommand);
    expect(sent[1]).toBeInstanceOf(DeleteMessageCommand);
  });
  it('never deletes before a failed DLQ publish', async () => {
    const commands: SentCommand[] = [];
    const sqs = {
      send: (cmd: SentCommand) => {
        commands.push(cmd);
        return Promise.reject(new Error('DLQ unavailable'));
      },
    };
    const worker = new SqsWagerConsumer(sqs as never, queues, {
      processFromInbox: () => Promise.resolve({} as never),
    });
    let caught: unknown;
    try {
      await worker.processOne(message('broken'));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(SendMessageCommand);
  });
  it('never DLQs a committed wager if the SQS DeleteMessage acknowledgement fails', async () => {
    const sent: SentCommand[] = [];
    const sqs = {
      send: (command: SentCommand) => {
        sent.push(command);
        return Promise.reject(new Error('ack transport unavailable'));
      },
    };
    const worker = new SqsWagerConsumer(sqs as never, queues, {
      processFromInbox: () => Promise.resolve({} as never),
    });
    let caught: unknown;
    try {
      await worker.processOne(message());
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(DeleteMessageCommand);
  });
  it('releases unstarted deliveries during SIGTERM without touching PostgreSQL', async () => {
    const { worker, sent } = setup(() => {
      throw new Error('should not run');
    });
    const controller = new AbortController();
    controller.abort();
    expect(await worker.processOne(message(), controller.signal)).toBe('released');
    expect(sent[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  });
  it('receives an entire batch and waits for each in-flight operation', async () => {
    const { worker, sent } = setup(() => Promise.resolve(), [message(), message(payload())]);
    expect(await worker.runOnce()).toEqual(['ack', 'ack']);
    expect(sent[0]).toBeInstanceOf(ReceiveMessageCommand);
    expect(sent.filter((cmd) => cmd instanceof DeleteMessageCommand)).toHaveLength(2);
  });
  it('waits for every delivery to settle before reporting a batch failure', async () => {
    let completed = false;
    const source = [message('invalid-body'), message(payload(), '1', 'other-wallet')];
    const sqs = {
      send: (cmd: SentCommand): Promise<unknown> => {
        if (cmd instanceof ReceiveMessageCommand) return Promise.resolve({ Messages: source });
        if (cmd instanceof SendMessageCommand) return Promise.reject(new Error('DLQ down'));
        return Promise.resolve({});
      },
    };
    const worker = new SqsWagerConsumer(sqs as never, queues, {
      processFromInbox: async () => {
        await Promise.resolve();
        completed = true;
        return {} as never;
      },
    });
    let failed: unknown;
    try {
      await worker.runOnce();
    } catch (e: unknown) {
      failed = e;
    }
    expect(failed).toBeInstanceOf(AggregateError);
    expect(completed).toBe(true);
  });
  it('does not start the next FIFO delivery of the same group until the first is acknowledged', async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { worker, sent } = setup(async () => {
      calls++;
      if (calls === 1) await gate;
      return {};
    }, [message(), message(payload())]);
    const run = worker.runOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    release();
    expect(await run).toEqual(['ack', 'ack']);
    expect(calls).toBe(2);
    expect(sent.filter((cmd) => cmd instanceof DeleteMessageCommand)).toHaveLength(2);
  });

  it('allows independent FIFO groups to advance while another group is blocked', async () => {
    let release!: () => void;
    let started = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { worker } = setup(async () => {
      started++;
      if (started === 1) await gate;
      return {};
    }, [message(payload(), '1', 'wallet-A'), message(payload(), '1', 'wallet-B')]);
    const run = worker.runOnce();
    for (let i = 0; i < 10 && started < 2; i++) await Promise.resolve();
    expect(started).toBe(2);
    release();
    expect(await run).toEqual(['ack', 'ack']);
  });

  it('releases later same-group deliveries on transient retry without executing them', async () => {
    let calls = 0;
    const { worker, sent } = setup(() => {
      calls++;
      return Promise.reject(new Error('temporary SQL outage'));
    }, [message(), message(payload())]);
    expect(await worker.runOnce()).toEqual(['retry', 'released']);
    expect(calls).toBe(1);
    const updates = sent.filter((cmd) => cmd instanceof ChangeMessageVisibilityCommand);
    expect(updates).toHaveLength(2);
    expect((updates[1] as ChangeMessageVisibilityCommand).input.VisibilityTimeout).toBe(0);
  });

  it('distinguishes permanent domain messages from transient outages', () => {
    expect(isPermanentWagerError(new InvalidSqsMessageError('bad'))).toBe(true);
    expect(isPermanentWagerError(new Error('network'))).toBe(false);
    expect(
      isPermanentWagerError(new TransientProcessingError('Concurrent wallet write detected')),
    ).toBe(false);
    expect(receiveCount(message(payload(), '-5'))).toBe(1);
    expect(retryVisibilitySeconds(5)).toBe(16);
  });
  it('DLQs a provider-wallet authorization failure before touching the ledger again', async () => {
    const { worker, sent } = setup(() => Promise.reject(new ProviderWalletMismatchError()));
    expect(await worker.processOne(message())).toBe('dlq');
    expect(sent[0]).toBeInstanceOf(SendMessageCommand);
    expect(sent[1]).toBeInstanceOf(DeleteMessageCommand);
    const dlq = sent[0] as SendMessageCommand;
    expect(dlq.input.MessageAttributes?.failureKind?.StringValue).toBe('PERMANENT');
  });

  it('refuses a message with no SQS receipt handle instead of ACKing it', async () => {
    const { worker, sent } = setup(() => Promise.resolve({}));
    let error: unknown;
    try {
      await worker.processOne({ Body: payload() });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(sent).toHaveLength(0);
  });
});
