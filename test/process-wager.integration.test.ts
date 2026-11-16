import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';
import { ProcessWager, IdempotencyConflictError } from '../src/application/process-wager.js';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../src/domain/wager-transaction.js';
import type { WagerCommand } from '../src/application/wager-contracts.js';

let orm: MikroORM;
let processor: ProcessWager;

beforeAll(async () => {
  orm = await MikroORM.init(config);
  processor = new ProcessWager(orm.em);
});
afterAll(async () => {
  await orm.close(true);
});

async function opening(amount = '100.00'): Promise<{ walletId: string; playerId: string }> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const txId = randomUUID();
  const ledgerId = randomUUID();
  if (amount === '0.00') {
    await orm.em.execute(
      `
      insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
      values(?::uuid, ?::uuid, 'BRL', 0, 1, now(), now())
    `,
      [walletId, playerId],
    );
  } else {
    await orm.em.execute(`
      do $block$ begin
        insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
        values ('${walletId}', '${playerId}', 'BRL', ${amount}, 1, now(), now());

        insert into wager_transactions(
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          status, created_at, processed_at
        ) values (
          '${txId}', 'internal', '${txId}', 'opening:${txId}', 'opening-hash',
          '${walletId}', '${playerId}', 'opening', 'internal', 'OPENING', ${amount}, 'BRL',
          'PROCESSED', now(), now()
        );

        insert into wallet_ledger_entries(
          id, wallet_id, transaction_id, wallet_version, direction,
          amount, currency, balance_before, balance_after, created_at
        ) values (
          '${ledgerId}', '${walletId}', '${txId}', 1, 'CREDIT', ${amount}, 'BRL',
          0, ${amount}, now()
        );
      end $block$;
    `);
  }
  return { walletId, playerId };
}
function wager(
  wallet: { walletId: string; playerId: string },
  kind: Exclude<Kind, Kind.Opening>,
  overrides: Partial<WagerCommand> = {},
): WagerCommand {
  const externalTransactionId = randomUUID();
  return {
    providerId: 'provider-' + wallet.walletId,
    externalTransactionId,
    idempotencyKey: 'idempotency-' + externalTransactionId,
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    roundId: 'round1',
    gameId: 'game1',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}
async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await orm.em.execute<Array<{ count: string }>>(sql, params);
  return Number(row?.count ?? '0');
}
async function balance(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await orm.em.execute<Array<{ balance: string; version: number }>>(
    'select balance::text as balance, version from wallets where id=?::uuid',
    [walletId],
  );
  if (!row) throw new Error('Missing test wallet');
  return row;
}

