import { beforeAll, afterAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';

let orm: MikroORM;
beforeAll(async () => { orm = await MikroORM.init(config); });
afterAll(async () => { await orm.close(true); });

describe('SQS Inbox and Outbox SQL invariants', () => {
  it('preserves the per-wallet unpublished-head index', async () => {
    const [index] = await orm.em.execute<Array<{ indexdef: string }>>(
      `select indexdef from pg_indexes
       where schemaname=current_schema() and indexname='outbox_wallet_pending_order_idx'`,
    );
    expect(index?.indexdef).toContain('(aggregate_id, occurred_at, id)');
    expect(index?.indexdef).toContain('published_at IS NULL');
  });
  it('rejects mutable Inbox identity, hash and processed status at database level', async () => {
    const consumer = 'inbox-guard-' + randomUUID();
    const id = randomUUID();
    await orm.em.execute(
      `insert into inbox_messages(consumer_name,message_id,payload_hash,received_at,processed_at)
       values(?,?,?,clock_timestamp(),clock_timestamp())`,
      [consumer, id, 'original-hash'],
    );
    for (const sql of [
      'update inbox_messages set payload_hash=\'mutated\' where consumer_name=? and message_id=?',
      'update inbox_messages set processed_at=null where consumer_name=? and message_id=?',
    ]) {
      let rejected = false;
      try { await orm.em.execute(sql, [consumer, id]); }
      catch { rejected = true; }
      expect(rejected).toBe(true);
    }
    const [row] = await orm.em.execute<Array<{ payload_hash: string; processed_at: Date | null }>>(
      'select payload_hash,processed_at from inbox_messages where consumer_name=? and message_id=?',
      [consumer, id],
    );
    expect(row?.payload_hash).toBe('original-hash');
    expect(row?.processed_at).toBeTruthy();
  });
});
