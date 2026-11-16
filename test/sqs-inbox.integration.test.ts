import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';
import {
  InboxPayloadConflictError, ProcessWager, IdempotencyConflictError,
} from '../src/application/process-wager.js';
import { WalletService } from '../src/http/wallet.service.js';
import type { WagerCommand } from '../src/application/wager-contracts.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../src/domain/wager-transaction.js';

let orm: MikroORM;
let processor: ProcessWager;
beforeAll(async () => {
  orm = await MikroORM.init(config);
  processor = new ProcessWager(orm.em);
});
afterAll(async () => { await orm.close(true); });

async function wallet(initial = '100.00') {
  const playerId = randomUUID();
  const opened = await new WalletService(orm.em).create(
    playerId, { amount: initial, currency: 'BRL' },
  );
  return { walletId: opened.id, playerId };
}
function command(w: { walletId: string; playerId: string }, kind = Kind.Bet): WagerCommand {
  const externalTransactionId = randomUUID();
  return {
    providerId: 'provider-a', externalTransactionId,
    idempotencyKey: 'provider-a:' + externalTransactionId,
    walletId: w.walletId, playerId: w.playerId, roundId: 'round1', gameId: 'game1',
    kind, money: { amount: '25.00', currency: 'BRL' },
  };
}
const receipt = (id = randomUUID(), payloadHash = 'business-envelope-hash') => ({
  messageId: id, consumerName: 'wager-request-consumer', payloadHash,
});
async function count(table: 'inbox_messages' | 'wager_transactions' | 'wallet_ledger_entries' | 'outbox_messages', walletId: string): Promise<number> {
  const query = table === 'inbox_messages'
    ? `select count(*)::integer as n from inbox_messages where consumer_name='wager-request-consumer' and message_id in
      (select message_id from inbox_messages where consumer_name='wager-request-consumer')`
    : `select count(*)::integer as n from ${table} where ${table === 'outbox_messages' ? 'aggregate_id' : 'wallet_id'}=?::uuid`;
  const [row] = await orm.em.execute<Array<{ n: number }>>(query, table === 'inbox_messages' ? [] : [walletId]);
  return row?.n ?? 0;
}
async function inbox(messageId: string) {
  const [row] = await orm.em.execute<Array<{ payload_hash: string; processed_at: Date | null }>>(
    `select payload_hash, processed_at from inbox_messages
     where consumer_name='wager-request-consumer' and message_id=?`,
    [messageId],
  );
  return row;
}

describe('SQS Inbox + wager + ledger + outbox atomic commit', () => {
  it('persists all business side effects and processed Inbox together', async () => {
    const w = await wallet();
    const wager = command(w);
    const metadata = receipt();
    const result = await processor.processFromInbox(wager, metadata);
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe('75.00');
    expect((await inbox(metadata.messageId))?.processed_at).toBeInstanceOf(Date);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(2);
    expect(await count('outbox_messages', w.walletId)).toBe(2);
  });
  it('redelivers the same message concurrently with no duplicate debit, outbox or inbox', async () => {
    const w = await wallet();
    const wager = command(w);
    const metadata = receipt();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => processor.processFromInbox(wager, metadata)),
    );
    const first = results[0];
    expect(first).toBeDefined();
    for (const replay of results) expect(replay).toEqual(first);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(2);
    expect(await count('outbox_messages', w.walletId)).toBe(2);
    expect((await inbox(metadata.messageId))?.payload_hash).toBe(metadata.payloadHash);
  });
  it('records a new Inbox delivery for a different SQS message id but replays one financial identity', async () => {
    const w = await wallet();
    const wager = command(w);
    const first = receipt();
    const second = receipt();
    const original = await processor.processFromInbox(wager, first);
    expect(await processor.processFromInbox(wager, second)).toEqual(original);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(2);
    expect(await count('outbox_messages', w.walletId)).toBe(2);
    expect((await inbox(first.messageId))?.processed_at).toBeInstanceOf(Date);
    expect((await inbox(second.messageId))?.processed_at).toBeInstanceOf(Date);
  });
  it('rejects a reused inbox identity with altered envelope and does not change balances', async () => {
    const w = await wallet();
    const wager = command(w);
    const original = receipt();
    await processor.processFromInbox(wager, original);
    let failure: unknown;
    try {
      await processor.processFromInbox(wager, { ...original, payloadHash: 'tampered' });
    } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(InboxPayloadConflictError);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(2);
  });
  it('rolls back a newly claimed Inbox identity on idempotency conflict', async () => {
    const w = await wallet();
    const wager = command(w);
    await processor.processFromInbox(wager, receipt());
    const again = receipt();
    let failure: unknown;
    try {
      await processor.processFromInbox({ ...wager, money: { amount: '1.00', currency: 'BRL' } }, again);
    } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(IdempotencyConflictError);
    expect(await inbox(again.messageId)).toBeUndefined();
    expect(await count('outbox_messages', w.walletId)).toBe(2);
  });
  it('commits a business REJECTED + Inbox + rejected event with no ledger debit', async () => {
    const w = await wallet('0.00');
    const data = receipt();
    const rejected = await processor.processFromInbox(command(w), data);
    expect(rejected.status).toBe(Status.Rejected);
    expect((await inbox(data.messageId))?.processed_at).toBeInstanceOf(Date);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(0);
    expect(await count('outbox_messages', w.walletId)).toBe(1);
  });
  it('rolls back Inbox + wager + outbox when a financial calculation overflows after inbox reservation', async () => {
    const w = await wallet('999999999999999999.99');
    const metadata = receipt();
    let failure: unknown;
    try {
      await processor.processFromInbox(command(w, Kind.Win), metadata);
    } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(await inbox(metadata.messageId)).toBeUndefined();
    expect(await count('outbox_messages', w.walletId)).toBe(0);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(1);
    const [row] = await orm.em.execute<Array<{ balance: string }>>(
      'select balance::text as balance from wallets where id=?::uuid', [w.walletId],
    );
    expect(row?.balance).toBe('999999999999999999.99');
  });
  it('commits PENDING_REFERENCE + Inbox + pending event without any ledger movement', async () => {
    const w = await wallet();
    const refunded = command(w, Kind.Refund);
    const meta = receipt();
    const pending = await processor.processFromInbox({
      ...refunded, referenceExternalTransactionId: 'absent-bet',
    }, meta);
    expect(pending.status).toBe(Status.PendingReference);
    expect((await inbox(meta.messageId))?.processed_at).toBeInstanceOf(Date);
    expect(await count('wallet_ledger_entries', w.walletId)).toBe(1);
    expect(await count('outbox_messages', w.walletId)).toBe(1);
  });
});
