import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';
import { ProcessWager } from '../src/application/process-wager.js';
import type { WagerCommand } from '../src/application/wager-contracts.js';
import { ReconciliationService } from '../src/http/reconciliation.service.js';
import { WalletService } from '../src/http/wallet.service.js';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../src/domain/wager-transaction.js';

interface Context {
  walletId: string;
  playerId: string;
}
interface StoredEvent {
  event_type: string;
  publication_sequence: string;
  published_at: Date | null;
  payload: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: Record<string, unknown>;
  };
}

let orm: MikroORM;
let processor: ProcessWager;
beforeAll(async () => {
  orm = await MikroORM.init(config);
  processor = new ProcessWager(orm.em);
});
afterAll(async () => {
  await orm.close(true);
});

async function wallet(amount = '100.00'): Promise<Context> {
  const playerId = randomUUID();
  const result = await new WalletService(orm.em).create(
    playerId,
    { amount, currency: 'BRL' },
    'provider-a',
  );
  return { walletId: result.id, playerId };
}
function wager(
  ctx: Context,
  kind: Exclude<Kind, Kind.Opening>,
  amount = '25.00',
  referenceExternalTransactionId?: string,
): WagerCommand {
  const externalTransactionId = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: ctx.walletId,
    playerId: ctx.playerId,
    roundId: 'event-matrix-round',
    gameId: 'event-matrix-game',
    kind,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
  };
}
async function events(walletId: string): Promise<StoredEvent[]> {
  return orm.em.execute<StoredEvent[]>(
    `select event_type,publication_sequence::text as publication_sequence,
            published_at,payload
     from outbox_messages where aggregate_id=?::uuid order by publication_sequence`,
    [walletId],
  );
}
async function assertEventMatrix(ctx: Context, types: string[]): Promise<StoredEvent[]> {
  const all = await events(ctx.walletId);
  expect(all.map((item) => item.event_type)).toEqual(types);
  expect(new Set(all.map((item) => item.payload.eventId)).size).toBe(all.length);
  const sequences = all.map((item) => BigInt(item.publication_sequence));
  expect(sequences.every((n, i) => i === 0 || n > sequences[i - 1]!)).toBe(true);
  for (const event of all) {
    expect(event.published_at).toBeNull();
    expect(event.payload.eventType).toBe(event.event_type);
    expect(event.payload.aggregateId).toBe(ctx.walletId);
    expect(event.payload.eventId).toBeTruthy();
    expect(event.payload.correlationId).toBeTruthy();
    expect(event.payload.version).toBe(1);
    expect(new Date(event.payload.occurredAt).toISOString()).toBe(event.payload.occurredAt);
    expect(event.payload.data.walletId).toBe(ctx.walletId);
    expect(JSON.stringify(event.payload)).not.toContain('idempotencyKey":');
  }
  const reconciled = await new ReconciliationService(orm.em).run(ctx.walletId);
  expect(reconciled.consistent).toBe(true);
  expect(reconciled.difference.amount).toBe('0.00');
  return all;
}

