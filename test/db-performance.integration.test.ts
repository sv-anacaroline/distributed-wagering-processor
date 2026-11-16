import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';

let orm: MikroORM;
beforeAll(async () => { orm = await MikroORM.init(config); });
afterAll(async () => { await orm.close(true); });

describe('PostgreSQL concurrency indexes and write-amplification settings', () => {
  it('reserves page space for repeated HOT wallet balance updates', async () => {
    const [wallet] = await orm.em.execute<Array<{ reloptions: string[] | null }>>(
      "select reloptions from pg_class where oid = 'wallets'::regclass",
    );
    expect(wallet?.reloptions).toContain('fillfactor=85');
  });

  it('retains indexes used by the financial hot path instead of adding redundant ones', async () => {
    const rows = await orm.em.execute<Array<{ tablename: string; indexname: string }>>(
      `select tablename, indexname from pg_indexes
       where schemaname = current_schema() and tablename in (
         'wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages'
       )`,
    );
    const indexNames = new Set(rows.map(row => row.indexname));
    for (const required of [
      'wallets_pkey',
      'wager_transactions_idempotency_key_key',
      'wager_provider_external_unique',
      'wager_one_active_reversal',
      'wager_pending_reference_due_idx',
      'ledger_wallet_version_unique',
      'ledger_wallet_transaction_unique',
      'outbox_due_idx',
    ]) {
      expect(indexNames.has(required)).toBe(true);
    }
  });
});
