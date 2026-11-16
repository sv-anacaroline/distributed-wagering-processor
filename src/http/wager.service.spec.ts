import { describe, expect, it } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import { WagerTransactionStatus } from '../domain/wager-transaction.js';
import { WagerService } from './wager.service.js';

function service(records: unknown[]): WagerService {
  const fake = { fork: () => ({ execute: () => Promise.resolve(records) }) };
  return new WagerService(fake as never);
}
const row = () => ({
  id: 'id',
  provider_id: 'provider',
  external_transaction_id: 'ext',
  wallet_id: 'wallet',
  player_id: 'player',
  round_id: 'round',
  game_id: 'game',
  kind: 'LOSS',
  status: 'PROCESSED',
  amount: '50.00',
  currency: 'BRL',
  reference_external_transaction_id: null,
  reference_transaction_id: null,
  failure_code: null,
  created_at: new Date('2026-11-16T00:00:00Z'),
  processed_at: new Date('2026-11-16T00:00:01Z'),
  response_snapshot: null,
});
describe('WagerService queries', () => {
  it('returns a typed immutable financial string contract for internal ID lookups', async () => {
    const result = await service([row()]).findById('id');
    expect(result.money).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.processedAt).toBe('2026-11-16T00:00:01.000Z');
  });
  it('queries the same contract by provider and external ID', async () => {
    const result = await service([row()]).findByExternalId('provider', 'ext');
    expect(result.id).toBe('id');
    expect(result.providerId).toBe('provider');
  });
  it('distinguishes not-found transactions', async () => {
    let failed: unknown;
    try {
      await service([]).findById('missing');
    } catch (e: unknown) {
      failed = e;
    }
    expect(failed).toBeInstanceOf(NotFoundException);
    failed = undefined;
    try {
      await service([]).findByExternalId('provider', 'missing');
    } catch (e: unknown) {
      failed = e;
    }
    expect(failed).toBeInstanceOf(NotFoundException);
  });
});