describe('real PostgreSQL event contract matrix — transaction, ledger and outbox atomicity', () => {
  for (const scenario of [
    {
      kind: Kind.Bet,
      balance: '75.00',
      direction: 'DEBIT',
      types: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    },
    {
      kind: Kind.Win,
      balance: '125.00',
      direction: 'CREDIT',
      types: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    },
    {
      kind: Kind.Loss,
      balance: '100.00',
      direction: null,
      types: ['WagerTransactionProcessed'],
    },
  ]) {
    it(`${scenario.kind} emits only its permitted versioned event types, never before commit`, async () => {
      const ctx = await wallet();
      const opening = ['WagerTransactionProcessed', 'WalletBalanceChanged'];
      const command = wager(ctx, scenario.kind);
      const result = await processor.process(command);
      expect(result.status).toBe(Status.Processed);
      expect(result.balance.amount).toBe(scenario.balance);
      expect(result.walletVersion).toBe(scenario.direction ? 2 : 1);
      const all = await assertEventMatrix(ctx, [...opening, ...scenario.types]);
      const logical = all.filter((item) => item.payload.correlationId === command.idempotencyKey);
      expect(logical.map((item) => item.event_type)).toEqual(scenario.types);
      const processed = logical[0];
      expect(processed?.payload.data.kind).toBe(scenario.kind);
      expect(processed?.payload.data.money).toEqual(command.money);
      const balanceChanged = logical[1];
      if (scenario.direction) {
        expect(balanceChanged?.payload.data.direction).toBe(scenario.direction);
        expect(balanceChanged?.payload.data.balanceAfter).toEqual({
          amount: scenario.balance,
          currency: 'BRL',
        });
        expect(balanceChanged?.payload.data.walletVersion).toBe(2);
      } else {
        expect(balanceChanged).toBeUndefined();
      }
      // Returning a historical snapshot must not duplicate *either* event.
      expect(await processor.process(command)).toEqual(result);
      expect((await events(ctx.walletId)).length).toBe(all.length);
    });
  }

  it('REFUND and ROLLBACK(REFUND) produce credits/debits once in causal sequence', async () => {
    const ctx = await wallet();
    const bet = wager(ctx, Kind.Bet);
    const refund = wager(ctx, Kind.Refund, '25.00', bet.externalTransactionId);
    const rollbackRefund = wager(ctx, Kind.Rollback, '25.00', refund.externalTransactionId);
    const first = await processor.process(bet);
    const second = await processor.process(refund);
    const third = await processor.process(rollbackRefund);
    expect([first.balance.amount, second.balance.amount, third.balance.amount]).toEqual([
      '75.00',
      '100.00',
      '75.00',
    ]);
    expect([first.status, second.status, third.status]).toEqual([
      Status.Processed,
      Status.Processed,
      Status.Processed,
    ]);
    const all = await assertEventMatrix(ctx, [
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      ...Array.from({ length: 3 }, () => [
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]).flat(),
    ]);
    const ordered = [bet, refund, rollbackRefund].map((command) =>
      all.filter((event) => event.payload.correlationId === command.idempotencyKey),
    );
    expect(ordered.map((pairs) => pairs[1]?.payload.data.direction)).toEqual([
      'DEBIT',
      'CREDIT',
      'DEBIT',
    ]);
    expect(ordered[1]?.[0]?.payload.data.referenceTransactionId).toBe(first.transactionId);
    expect(ordered[2]?.[0]?.payload.data.referenceTransactionId).toBe(second.transactionId);
    expect(await processor.process(rollbackRefund)).toEqual(third);
    expect((await events(ctx.walletId)).length).toBe(all.length);
  });

  it('insufficient funds and already-reversed operations emit REJECTED only', async () => {
    const ctx = await wallet();
    const bet = wager(ctx, Kind.Bet);
    await processor.process(bet);
    await processor.process(wager(ctx, Kind.Refund, '25.00', bet.externalTransactionId));
    const duplicate = wager(ctx, Kind.Rollback, '25.00', bet.externalTransactionId);
    const rejected = await processor.process(duplicate);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.AlreadyReversed);
    const overdraw = wager(ctx, Kind.Bet, '125.00');
    const denied = await processor.process(overdraw);
    expect(denied.status).toBe(Status.Rejected);
    expect(denied.failureCode).toBe(FailureCode.InsufficientFunds);
    const all = await assertEventMatrix(ctx, [
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionRejected',
      'WagerTransactionRejected',
    ]);
    for (const [command, failureCode] of [
      [duplicate, FailureCode.AlreadyReversed],
      [overdraw, FailureCode.InsufficientFunds],
    ] as const) {
      const related = all.filter((event) => event.payload.correlationId === command.idempotencyKey);
      expect(related).toHaveLength(1);
      expect(related[0]?.payload.data.failureCode).toBe(failureCode);
    }
  });

  it('PENDING_REFERENCE emits once, then terminal resolution emits processed + balance; replay emits nothing', async () => {
    const ctx = await wallet();
    const bet = wager(ctx, Kind.Bet);
    const refund = wager(ctx, Kind.Refund, '25.00', bet.externalTransactionId);
    const pending = await processor.process(refund);
    expect(pending.status).toBe(Status.PendingReference);
    let related = (await events(ctx.walletId)).filter(
      (event) => event.payload.correlationId === refund.idempotencyKey,
    );
    expect(related.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(related[0]?.payload.data.referenceExternalTransactionId).toBe(
      bet.externalTransactionId,
    );
    const reference = await processor.process(bet);
    expect(reference.status).toBe(Status.Processed);
    await orm.em.execute(
      'update wager_transactions set reference_next_attempt_at=clock_timestamp() where id=?::uuid',
      [pending.transactionId],
    );
    const completed = await processor.retryPending(pending.transactionId, ctx.walletId);
    expect(completed?.status).toBe(Status.Processed);
    related = (await events(ctx.walletId)).filter(
      (event) => event.payload.correlationId === refund.idempotencyKey,
    );
    expect(related.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    expect(await processor.process(refund)).toEqual(completed);
    await assertEventMatrix(ctx, [
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  it('expired PENDING_REFERENCE emits a terminal rejection but never WalletBalanceChanged', async () => {
    const ctx = await wallet();
    const refund = wager(ctx, Kind.Refund, '25.00', randomUUID());
    const pending = await processor.process(refund);
    await orm.em.execute(
      'update wager_transactions set reference_expires_at=clock_timestamp(),reference_next_attempt_at=clock_timestamp() where id=?::uuid',
      [pending.transactionId],
    );
    const rejected = await processor.retryPending(pending.transactionId, ctx.walletId);
    expect(rejected?.status).toBe(Status.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.ReferenceNotFound);
    const all = await assertEventMatrix(ctx, [
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(all[3]?.payload.data.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await processor.process(refund)).toEqual(rejected);
    expect((await events(ctx.walletId)).length).toBe(all.length);
  });
});
