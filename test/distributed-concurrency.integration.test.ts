import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';
import type { WagerCommand, WagerResult } from '../src/application/wager-contracts.js';
import {
  FailureCode,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../src/domain/wager-transaction.js';
import { WagerChild } from './support/wager-child.js';

interface WalletFixture { readonly walletId: string; readonly playerId: string }
let orm: MikroORM;
let workers: WagerChild[];

beforeAll(async () => {
  orm = await MikroORM.init({ ...config, pool: { min: 0, max: 4 } });
  workers = await Promise.all([WagerChild.start(), WagerChild.start(), WagerChild.start()]);
});
afterAll(async () => {
  await Promise.all(workers.map(worker => worker.stop()));
  await orm.close(true);
});

async function openWallet(amount = '100.00'): Promise<WalletFixture> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  if (amount === '0.00') {
    await orm.em.execute(
      `insert into wallets(id,player_id,currency,balance,version,created_at,updated_at)
       values(?::uuid,?::uuid,'BRL',0,1,now(),now())`,
      [walletId, playerId],
    );
  } else {
    const transactionId = randomUUID();
    const ledgerId = randomUUID();
    await orm.em.execute(`
      do $block$ begin
        insert into wallets(id,player_id,currency,balance,version,created_at,updated_at)
        values('${walletId}','${playerId}','BRL',${amount},1,now(),now());
        insert into wager_transactions(
          id,provider_id,external_transaction_id,idempotency_key,payload_hash,
          wallet_id,player_id,round_id,game_id,kind,amount,currency,
          status,created_at,processed_at
        ) values(
          '${transactionId}','internal','${transactionId}','opening:${transactionId}',
          'opening-hash','${walletId}','${playerId}','opening','internal','OPENING',
          ${amount},'BRL','PROCESSED',now(),now()
        );
        insert into wallet_ledger_entries(
          id,wallet_id,transaction_id,wallet_version,direction,amount,currency,
          balance_before,balance_after,created_at
        ) values(
          '${ledgerId}','${walletId}','${transactionId}',1,'CREDIT',
          ${amount},'BRL',0,${amount},now()
        );
      end $block$;
    `);
  }
  return { walletId, playerId };
}

