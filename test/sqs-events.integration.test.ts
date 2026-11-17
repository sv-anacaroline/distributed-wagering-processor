import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';
import { WalletService } from '../src/http/wallet.service.js';
import { ProcessWager } from '../src/application/process-wager.js';
import { OutboxPublisher } from '../src/events/outbox-publisher.js';
import { SqsWagerConsumer } from '../src/events/sqs-wager-consumer.js';
import type { WagerCommand } from '../src/application/wager-contracts.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../src/domain/wager-transaction.js';

const suite = process.env.EVENTS_E2E === '1' ? describe : describe.skip;
let orm: MikroORM;
let sqs: SQSClient;
let consumer: SqsWagerConsumer;
let publisher: OutboxPublisher;
let sourceUrl = '';
let dlqUrl = '';
let eventsUrl = '';
let processor: ProcessWager;
const deferredEvents: Published[] = [];
const runId = randomUUID().slice(0, 8);

interface Opened {
  readonly walletId: string;
  readonly playerId: string;
}
interface Published {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly data: Record<string, unknown>;
  readonly occurredAt: string;
  readonly version: number;
}
async function queue(name: string): Promise<string> {
  const response = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        VisibilityTimeout: '60',
        ReceiveMessageWaitTimeSeconds: '0',
      },
    }),
  );
  if (!response.QueueUrl) throw new Error('Queue could not be created: ' + name);
  return response.QueueUrl;
}
async function wallet(amount = '100.00'): Promise<Opened> {
  const playerId = randomUUID();
  const result = await new WalletService(orm.em).create(playerId, { amount, currency: 'BRL' });
  return { walletId: result.id, playerId };
}
function wager(
  w: Opened,
  kind: Exclude<Kind, Kind.Opening> = Kind.Bet,
  amount = '25.00',
): WagerCommand {
  const externalTransactionId = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: 'provider-a:' + externalTransactionId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: 'round-one',
    gameId: 'game-one',
    kind,
    money: { amount, currency: 'BRL' },
  };
}
function envelope(command: WagerCommand, messageId = 'msg-' + randomUUID()) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: command,
  };
}
async function send(body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: sourceUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}
async function consumeOne(outcome: 'ack' | 'dlq' = 'ack'): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const results = await consumer.runOnce();
    if (results.length) {
      expect(results).toEqual([outcome]);
      return;
    }
  }
  throw new Error('Message did not reach consumer');
}
async function n(sql: string, args: unknown[] = []): Promise<number> {
  const [row] = await orm.em.execute<Array<{ n: number }>>(sql, args);
  return row?.n ?? 0;
}
async function outboxCount(walletId: string, published = false): Promise<number> {
  return n(
    `select count(*)::integer as n from outbox_messages
     where aggregate_id=?::uuid and payload->>'correlationId' not like 'opening:%'
     ${published ? 'and published_at is not null' : ''}`,
    [walletId],
  );
}
async function publishWallet(walletId: string, expected: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if ((await outboxCount(walletId, true)) >= expected) return;
    await publisher.runOnce();
  }
  throw new Error('Outbox events did not become published for wallet ' + walletId);
}
async function verifyDeliveredEvent(event: Published): Promise<void> {
  expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(event.aggregateId).toBeTruthy();
  expect(event.correlationId).toBeTruthy();
  expect(event.version).toBe(1);
  expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
  const [saved] = await orm.em.execute<Array<{
    payload: Published;
    published_at: Date | null;
  }>>(
    `select payload,published_at from outbox_messages where id=?::uuid`,
    [event.eventId],
  );
  // E2E proof: every SQS delivery matches exactly what was committed
  // and marked published in PostgreSQL after the broker accepted it.
  expect(saved?.published_at).toBeTruthy();
  expect(event).toEqual(saved?.payload);
}

async function assertSourceAcked(): Promise<void> {
  const afterAck = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: sourceUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1,
  }));
  expect(afterAck.Messages ?? []).toHaveLength(0);
}

