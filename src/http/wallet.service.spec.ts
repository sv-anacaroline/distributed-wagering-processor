import { describe, expect, it } from 'bun:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WalletService } from './wallet.service.js';

interface DBStub {
  fork: () => { execute: (query: string, values: unknown[]) => Promise<unknown> };
}
function service(execute: (sql: string, values: unknown[]) => Promise<unknown>): WalletService {
  const fake: DBStub = { fork: () => ({ execute }) };
  return new WalletService(fake as never);
}
describe('WalletService queries', () => {
  it('rehydrates exact money strings from a wallet query', async () => {
    const wallet = service(() => Promise.resolve([{
      id: 'wallet', player_id: 'player', currency: 'BRL',
      balance: '100.10', version: 7, created_at: new Date(),
    }]));
    expect(await wallet.find('wallet')).toEqual({
      id: 'wallet', playerId: 'player', balance: { amount: '100.10', currency: 'BRL' }, version: 7,
    });
  });
  it('returns 404 for a missing wallet', async () => {
    const wallet = service(() => Promise.resolve([]));
    try { await wallet.find('wallet'); throw new Error('Expected not found'); }
    catch (error: unknown) { expect(error).toBeInstanceOf(NotFoundException); }
  });
  it('does not create or read ledger rows when wallet does not exist', async () => {
    const calls: string[] = [];
    const wallet = service(sql => { calls.push(sql); return Promise.resolve([]); });
    try { await wallet.ledger('missing', 50); }
    catch (error: unknown) { expect(error).toBeInstanceOf(NotFoundException); }
    expect(calls).toHaveLength(1);
  });
});

describe('wallet opening SQL transaction and ledger adapter', () => {
  function transactionalService(write: (sql: string, values: unknown[]) => Promise<unknown>): WalletService {
    const manager = {
      execute: write,
      transactional: (task: (em: unknown) => Promise<unknown>) => task(manager),
    };
    return new WalletService({ fork: () => manager } as never);
  }
  it('writes funded wallet, internal OPENING and CREDIT in one SQL transaction', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const svc = transactionalService((sql, values) => {
      queries.push({ sql, values });
      return Promise.resolve([]);
    });
    const playerId = randomUUID();
    const created = await svc.create(playerId, { amount: '1000.00', currency: 'BRL' });
    expect(created.balance.amount).toBe('1000.00');
    expect(created.version).toBe(1);
    expect(queries).toHaveLength(3);
    expect(queries[0]?.sql).toContain('insert into wallets');
    expect(queries[1]?.sql).toContain('insert into wager_transactions');
    expect(queries[1]?.values).toContain('OPENING');
    expect(queries[2]?.sql).toContain('insert into wallet_ledger_entries');
    expect(queries[2]?.values).toContain('CREDIT');
  });
  it('does not create an OPENING transaction for an empty wallet', async () => {
    const statements: string[] = [];
    const svc = transactionalService(sql => { statements.push(sql); return Promise.resolve([]); });
    const created = await svc.create(randomUUID(), { amount: '0.00', currency: 'BRL' });
    expect(created.balance.amount).toBe('0.00');
    expect(statements).toHaveLength(1);
  });
  it('maps PostgreSQL unique violations into a stable wallet conflict', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
    const svc = transactionalService(() => Promise.reject(duplicate));
    let error: unknown;
    try { await svc.create(randomUUID(), { amount: '10.00', currency: 'BRL' }); }
    catch (caught: unknown) { error = caught; }
    expect(error).toBeInstanceOf(ConflictException);
  });
  it('paginates using a stable keyset, not offset, preserving exact decimal strings', async () => {
    const walletId = randomUUID();
    const row = {
      id: randomUUID(), transaction_id: randomUUID(), direction: 'DEBIT',
      amount: '0.01', currency: 'BRL', balance_before: '10.00',
      balance_after: '9.99', created_at: new Date('2026-11-16T00:00:00Z'),
    };
    const queryLog: string[] = [];
    const svc = service(sql => {
      queryLog.push(sql);
      if (sql.includes('from wallets')) {
        return Promise.resolve([{
          id: walletId, player_id: randomUUID(), currency: 'BRL', balance: '9.99', version: 2,
        }]);
      }
      return Promise.resolve([row, { ...row, id: randomUUID() }]);
    });
    const page = await svc.ledger(walletId, 1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.money.amount).toBe('0.01');
    if (!page.nextCursor) throw new Error('Expected another page');
    const next = await svc.ledger(walletId, 1, page.nextCursor);
    expect(next.items).toHaveLength(1);
    expect(queryLog[3]).toContain('and (created_at,id) <');
    expect(queryLog[3]).not.toContain('offset');
  });
});
