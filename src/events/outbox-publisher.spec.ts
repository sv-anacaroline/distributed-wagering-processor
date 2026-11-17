import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { eventMessage, OUTBOX_LEASE_SECONDS, OutboxPublisher } from './outbox-publisher.js';

const walletId = randomUUID();
const eventId = randomUUID();
const event = () => ({
  id: eventId,
  aggregate_id: walletId,
  event_type: 'WalletBalanceChanged',
  payload: {
    eventId,
    eventType: 'WalletBalanceChanged',
    aggregateId: walletId,
    correlationId: 'provider:transaction',
    occurredAt: '2026-11-16T12:00:00.000Z',
    version: 1,
    data: { walletId, money: { amount: '25.00', currency: 'BRL' } },
  },
  occurred_at: new Date('2026-11-16T12:00:00.000Z'),
  attempts: 0,
  claimToken: 'test:claim',
});
describe('transactional outbox publisher', () => {
  it('serializes a versioned event with stable per-wallet FIFO group and eventId dedup', () => {
    const cmd = eventMessage(event(), 'https://sqs/wager-events.fifo');
    expect(cmd).toBeInstanceOf(SendMessageCommand);
    expect(cmd.input.MessageGroupId).toBe(walletId);
    expect(cmd.input.MessageDeduplicationId).toBe(eventId);
    expect(JSON.parse(cmd.input.MessageBody ?? '')).toEqual(event().payload);
    expect(OUTBOX_LEASE_SECONDS).toBeGreaterThan(0);
  });

  function fake(sender: (cmd: SendMessageCommand) => Promise<unknown>, rows = [event()]) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      fork: () => ({
        execute: (sql: string, params: unknown[], mode?: string): Promise<unknown> => {
          queries.push({ sql, params });
          if (sql.startsWith('with due')) return Promise.resolve(rows);
          if (mode === 'run') return Promise.resolve({ affectedRows: 1 });
          return Promise.resolve([]);
        },
      }),
    };
    const messages: SendMessageCommand[] = [];
    const sqs = {
      send: (command: SendMessageCommand) => {
        messages.push(command);
        return sender(command);
      },
    };
    return {
      publisher: new OutboxPublisher(db as never, sqs as never, 'events'),
      queries,
      messages,
    };
  }

  it('claims events using SKIP LOCKED without holding a transaction over SQS', async () => {
    const { publisher, queries } = fake(() => Promise.resolve({}));
    expect(await publisher.claim()).toHaveLength(1);
    expect(queries[0]?.sql).toContain('for update of o skip locked');
    expect(queries[0]?.sql).toContain('not exists');
    expect(queries[0]?.sql).toContain('older.publication_sequence < o.publication_sequence');
    expect(queries[0]?.sql).toContain('order by o.publication_sequence');
    expect(queries[0]?.sql).toContain('claim_expires_at');
  });

  it('publishes, ACKs a fenced claim and stops retrying after a confirmed SQS send', async () => {
    const { publisher, queries, messages } = fake(() => Promise.resolve({}));
    expect(await publisher.publish(event())).toBe(true);
    expect(messages).toHaveLength(1);
    expect(queries[0]?.sql).toContain('published_at=greatest');
    expect(queries[0]?.params).toEqual([eventId, 'test:claim']);
  });

  it('retains a failed event with bounded exponential next attempt and releases its claim', async () => {
    const { publisher, queries } = fake(() => Promise.reject(new Error('SQS unavailable')));
    expect(await publisher.publish(event())).toBe(false);
    expect(queries[0]?.sql).toContain('set attempts=');
    expect(queries[0]?.params?.[0]).toBe(1);
    expect(queries[0]?.params?.[2]).toBe(eventId);
  });

  it('runs a cycle and releases unstarted claims during shutdown', async () => {
    const { publisher, queries, messages } = fake(() => Promise.resolve({}));
    const controller = new AbortController();
    controller.abort();
    expect(await publisher.runOnce(controller.signal)).toEqual({
      claimed: 1,
      published: 0,
      retried: 0,
    });
    expect(messages).toHaveLength(0);
    expect(queries.some((x) => x.sql.includes('claimed_by=null'))).toBe(true);
  });

  it('validates batch size and does not claim more than fifty in one database query', async () => {
    const { publisher } = fake(() => Promise.resolve({}));
    let caught: unknown;
    try {
      await publisher.claim(51);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((await publisher.claim(1)).length).toBe(1);
  });
  it('fences an expired outbox owner even when its SQS send succeeds', async () => {
    const db = {
      fork: () => ({ execute: () => Promise.resolve({ affectedRows: 0 }) }),
    };
    const sent: SendMessageCommand[] = [];
    const sqs = {
      send: (command: SendMessageCommand): Promise<unknown> => {
        sent.push(command);
        return Promise.resolve({});
      },
    };
    const publisher = new OutboxPublisher(db as never, sqs as never, 'events');
    expect(await publisher.publish(event())).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input.MessageDeduplicationId).toBe(eventId);
  });

  it('retains the event if SQS accepts it but marking published fails', async () => {
    const updates: string[] = [];
    const db = {
      fork: () => ({
        execute: (sql: string): Promise<unknown> => {
          updates.push(sql);
          if (sql.includes('set published_at=')) {
            return Promise.reject(new Error('PostgreSQL interrupted after SQS send'));
          }
          return Promise.resolve({ affectedRows: 1 });
        },
      }),
    };
    const sqs = { send: () => Promise.resolve({}) };
    const publisher = new OutboxPublisher(db as never, sqs as never, 'events');
    expect(await publisher.publish(event())).toBe(false);
    expect(updates.some((sql) => sql.includes('set attempts='))).toBe(true);
  });

  it('ends its polling loop after SIGTERM without claiming another event', async () => {
    const { publisher } = fake(() => Promise.resolve({}), []);
    const controller = new AbortController();
    let cycles = 0;
    publisher.runOnce = () => {
      cycles++;
      controller.abort();
      return Promise.resolve({ claimed: 0, published: 0, retried: 0 });
    };
    await publisher.run(controller.signal, 1);
    expect(cycles).toBe(1);
  });

  it('survives a publish-cycle failure and stops on SIGTERM', async () => {
    const { publisher } = fake(() => Promise.resolve({}), []);
    const controller = new AbortController();
    let cycles = 0;
    publisher.runOnce = () => {
      cycles++;
      controller.abort();
      return Promise.reject(new Error('PostgreSQL temporarily unavailable'));
    };
    await publisher.run(controller.signal, 1);
    expect(cycles).toBe(1);
  });
});
