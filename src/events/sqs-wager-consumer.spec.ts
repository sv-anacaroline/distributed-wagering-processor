import { describe, expect, it } from 'bun:test';
import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { InvalidSqsMessageError } from './wager-request.js';
import {
  SqsWagerConsumer, isPermanentWagerError, receiveCount, retryVisibilitySeconds,
} from './sqs-wager-consumer.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const payload = (changes: Record<string, unknown> = {}) => JSON.stringify({
  messageId: 'msg-one', type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: { providerId: 'provider-a', externalTransactionId: 'tx1', idempotencyKey: 'key1',
    playerId, walletId, roundId: 'r1', gameId: 'g1', kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' }, ...changes },
});
const message = (body = payload(), attempts = '1'): Message => ({
  Body: body, MessageId: 'aws-id', ReceiptHandle: 'handle',
  Attributes: { ApproximateReceiveCount: attempts },
});
const queues = { incoming: 'http://sqs/request', deadLetter: 'http://sqs/dlq' };
type SentCommand = ChangeMessageVisibilityCommand | DeleteMessageCommand | SendMessageCommand | ReceiveMessageCommand;

function setup(process: () => Promise<unknown>, incoming: Message[] = []) {
  const sent: SentCommand[] = [];
  const sqs = { send: (command: SentCommand): Promise<unknown> => {
    sent.push(command);
    if (command instanceof ReceiveMessageCommand) return Promise.resolve({ Messages: incoming });
    return Promise.resolve({});
  } };
  const worker = new SqsWagerConsumer(sqs as never, queues, {
    processFromInbox: process as never,
  });
  return { worker, sent };
}
describe('SQS wager worker delivery policy', () => {
  it('acknowledges only AFTER SQL use case resolves successfully', async () => {
    let release!: () => void;
    const committed = new Promise<void>(resolve => { release = resolve; });
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
    expect(sent.some(cmd => cmd instanceof SendMessageCommand)).toBe(false);
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
    const sqs = { send: (cmd: SentCommand) => {
      commands.push(cmd);
      return Promise.reject(new Error('DLQ unavailable'));
    } };
    const worker = new SqsWagerConsumer(sqs as never, queues, { processFromInbox: () => Promise.resolve({} as never) });
    let caught: unknown;
    try { await worker.processOne(message('broken')); } catch (error: unknown) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(SendMessageCommand);
  });
  it('releases unstarted deliveries during SIGTERM without touching PostgreSQL', async () => {
    const { worker, sent } = setup(() => { throw new Error('should not run'); });
    const controller = new AbortController();
    controller.abort();
    expect(await worker.processOne(message(), controller.signal)).toBe('released');
    expect(sent[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  });
  it('receives an entire batch and waits for each in-flight operation', async () => {
    const { worker, sent } = setup(() => Promise.resolve(), [message(), message(payload())]);
    expect(await worker.runOnce()).toEqual(['ack', 'ack']);
    expect(sent[0]).toBeInstanceOf(ReceiveMessageCommand);
    expect(sent.filter(cmd => cmd instanceof DeleteMessageCommand)).toHaveLength(2);
  });
  it('distinguishes permanent domain messages from transient outages', () => {
    expect(isPermanentWagerError(new InvalidSqsMessageError('bad'))).toBe(true);
    expect(isPermanentWagerError(new Error('network'))).toBe(false);
    expect(receiveCount(message(payload(), '-5'))).toBe(1);
    expect(retryVisibilitySeconds(5)).toBe(16);
  });
});
