import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';

let orm: MikroORM;
beforeAll(async () => {
  orm = await MikroORM.init(config);
});
afterAll(async () => {
  await orm.close(true);
});

async function statement(sql: string): Promise<void> {
  await orm.em.execute(sql);
}
async function fails(sql: string): Promise<void> {
  let failed = false;
  try {
    await statement(sql);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}
async function setup(): Promise<{ wallet: string; player: string }> {
  const wallet = randomUUID();
  const player = randomUUID();
  await statement(`insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
    values ('${wallet}', '${player}', 'BRL', 0.00, 1, now(), now())`);
  return { wallet, player };
}
async function insertWager(
  ctx: { wallet: string; player: string },
  external: string,
  kind: string,
  status: string,
  reference?: string,
  errorCode?: string,
): Promise<void> {
  const id = randomUUID();
  await statement(`
    insert into wager_transactions(
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, status, failure_code, created_at,
      reference_next_attempt_at, reference_expires_at, processed_at
    ) values(
      '${id}', 'provider', '${external}', '${id}', 'hash',
      '${ctx.wallet}', '${ctx.player}', 'round', 'game', '${kind}', 25.00, 'BRL',
      ${reference ? `'${reference}'` : 'null'}, '${status}',
      ${errorCode ? `'${errorCode}'` : 'null'}, now(),
      ${status === 'PENDING_REFERENCE' ? 'now()' : 'null'},
      ${status === 'PENDING_REFERENCE' ? "now() + interval '24 hours'" : 'null'},
      ${status === 'PROCESSED' ? 'now()' : 'null'}
    )
  `);
}

describe('Section 7 database constraints', () => {
  it('blocks cross-kind duplicate active reversals, but permits a corrected attempt after rejection', async () => {
    const ctx = await setup();
    await insertWager(ctx, 'refund-a', 'REFUND', 'PENDING_REFERENCE', 'bet-ext');
    await fails(`insert into wager_transactions(
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, status, created_at
    ) values ('${randomUUID()}', 'provider', 'rollback-b', '${randomUUID()}',
      'hash', '${ctx.wallet}', '${ctx.player}', 'round', 'game',
      'ROLLBACK', 25.00, 'BRL', 'bet-ext', 'PENDING', now())`);
    await statement(`update wager_transactions
      set status='REJECTED', failure_code='REFERENCE_NOT_FOUND'
      where external_transaction_id='refund-a' and provider_id='provider'`);
    await insertWager(ctx, 'refund-fixed', 'REFUND', 'PENDING_REFERENCE', 'bet-ext');
    const rows = await orm.em.execute<Array<{ count: string }>>(
      "select count(*)::text as count from wager_transactions where provider_id='provider' and reference_external_transaction_id='bet-ext'",
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('requires durable retry metadata for PENDING_REFERENCE and rejects invalid retry counters', async () => {
    const ctx = await setup();
    await fails(`insert into wager_transactions(
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, status, created_at
    ) values ('${randomUUID()}', 'provider', '${randomUUID()}', '${randomUUID()}',
      'hash', '${ctx.wallet}', '${ctx.player}', 'round', 'game',
      'REFUND', 25.00, 'BRL', 'bet-ext', 'PENDING_REFERENCE', now())`);
    await insertWager(ctx, 'retry-ref', 'REFUND', 'PENDING_REFERENCE', 'missing');
    await fails(`update wager_transactions set reference_retry_attempts=-1
      where external_transaction_id='retry-ref'`);
  });
});