function wager(
  wallet: WalletFixture,
  kind: Exclude<Kind, Kind.Opening>,
  amount = '80.00',
  overrides: Partial<WagerCommand> = {},
): WagerCommand {
  const externalTransactionId = randomUUID();
  return {
    providerId: 'provider-' + wallet.walletId,
    externalTransactionId,
    idempotencyKey: 'request-' + externalTransactionId,
    walletId: wallet.walletId,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

async function ledgerDebits(walletId: string): Promise<number> {
  const [row] = await orm.em.execute<Array<{ amount: string }>>(
    `select count(*)::text as amount from wallet_ledger_entries
     where wallet_id=?::uuid and direction='DEBIT'`,
    [walletId],
  );
  return Number(row?.amount ?? 0);
}

async function state(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await orm.em.execute<Array<{ balance: string; version: number }>>(
    'select balance::text as balance, version from wallets where id=?::uuid',
    [walletId],
  );
  if (!row) throw new Error('Missing wallet in test');
  return row;
}

async function countOutbox(walletId: string): Promise<number> {
  const [row] = await orm.em.execute<Array<{ amount: string }>>(
    'select count(*)::text as amount from outbox_messages where aggregate_id=?::uuid',
    [walletId],
  );
  return Number(row?.amount ?? 0);
}

describe('section 8 — independent Bun processes, shared PostgreSQL', () => {
  it('allows exactly one of two concurrent 80.00 BETs and rejects the other, across three workers', async () => {
    const w = await openWallet();
    const [first, second, loss] = await Promise.all([
      workers[0]!.process(wager(w, Kind.Bet)),
      workers[1]!.process(wager(w, Kind.Bet)),
      workers[2]!.process(wager(w, Kind.Loss)),
    ]);
    const bets = [first, second];
    expect(bets.filter(x => x.status === Status.Processed)).toHaveLength(1);
    expect(bets.filter(x => x.status === Status.Rejected)).toHaveLength(1);
    expect(bets.find(x => x.status === Status.Rejected)?.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
    expect(loss.status).toBe(Status.Processed);
    expect(await state(w.walletId)).toEqual({ balance: '20.00', version: 2 });
    expect(await ledgerDebits(w.walletId)).toBe(1);
    expect(await countOutbox(w.walletId)).toBe(4);
  }, 60_000);

  it('deduplicates 50 identical BETs spread across three independent processes', async () => {
    const w = await openWallet();
    const command = wager(w, Kind.Bet);
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      workers[i % workers.length]!.process(command),
    ));
    const original = responses[0];
    if (!original) throw new Error('No response from workers');
    for (const response of responses) expect(response).toEqual(original);
    expect(original.status).toBe(Status.Processed);
    expect(await state(w.walletId)).toEqual({ balance: '20.00', version: 2 });
    expect(await ledgerDebits(w.walletId)).toBe(1);
    expect(await countOutbox(w.walletId)).toBe(2);
    const replay = await workers[2]!.process(command);
    expect(replay).toEqual(original);
    expect(await ledgerDebits(w.walletId)).toBe(1);
  }, 90_000);

  it('does not globally block unrelated wallets while another wallet lock is held', async () => {
    const a = await openWallet();
    const b = await openWallet();
    const c = await openWallet();
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { acquired = resolve; });
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const holding = orm.em.fork().transactional(async em => {
      await em.execute('select id from wallets where id=?::uuid for update', [a.walletId]);
      acquired();
      await unlocked;
    });
    await locked;
    let blocked: Promise<WagerResult> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      blocked = workers[0]!.process(wager(a, Kind.Bet, '1.00'));
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Unrelated wallets blocked by wallet A')), 8_000);
      });
      const [second, third] = await Promise.race([
        Promise.all([
          workers[1]!.process(wager(b, Kind.Bet, '1.00')),
          workers[2]!.process(wager(c, Kind.Bet, '1.00')),
        ]),
        timeout,
      ]);
      expect(second.status).toBe(Status.Processed);
      expect(third.status).toBe(Status.Processed);
      expect(await state(b.walletId)).toEqual({ balance: '99.00', version: 2 });
      expect(await state(c.walletId)).toEqual({ balance: '99.00', version: 2 });
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await holding;
      if (blocked) expect((await blocked).status).toBe(Status.Processed);
    }
    expect(await state(a.walletId)).toEqual({ balance: '99.00', version: 2 });
  }, 60_000);

  it('lets only one of three reference workers perform a pending REFUND', async () => {
    const w = await openWallet();
    const bet = wager(w, Kind.Bet, '25.00');
    const refund = wager(w, Kind.Refund, '25.00', {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await workers[0]!.process(refund);
    expect(pending.status).toBe(Status.PendingReference);
    expect((await workers[1]!.process(bet)).status).toBe(Status.Processed);
    await orm.em.execute(
      'update wager_transactions set reference_next_attempt_at=clock_timestamp() where id=?::uuid',
      [pending.transactionId],
    );
    const results = await Promise.all(workers.map(worker =>
      worker.retry(pending.transactionId, w.walletId),
    ));
    expect(results.filter(result => result?.status === Status.Processed)).toHaveLength(1);
    expect(results.filter(result => result === null)).toHaveLength(2);
    expect(await state(w.walletId)).toEqual({ balance: '100.00', version: 3 });
    expect(await ledgerDebits(w.walletId)).toBe(1);
    expect(await countOutbox(w.walletId)).toBe(5);
    const applied = results.find(result => result?.status === Status.Processed);
    if (!applied) throw new Error('Expected the pending refund to be applied');
    expect(await workers[2]!.process(refund)).toEqual(applied);
  }, 60_000);
});