async function receiveEvents(walletId: string, expected: number, includeOpening = false): Promise<Published[]> {
  const found: Published[] = [];
  for (let i = deferredEvents.length - 1; i >= 0; i--) {
    const item = deferredEvents[i];
    if (item?.aggregateId === walletId) {
      if (includeOpening || !item.correlationId.startsWith('opening:')) found.push(item);
      deferredEvents.splice(i, 1);
    }
  }
  for (let i = 0; i < 25 && found.length < expected; i++) {
    const batch = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsUrl,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    for (const item of batch.Messages ?? []) {
      if (!item.ReceiptHandle || !item.Body) throw new Error('Invalid published SQS delivery');
      const value = JSON.parse(item.Body) as Published;
      await verifyDeliveredEvent(value);
      if (value.aggregateId === walletId) {
        expect(item.Attributes?.MessageGroupId).toBe(walletId);
        if (includeOpening || !value.correlationId.startsWith('opening:')) found.push(value);
      } else {
        deferredEvents.push(value);
      }
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: eventsUrl,
          ReceiptHandle: item.ReceiptHandle,
        }),
      );
    }
  }
  expect(found).toHaveLength(expected);
  return found;
}

suite('SQS FIFO + Inbox + transactional Outbox — actual Postgres and emulator', () => {
  beforeAll(async () => {
    orm = await MikroORM.init(config);
    processor = new ProcessWager(orm.em);
    sqs = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.SQS_ENDPOINT_URL ?? 'http://127.0.0.1:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 2,
    });
    dlqUrl = await queue('wager-e2e-dlq-' + runId + '.fifo');
    sourceUrl = await queue('wager-e2e-in-' + runId + '.fifo');
    eventsUrl = await queue('wager-e2e-out-' + runId + '.fifo');
    consumer = new SqsWagerConsumer(sqs, { incoming: sourceUrl, deadLetter: dlqUrl }, processor);
    publisher = new OutboxPublisher(orm.em, sqs, eventsUrl);
  }, 60_000);
  afterAll(async () => {
    if (sqs) {
      await Promise.all(
        [sourceUrl, eventsUrl, dlqUrl]
          .filter(Boolean)
          .map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url }))),
      );
      sqs.destroy();
    }
    if (orm) await orm.close(true);
  }, 60_000);

  it('publishes OPENING and WalletBalanceChanged in causal SQL/FIFO order', async () => {
    const w = await wallet('100.00');
    const rows = await orm.em.execute<Array<{
      publication_sequence: string;
      event_type: string;
    }>>(
      `select publication_sequence::text as publication_sequence,event_type
       from outbox_messages where aggregate_id=?::uuid order by publication_sequence`,
      [w.walletId],
    );
    expect(rows.map(row => row.event_type)).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    expect(BigInt(rows[0]?.publication_sequence ?? '0')).toBeLessThan(
      BigInt(rows[1]?.publication_sequence ?? '0'),
    );
    for (let i = 0; i < 30; i++) {
      await publisher.runOnce();
      const [status] = await orm.em.execute<Array<{ n: number }>>(
        `select count(*)::integer as n from outbox_messages
         where aggregate_id=?::uuid and published_at is not null`, [w.walletId],
      );
      if (status?.n === 2) break;
    }
    const received = await receiveEvents(w.walletId, 2, true);
    expect(received.map(item => item.eventType)).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    expect(received[0]?.data.kind).toBe('OPENING');
    expect(received[1]?.data.balanceAfter).toEqual({ amount: '100.00', currency: 'BRL' });
  }, 60_000);

  it('commits BET/Inbox/ledger/outbox before ACK and publishes two versioned events', async () => {
    const w = await wallet();
    const cmd = wager(w);
    const body = envelope(cmd);
    await send(JSON.stringify(body), w.walletId);
    await consumeOne();
    await assertSourceAcked();
    const [inbox] = await orm.em.execute<Array<{ processed_at: string | null }>>(
      'select processed_at from inbox_messages where consumer_name=? and message_id=?',
      ['wager-request-consumer', body.messageId],
    );
    expect(inbox?.processed_at).toBeTruthy();
    expect(
      await n('select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid', [
        w.walletId,
      ]),
    ).toBe(2);
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(await outboxCount(w.walletId, true)).toBe(0);

    await publishWallet(w.walletId, 2);
    const deliveries = await receiveEvents(w.walletId, 2);
    expect(new Set(deliveries.map((x) => x.eventType))).toEqual(
      new Set(['WagerTransactionProcessed', 'WalletBalanceChanged']),
    );
    for (const item of deliveries) {
      expect(item.eventId).toBeTruthy();
      expect(item.version).toBe(1);
      expect(item.aggregateId).toBe(w.walletId);
    }
    const changed = deliveries.find((x) => x.eventType === 'WalletBalanceChanged');
    expect(changed?.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(changed?.data.balanceAfter).toEqual({ amount: '75.00', currency: 'BRL' });
  }, 60_000);

  it('redelivers identical business request through another SQS delivery without another debit or event', async () => {
    const w = await wallet();
    const request = JSON.stringify(envelope(wager(w)));
    await send(request, w.walletId);
    await consumeOne();
    await send(request, w.walletId); // SQS message dedup id changes, Inbox messageId does not.
    await consumeOne();
    expect(
      await n(`select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid`, [
        w.walletId,
      ]),
    ).toBe(2);
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(
      await n(
        `select count(*)::integer as n from inbox_messages
       where consumer_name='wager-request-consumer' and message_id=?`,
        [(JSON.parse(request) as { messageId: string }).messageId],
      ),
    ).toBe(1);
  }, 60_000);

  it('acknowledges business rejection and emits only WagerTransactionRejected', async () => {
    const w = await wallet('0.00');
    await send(JSON.stringify(envelope(wager(w))), w.walletId);
    await consumeOne();
    expect(await outboxCount(w.walletId)).toBe(1);
    expect(
      await n('select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid', [
        w.walletId,
      ]),
    ).toBe(0);
    await publishWallet(w.walletId, 1);
    const events = await receiveEvents(w.walletId, 1);
    expect(events[0]?.eventType).toBe('WagerTransactionRejected');
    expect(events[0]?.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  }, 60_000);

  it('does not emit WalletBalanceChanged for LOSS', async () => {
    const w = await wallet();
    await send(JSON.stringify(envelope(wager(w, Kind.Loss))), w.walletId);
    await consumeOne();
    expect(await outboxCount(w.walletId)).toBe(1);
    await publishWallet(w.walletId, 1);
    const events = await receiveEvents(w.walletId, 1);
    expect(events.map((x) => x.eventType)).toEqual(['WagerTransactionProcessed']);
    expect(events[0]?.data.kind).toBe('LOSS');
  }, 60_000);

  it('persists pending REFUND, later applies BET and emits the final REFUND events', async () => {
    const w = await wallet();
    const bet = wager(w);
    const refund = {
      ...wager(w, Kind.Refund),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    await send(JSON.stringify(envelope(refund)), w.walletId);
    await consumeOne();
    const [pending] = await orm.em.execute<Array<{ id: string; status: string }>>(
      `select id,status from wager_transactions
       where provider_id=? and external_transaction_id=?`,
      [refund.providerId, refund.externalTransactionId],
    );
    expect(pending?.status).toBe('PENDING_REFERENCE');
    expect(await outboxCount(w.walletId)).toBe(1);
    await send(JSON.stringify(envelope(bet)), w.walletId);
    await consumeOne();
    if (!pending) throw new Error('Missing pending reference');
    await orm.em.execute(
      'update wager_transactions set reference_next_attempt_at=clock_timestamp() where id=?::uuid',
      [pending.id],
    );
    const completed = await processor.retryPending(pending.id, w.walletId);
    expect(completed?.status).toBe(Status.Processed);
    expect(completed?.balance.amount).toBe('100.00');
    expect(await outboxCount(w.walletId)).toBe(5);
    await publishWallet(w.walletId, 5);
    const events = await receiveEvents(w.walletId, 5);
    expect(events.filter((x) => x.eventType === 'WagerTransactionPendingReference')).toHaveLength(
      1,
    );
    expect(events.filter((x) => x.eventType === 'WagerTransactionProcessed')).toHaveLength(2);
    expect(events.filter((x) => x.eventType === 'WalletBalanceChanged')).toHaveLength(2);
  }, 90_000);

  it('delivers BET, REFUND and ROLLBACK events in causal order with exact balance snapshots', async () => {
    const w = await wallet('100.00');
    const bet = wager(w);
    const refund = {
      ...wager(w, Kind.Refund),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const rollback = {
      ...wager(w, Kind.Rollback),
      referenceExternalTransactionId: refund.externalTransactionId,
    };
    const steps = [
      { command: bet, balance: '75.00', direction: 'DEBIT', version: 2 },
      { command: refund, balance: '100.00', direction: 'CREDIT', version: 3 },
      { command: rollback, balance: '75.00', direction: 'DEBIT', version: 4 },
    ];
    for (const step of steps) {
      const request = envelope(step.command);
      await send(JSON.stringify(request), w.walletId);
      await consumeOne();
      await assertSourceAcked();
      const [inbox] = await orm.em.execute<Array<{ processed_at: Date | null }>>(
        `select processed_at from inbox_messages
         where consumer_name='wager-request-consumer' and message_id=?`,
        [request.messageId],
      );
      expect(inbox?.processed_at).toBeTruthy();
      const [transaction] = await orm.em.execute<Array<{ id: string; status: string }>>(
        `select id,status from wager_transactions
         where provider_id=? and external_transaction_id=?`,
        [step.command.providerId, step.command.externalTransactionId],
      );
      expect(transaction?.status).toBe(Status.Processed);
      const [balance] = await orm.em.execute<Array<{ balance: string; version: number }>>(
        'select balance::text as balance,version from wallets where id=?::uuid',
        [w.walletId],
      );
      expect(balance?.balance).toBe(step.balance);
      expect(balance?.version).toBe(step.version);
      const ledger = await orm.em.execute<Array<{ direction: string; balance_after: string }>>(
        `select direction,balance_after::text as balance_after
         from wallet_ledger_entries where transaction_id=?::uuid`, [transaction?.id],
      );
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.direction).toBe(step.direction);
      expect(ledger[0]?.balance_after).toBe(step.balance);
      const outputRows = await orm.em.execute<Array<{ event_type: string; published_at: Date | null }>>(
        `select event_type,published_at from outbox_messages
         where aggregate_id=?::uuid and payload->>'correlationId'=?
         order by publication_sequence`,
        [w.walletId, step.command.idempotencyKey],
      );
      expect(outputRows.map(row => row.event_type)).toEqual([
        'WagerTransactionProcessed', 'WalletBalanceChanged',
      ]);
      expect(outputRows.every(row => row.published_at === null)).toBe(true);
    }
    await publishWallet(w.walletId, 6);
    const sent = await receiveEvents(w.walletId, 6);
    expect(sent.map(item => item.eventType)).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
      'WagerTransactionProcessed', 'WalletBalanceChanged',
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    expect(sent.filter(item => item.eventType === 'WagerTransactionProcessed')
      .map(item => item.data.kind)).toEqual(['BET', 'REFUND', 'ROLLBACK']);
    expect(sent.filter(item => item.eventType === 'WalletBalanceChanged')
      .map(item => item.data.balanceAfter)).toEqual([
        { amount: '75.00', currency: 'BRL' },
        { amount: '100.00', currency: 'BRL' },
        { amount: '75.00', currency: 'BRL' },
      ]);
    expect(new Set(sent.map(item => item.eventId)).size).toBe(6);
  }, 90_000);

  it('sends malformed JSON to FIFO DLQ and ACKs source, without financial side effects', async () => {
    const group = 'poison-' + randomUUID();
    await send('not-json', group);
    await consumeOne('dlq');
    const messages = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: 1,
      }),
    );
    expect(messages.Messages?.[0]?.Body).toBe('not-json');
    const handle = messages.Messages?.[0]?.ReceiptHandle;
    if (handle)
      await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: handle }));
  }, 60_000);

  it('recovers a claimed but unpublished event after worker death and lease expiration', async () => {
    const w = await wallet();
    await processor.process(wager(w));
    expect(await outboxCount(w.walletId)).toBe(2);
    const [mine] = await orm.em.execute<Array<{ id: string }>>(
      `select id from outbox_messages
       where aggregate_id=?::uuid and published_at is null
       order by occurred_at,id limit 1`,
      [w.walletId],
    );
    if (!mine) throw new Error('Missing durable event for crash simulation');
    // Simulate an old publisher dying after claiming but before SQS send.
    await orm.em.execute(
      `update outbox_messages
       set claimed_by='dead-worker',claim_expires_at=clock_timestamp()-interval '1 second'
       where id=?::uuid`,
      [mine.id],
    );
    const replacement = new OutboxPublisher(orm.em, sqs, eventsUrl, 'replacement-' + randomUUID());
    await replacement.runOnce();
    await publishWallet(w.walletId, 2);
    expect(await outboxCount(w.walletId, true)).toBe(2);
    const events = await receiveEvents(w.walletId, 2);
    expect(new Set(events.map((x) => x.eventId)).size).toBe(2);
    // Make another publisher poll: published rows are never sent again.
    const again = await replacement.runOnce();
    expect(again.published).toBeGreaterThanOrEqual(0);
    expect(await outboxCount(w.walletId, true)).toBe(2);
  }, 90_000);

  it('retries a failed outbox publication without losing the event or changing the ledger', async () => {
    const w = await wallet();
    await processor.process(wager(w));
    const [row] = await orm.em.execute<
      Array<{
        id: string;
        aggregate_id: string;
        event_type: string;
        payload: Record<string, unknown>;
        occurred_at: Date;
        attempts: number;
      }>
    >(
      `select id,aggregate_id,event_type,payload,occurred_at,attempts
       from outbox_messages where aggregate_id=?::uuid
       order by occurred_at,id limit 1`,
      [w.walletId],
    );
    if (!row) throw new Error('Missing durable event for failed-send test');
    const claimToken = 'failed-' + randomUUID();
    await orm.em.execute(
      `update outbox_messages
       set claimed_by=?,claim_expires_at=clock_timestamp()+interval '45 seconds'
       where id=?::uuid`,
      [claimToken, row.id],
    );
    const failingSqs = { send: () => Promise.reject(new Error('simulated SQS outage')) };
    const failing = new OutboxPublisher(orm.em, failingSqs as never, eventsUrl);
    expect(await failing.publish({ ...row, claimToken })).toBe(false);
    const [retry] = await orm.em.execute<
      Array<{
        attempts: number;
        claimed_by: string | null;
        next_attempt_at: Date | null;
        published_at: Date | null;
      }>
    >(
      'select attempts,claimed_by,next_attempt_at,published_at from outbox_messages where id=?::uuid',
      [row.id],
    );
    expect(retry?.attempts).toBe(1);
    expect(retry?.claimed_by).toBeNull();
    expect(retry?.next_attempt_at).toBeTruthy();
    expect(retry?.published_at).toBeNull();
    await orm.em.execute(
      'update outbox_messages set next_attempt_at=clock_timestamp() where id=?::uuid',
      [row.id],
    );
    await publishWallet(w.walletId, 2);
    expect(await outboxCount(w.walletId, true)).toBe(2);
    const events = await receiveEvents(w.walletId, 2);
    expect(new Set(events.map((x) => x.eventId)).size).toBe(2);
    expect(
      await n('select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid', [
        w.walletId,
      ]),
    ).toBe(2);
  }, 90_000);

  it('dead-letters a replay with the same Inbox message ID but altered financial content', async () => {
    const w = await wallet();
    const original = envelope(wager(w));
    await send(JSON.stringify(original), w.walletId);
    await consumeOne();
    const tampered = {
      ...original,
      data: { ...original.data, money: { amount: '24.00', currency: 'BRL' } },
    };
    await send(JSON.stringify(tampered), w.walletId);
    await consumeOne('dlq');
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(
      await n('select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid', [
        w.walletId,
      ]),
    ).toBe(2);
    const [walletState] = await orm.em.execute<Array<{ balance: string }>>(
      'select balance::text as balance from wallets where id=?::uuid',
      [w.walletId],
    );
    expect(walletState?.balance).toBe('75.00');
    const dlq = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(dlq.Messages?.[0]?.Body).toBe(JSON.stringify(tampered));
    const handle = dlq.Messages?.[0]?.ReceiptHandle;
    if (!handle) throw new Error('Missing DLQ receipt handle');
    await sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: handle }));
  }, 60_000);

  it('redelivers safely when the process commits SQL but crashes before SQS ACK', async () => {
    const w = await wallet();
    await send(JSON.stringify(envelope(wager(w))), w.walletId);
    let receipt = '';
    const failingAck = {
      send: async (command: unknown): Promise<unknown> => {
        if (command instanceof ReceiveMessageCommand) {
          const result = await sqs.send(command);
          receipt = result.Messages?.[0]?.ReceiptHandle ?? '';
          return result;
        }
        if (command instanceof DeleteMessageCommand) {
          throw new Error('simulated crash after PostgreSQL commit');
        }
        if (command instanceof SendMessageCommand) return sqs.send(command);
        throw new Error('Unexpected SQS command in test');
      },
    };
    const crashing = new SqsWagerConsumer(
      failingAck as never,
      { incoming: sourceUrl, deadLetter: dlqUrl },
      processor,
    );
    let failed: unknown;
    try {
      await crashing.runOnce();
    } catch (error: unknown) {
      failed = error;
    }
    expect(failed).toBeInstanceOf(AggregateError);
    expect(receipt).toBeTruthy();
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(
      await n('select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid', [
        w.walletId,
      ]),
    ).toBe(2);
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: sourceUrl,
        ReceiptHandle: receipt,
        VisibilityTimeout: 0,
      }),
    );
    await consumeOne();
    expect(await outboxCount(w.walletId)).toBe(2);
    expect(
      await n('select count(*)::integer as n from wallet_ledger_entries where wallet_id=?::uuid', [
        w.walletId,
      ]),
    ).toBe(2);
  }, 60_000);

  it('cooperates across three publishers without double-claiming a wallet event', async () => {
    const wallets = await Promise.all([wallet(), wallet(), wallet()]);
    for (const w of wallets) await processor.process(wager(w));
    const publishers = [
      new OutboxPublisher(orm.em, sqs, eventsUrl, 'p1'),
      new OutboxPublisher(orm.em, sqs, eventsUrl, 'p2'),
      new OutboxPublisher(orm.em, sqs, eventsUrl, 'p3'),
    ];
    for (let i = 0; i < 20; i++) {
      await Promise.all(publishers.map((p) => p.runOnce()));
      if (
        (await Promise.all(wallets.map((w) => outboxCount(w.walletId, true)))).every((n) => n === 2)
      )
        break;
    }
    for (const w of wallets) {
      expect(await outboxCount(w.walletId, true)).toBe(2);
    }
    const received: Published[] = [];
    for (const w of wallets) received.push(...(await receiveEvents(w.walletId, 2)));
    expect(new Set(received.map((x) => x.eventId)).size).toBe(6);
  }, 90_000);
});
