import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';

let orm: MikroORM;

async function sql(query: string): Promise<void> {
  await orm.em.getConnection().execute(query);
}

/** Bun's matcher is not a thenable; explicitly await the rejected SQL operation. */
async function expectSqlFailure(query: string): Promise<void> {
  let caught: unknown;
  try {
    await sql(query);
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
}

async function createOpeningWallet(): Promise<{
  walletId: string;
  playerId: string;
  transactionId: string;
}> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const transactionId = randomUUID();
  const ledgerId = randomUUID();
  // One SQL statement/transaction: deferred consistency checks see the complete opening.
  await sql(`
    do $block$
    begin
      insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
      values ('${walletId}', '${playerId}', 'BRL', 100.00, 1, now(), now());

      insert into wager_transactions(
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        status, created_at, processed_at
      ) values (
        '${transactionId}', 'internal', '${transactionId}', 'opening:${transactionId}',
        'hash-opening', '${walletId}', '${playerId}', 'opening', 'internal',
        'OPENING', 100.00, 'BRL', 'PROCESSED', now(), now()
      );

      insert into wallet_ledger_entries(
        id, wallet_id, transaction_id, wallet_version, direction,
        amount, currency, balance_before, balance_after, created_at
      ) values (
        '${ledgerId}', '${walletId}', '${transactionId}', 1, 'CREDIT',
        100.00, 'BRL', 0.00, 100.00, now()
      );
    end
    $block$;
  `);
  return { walletId, playerId, transactionId };
}

beforeAll(async () => {
  orm = await MikroORM.init(config);
});

afterAll(async () => {
  await orm.close(true);
});

