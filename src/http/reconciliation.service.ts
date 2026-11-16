import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money, type MoneyProps } from '../domain/money.js';

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}
export function reconcileAmounts(
  walletId: string, currency: string, stored: string, calculated: string, checkedEntries: number,
): ReconciliationResult {
  const a = Money.from({ amount: stored, currency });
  const b = Money.from({ amount: calculated, currency });
  return {
    walletId, storedBalance: a.toJSON(), calculatedBalance: b.toJSON(),
    difference: a.subtract(b).toJSON(), consistent: a.equals(b), checkedEntries,
  };
}
interface BalanceRow { readonly balance: string; readonly currency: string }
interface LedgerTotal { readonly calculated: string; readonly entries: number }

@Injectable()
export class ReconciliationService {
  constructor(@Inject(CoreEntityManager) private readonly em: EntityManager) {}

  async run(walletId: string): Promise<ReconciliationResult> {
    // REPEATABLE READ uses one MVCC snapshot without serializing unrelated writers.
    return this.em.fork().transactional(async em => {
      const [wallet] = await em.execute<BalanceRow[]>(
        'select balance::text as balance,currency from wallets where id=?::uuid', [walletId],
      );
      if (!wallet) throw new NotFoundException('Wallet not found');
      const [total] = await em.execute<LedgerTotal[]>(
        `select coalesce(sum(case when direction='CREDIT' then amount else -amount end),0)::numeric(20,2)::text as calculated,
          count(*)::integer as entries from wallet_ledger_entries where wallet_id=?::uuid`,
        [walletId],
      );
      const result = reconcileAmounts(
        walletId, wallet.currency, wallet.balance, total?.calculated ?? '0.00', total?.entries ?? 0,
      );
      if (!result.consistent) {
        await em.execute(
          `insert into wallet_reconciliation_anomalies
          (id,wallet_id,stored_balance,calculated_balance,difference,checked_entries,detected_at)
          values (?::uuid,?::uuid,?::numeric,?::numeric,?::numeric,?,clock_timestamp())`,
          [
            randomUUID(), walletId, result.storedBalance.amount,
            result.calculatedBalance.amount, result.difference.amount, result.checkedEntries,
          ],
        );
        console.error(JSON.stringify({
          level: 'error', event: 'wallet.reconciliation.divergence', walletId,
          storedBalance: result.storedBalance, calculatedBalance: result.calculatedBalance,
          difference: result.difference, checkedEntries: result.checkedEntries,
        }));
      }
      return result;
    }, { isolationLevel: IsolationLevel.REPEATABLE_READ });
  }

  /** Durable, cross-instance counter. Exposed only through authenticated internal metrics. */
  async divergenceCount(): Promise<string> {
    const [row] = await this.em.fork().execute<Array<{ total: string }>>(
      'select count(*)::text as total from wallet_reconciliation_anomalies',
    );
    return row?.total ?? '0';
  }
}