describe('section 7 — transactional business rules with PostgreSQL', () => {
  it('BET debits once and replays the historical result after another movement', async () => {
    const wallet = await opening();
    const original = wager(wallet, Kind.Bet);
    const first = await processor.process(original);
    expect(first.status).toBe(Status.Processed);
    expect(first.balance.amount).toBe('75.00');
    expect(first.walletVersion).toBe(2);

    await processor.process(wager(wallet, Kind.Win));
    const replay = await processor.process(original);
    expect(replay).toEqual(first);
    expect((await balance(wallet.walletId)).balance).toBe('100.00');
    expect(
      await count(
        'select count(*)::text as count from wallet_ledger_entries where wallet_id=?::uuid',
        [wallet.walletId],
      ),
    ).toBe(3);
    expect(
      await count(
        'select count(*)::text as count from outbox_messages where aggregate_id=?::uuid',
        [wallet.walletId],
      ),
    ).toBe(4);
  });

  it('BET with insufficient funds records REJECTED and outbox, without moving saldo', async () => {
    const wallet = await opening('0.00');
    const result = await processor.process(wager(wallet, Kind.Bet));
    expect(result.status).toBe(Status.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.walletVersion).toBe(1);
    expect((await balance(wallet.walletId)).balance).toBe('0.00');
    expect(
      await count(
        'select count(*)::text as count from wallet_ledger_entries where wallet_id=?::uuid',
        [wallet.walletId],
      ),
    ).toBe(0);
    expect(
      await count(
        'select count(*)::text as count from outbox_messages where aggregate_id=?::uuid',
        [wallet.walletId],
      ),
    ).toBe(1);
  });

  it('LOSS records PROCESSED without ledger, wallet balance or version changes', async () => {
    const wallet = await opening();
    const result = await processor.process(wager(wallet, Kind.Loss));
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('100.00');
    expect(result.walletVersion).toBe(1);
    expect(
      await count(
        'select count(*)::text as count from wallet_ledger_entries where wallet_id=?::uuid',
        [wallet.walletId],
      ),
    ).toBe(1);
  });

  it('REFUND credits a processed BET and blocks cross-kind ROLLBACK of the same BET', async () => {
    const wallet = await opening();
    const bet = wager(wallet, Kind.Bet);
    await processor.process(bet);
    const refund = wager(wallet, Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const returned = await processor.process(refund);
    expect(returned.status).toBe(Status.Processed);
    expect(returned.balance.amount).toBe('100.00');

    const reversedAgain = await processor.process(
      wager(wallet, Kind.Rollback, {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(reversedAgain.status).toBe(Status.Rejected);
    expect(reversedAgain.failureCode).toBe(FailureCode.AlreadyReversed);
    expect((await balance(wallet.walletId)).balance).toBe('100.00');
    expect(await processor.process(refund)).toEqual(returned);
  });

  it('ROLLBACK WIN debits, but rejects with a distinct code when funds are insufficient', async () => {
    const wallet = await opening('0.00');
    const win = wager(wallet, Kind.Win);
    await processor.process(win);
    const rollback = wager(wallet, Kind.Rollback, {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect((await processor.process(rollback)).balance.amount).toBe('0.00');

    const wallet2 = await opening('0.00');
    const win2 = wager(wallet2, Kind.Win);
    await processor.process(win2);
    await processor.process(wager(wallet2, Kind.Bet));
    const rejected = await processor.process(
      wager(wallet2, Kind.Rollback, {
        referenceExternalTransactionId: win2.externalTransactionId,
      }),
    );
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect((await balance(wallet2.walletId)).balance).toBe('0.00');
  });

  it('rejects a conflicting idempotency payload instead of applying it', async () => {
    const wallet = await opening();
    const command = wager(wallet, Kind.Bet);
    await processor.process(command);
    let error: unknown;
    try {
      await processor.process({ ...command, money: { amount: '24.00', currency: 'BRL' } });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((await balance(wallet.walletId)).balance).toBe('75.00');
  });

  it('persists out-of-order REFUND and reprocesses it when the BET arrives', async () => {
    const wallet = await opening();
    const bet = wager(wallet, Kind.Bet);
    const refund = wager(wallet, Kind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await processor.process(refund);
    expect(pending.status).toBe(Status.PendingReference);
    expect(pending.walletVersion).toBe(1);
    await processor.process(bet);
    await orm.em.execute(
      `update wager_transactions
      set reference_next_attempt_at=clock_timestamp()
      where id=?::uuid`,
      [pending.transactionId],
    );
    const due = await processor.dueReferences();
    expect(due.some((item) => item.id === pending.transactionId)).toBe(true);
    const result = await processor.retryPending(pending.transactionId, wallet.walletId);
    expect(result?.status).toBe(Status.Processed);
    expect(result?.balance.amount).toBe('100.00');
    if (!result) throw new Error('Reference retry did not complete');
    expect(await processor.process(refund)).toEqual(result);
  });

  it('expires absent references with REFERENCE_NOT_FOUND and a durable rejection event', async () => {
    const wallet = await opening();
    const pending = await processor.process(
      wager(wallet, Kind.Refund, {
        referenceExternalTransactionId: 'never-arrived',
      }),
    );
    await orm.em.execute(
      `update wager_transactions
      set reference_expires_at=clock_timestamp(),
          reference_next_attempt_at=clock_timestamp()
      where id=?::uuid`,
      [pending.transactionId],
    );
    const completed = await processor.retryPending(pending.transactionId, wallet.walletId);
    expect(completed?.status).toBe(Status.Rejected);
    expect(completed?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect((await balance(wallet.walletId)).balance).toBe('100.00');
    expect(
      await count(
        'select count(*)::text as count from outbox_messages where aggregate_id=?::uuid',
        [wallet.walletId],
      ),
    ).toBe(2);
  });

  it('rejects ambiguous collisions when idempotency and provider identity belong to two different transactions', async () => {
    const wallet = await opening();
    const a = wager(wallet, Kind.Loss);
    const b = wager(wallet, Kind.Loss);
    await processor.process(a);
    await processor.process(b);
    let conflict: unknown;
    try {
      await processor.process({
        ...a,
        externalTransactionId: b.externalTransactionId,
      });
    } catch (error: unknown) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(IdempotencyConflictError);
    expect(await count(
      'select count(*)::text as count from wager_transactions where wallet_id=?::uuid and kind=?',
      [wallet.walletId, Kind.Loss],
    )).toBe(2);
  });

  it('serializes fifty duplicate BET requests into one ledger entry', async () => {
    const wallet = await opening();
    const bet = wager(wallet, Kind.Bet);
    const results = await Promise.all(Array.from({ length: 50 }, () => processor.process(bet)));
    const original = results[0];
    if (!original) throw new Error('Expected a processed request');
    for (const result of results) expect(result).toEqual(original);
    expect((await balance(wallet.walletId)).balance).toBe('75.00');
    expect(
      await count(
        `select count(*)::text as count from wallet_ledger_entries
      where wallet_id=?::uuid`,
        [wallet.walletId],
      ),
    ).toBe(2);
  });

  it('lets only one concurrent BET of 80.00 debit wallet with balance 100.00', async () => {
    const wallet = await opening();
    const bet1 = wager(wallet, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } });
    const bet2 = wager(wallet, Kind.Bet, { money: { amount: '80.00', currency: 'BRL' } });
    const results = await Promise.all([processor.process(bet1), processor.process(bet2)]);
    expect(results.filter((result) => result.status === Status.Processed).length).toBe(1);
    expect(
      results.filter((result) => result.failureCode === FailureCode.InsufficientFunds).length,
    ).toBe(1);
    expect(await balance(wallet.walletId)).toEqual({ balance: '20.00', version: 2 });
  });
});
