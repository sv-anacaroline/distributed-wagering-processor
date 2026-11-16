import { describe, expect, it } from 'bun:test';
import { reconcileAmounts, ReconciliationService } from './reconciliation.service.js';

describe('reconciliation exact arithmetic', () => {
  it('recognizes matching materialized balances', () => {
    expect(reconcileAmounts('w1', 'BRL', '975.00', '975.00', 42)).toEqual({
      walletId: 'w1',
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 42,
    });
  });
  it('signals positive and negative discrepancies without floating point', () => {
    const a = reconcileAmounts('w1', 'BRL', '10.00', '9.99', 100);
    const b = reconcileAmounts('w1', 'BRL', '10.00', '10.01', 100);
    expect(a.consistent).toBe(false);
    expect(a.difference.amount).toBe('0.01');
    expect(b.consistent).toBe(false);
    expect(b.difference.amount).toBe('-0.01');
  });
  it('does not lose precision for large balances', () => {
    expect(
      reconcileAmounts('w1', 'BRL', '999999999999999999.99', '999999999999999999.98', 1).difference
        .amount,
    ).toBe('0.01');
  });
});

describe('reconciliation SQL snapshot and anomaly audit', () => {
  function service(stored: string, calculated: string) {
    const sqls: string[] = [];
    const manager = {
      execute: (sql: string) => {
        sqls.push(sql);
        if (sql.includes('from wallets')) {
          return Promise.resolve([{ balance: stored, currency: 'BRL' }]);
        }
        if (sql.includes('from wallet_ledger_entries')) {
          return Promise.resolve([{ calculated, entries: 42 }]);
        }
        if (sql.includes('count(*)::text')) return Promise.resolve([{ total: '3' }]);
        return Promise.resolve([]);
      },
      transactional: (fn: (em: unknown) => Promise<unknown>) => fn(manager),
    };
    return { svc: new ReconciliationService({ fork: () => manager } as never), sqls };
  }
  it('reads stored and ledger balances in the same repeatable-read SQL snapshot', async () => {
    const { svc, sqls } = service('100.00', '100.00');
    const result = await svc.run('wallet');
    expect(result.consistent).toBe(true);
    expect(result.checkedEntries).toBe(42);
    expect(
      sqls.filter((sql) => sql.includes('insert into wallet_reconciliation_anomalies')),
    ).toHaveLength(0);
  });
  it('records an immutable anomaly but never mutates wallet balance or ledger', async () => {
    const { svc, sqls } = service('100.00', '99.99');
    const result = await svc.run('wallet');
    expect(result.consistent).toBe(false);
    expect(result.difference.amount).toBe('0.01');
    expect(
      sqls.filter((sql) => sql.includes('insert into wallet_reconciliation_anomalies')),
    ).toHaveLength(1);
    expect(sqls.some((sql) => /update wallets|delete from wallet_ledger_entries/i.test(sql))).toBe(
      false,
    );
  });
  it('returns a durable cross-instance anomaly metric as a decimal count string', async () => {
    const { svc } = service('100.00', '100.00');
    expect(await svc.divergenceCount()).toBe('3');
  });
});
