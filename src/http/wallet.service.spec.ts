import { describe, expect, it } from 'bun:test';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