describe('PostgreSQL financial invariants (actual database)', () => {
  it('requires a ledger opening when a wallet starts with positive balance', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    await expectSqlFailure(`
        insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
        values ('${walletId}', '${playerId}', 'BRL', 100.00, 1, now(), now())
      `);
    const opened = await createOpeningWallet();
    expect(opened.walletId.length).toBeGreaterThan(0);
  });

  it('enforces one wallet per player and currency and prohibits negative balances', async () => {
    const { playerId } = await createOpeningWallet();
    await expectSqlFailure(`
        insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
        values ('${randomUUID()}', '${playerId}', 'BRL', 0.00, 1, now(), now())
      `);
    await expectSqlFailure(`
        insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
        values ('${randomUUID()}', '${randomUUID()}', 'BRL', -0.01, 1, now(), now())
      `);
  });

  it('rejects a balance write without ledger, lost-version update and currency mutation', async () => {
    const { walletId } = await createOpeningWallet();
    await expectSqlFailure(`update wallets set balance = 99.00 where id = '${walletId}'`);
    await expectSqlFailure(
      `update wallets set balance = 99.00, version = 2 where id = '${walletId}'`,
    );
    await expectSqlFailure(`update wallets set currency = 'USD' where id = '${walletId}'`);
  });

  it('enforces append-only ledger against UPDATE and DELETE', async () => {
    const { walletId } = await createOpeningWallet();
    await expectSqlFailure(
      `update wallet_ledger_entries set amount = 2.00 where wallet_id = '${walletId}'`,
    );
    await expectSqlFailure(`delete from wallet_ledger_entries where wallet_id = '${walletId}'`);
  });

  it('enforces transactional idempotency keys, external ids and terminal statuses', async () => {
    const { walletId, playerId, transactionId } = await createOpeningWallet();
    await expectSqlFailure(`
        insert into wager_transactions(
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          status, created_at, processed_at
        ) values (
          '${randomUUID()}', 'provider-x', 'ext-2', 'opening:${transactionId}', 'hash',
          '${walletId}', '${playerId}', 'round', 'game', 'BET', 1.00, 'BRL',
          'PENDING', now(), null
        )
      `);
    await expectSqlFailure(
      `update wager_transactions set status = 'REJECTED', failure_code = 'TEST', processed_at = null where id = '${transactionId}'`,
    );
  });

  it('enforces inbox uniqueness without in-memory deduplication', async () => {
    const consumer = 'consumer-test-' + randomUUID();
    const messageId = 'msg-1';
    await sql(`insert into inbox_messages(consumer_name, message_id, payload_hash, received_at)
      values ('${consumer}', '${messageId}', 'hash-1', now())`);
    await expectSqlFailure(`insert into inbox_messages(consumer_name, message_id, payload_hash, received_at)
        values ('${consumer}', '${messageId}', 'hash-2', now())`);
  });

  it('ensures outbox payload is immutable and publication progress cannot move backwards', async () => {
    const { walletId } = await createOpeningWallet();
    const eventId = randomUUID();
    const payload = JSON.stringify({
      eventId,
      aggregateId: walletId,
      eventType: 'WalletBalanceChanged',
      correlationId: 'command1',
      occurredAt: new Date().toISOString(),
      version: 1,
      data: {},
    });
    await sql(`insert into outbox_messages(id, aggregate_id, event_type, payload, occurred_at)
      values ('${eventId}', '${walletId}', 'WalletBalanceChanged', '${payload}'::jsonb, now())`);
    await expectSqlFailure(
      `update outbox_messages set payload = '{}'::jsonb where id = '${eventId}'`,
    );
    await sql(`update outbox_messages set attempts = 1 where id = '${eventId}'`);
    await expectSqlFailure(`update outbox_messages set attempts = 0 where id = '${eventId}'`);
  });

  it('rejects ledger amounts that do not reconcile to their balanceBefore/After', async () => {
    const { walletId, transactionId } = await createOpeningWallet();
    await expectSqlFailure(`
      insert into wallet_ledger_entries(
        id, wallet_id, transaction_id, wallet_version, direction,
        amount, currency, balance_before, balance_after, created_at
      ) values (
        '${randomUUID()}', '${walletId}', '${transactionId}', 2,
        'DEBIT', 50.00, 'BRL', 100.00, 80.00, now()
      )
    `);
  });
  it('prevents deleting financial decisions, inbox identities and unpublished outbox events', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const txId = randomUUID();
    const eventId = randomUUID();
    const consumerId = 'durable-' + randomUUID();
    await sql(`insert into wallets(id,player_id,currency,balance,version,created_at,updated_at)
      values ('${walletId}','${playerId}','BRL',0.00,1,now(),now())`);
    await sql(`insert into wager_transactions(
        id,provider_id,external_transaction_id,idempotency_key,payload_hash,
        wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,processed_at
      ) values (
        '${txId}','provider-a','${txId}','${txId}','unique-hash',
        '${walletId}','${playerId}','round','game','LOSS',1.00,'BRL',
        'PROCESSED',now(),now()
      )`);
    const envelope = JSON.stringify({
      eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId: walletId,
      correlationId: txId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: { transactionId: txId, walletId },
    });
    await sql(`insert into outbox_messages(id,aggregate_id,event_type,payload,occurred_at)
      values ('${eventId}','${walletId}','WagerTransactionProcessed',
        '${envelope}'::jsonb,now())`);
    await sql(`insert into inbox_messages(consumer_name,message_id,payload_hash,received_at,processed_at)
      values ('${consumerId}','${txId}','hash',now(),now())`);

    // LOSS is terminal but has no ledger FK: only the audit trigger can block deletion.
    await expectSqlFailure(`delete from wager_transactions where id='${txId}'`);
    await expectSqlFailure(`delete from inbox_messages where consumer_name='${consumerId}'`);
    await expectSqlFailure(`delete from outbox_messages where id='${eventId}'`);
    await expectSqlFailure('truncate inbox_messages');
    await expectSqlFailure('truncate outbox_messages');
    const [record] = await orm.em.execute<Array<{ events: number; tx: number; inbox: number }>>(
      `select
       (select count(*)::integer from outbox_messages where id=?::uuid) as events,
       (select count(*)::integer from wager_transactions where id=?::uuid) as tx,
       (select count(*)::integer from inbox_messages where consumer_name=?) as inbox`,
      [eventId, txId, consumerId],
    );
    expect(record).toEqual({ events: 1, tx: 1, inbox: 1 });
  });
});
