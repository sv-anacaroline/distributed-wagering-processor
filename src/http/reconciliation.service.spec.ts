import { describe, expect, it } from 'bun:test';
import { reconcileAmounts } from './reconciliation.service.js';

describe('reconciliation exact arithmetic', () => {
  it('recognizes matching materialized balances', () => {
    expect(reconcileAmounts('w1', 'BRL', '975.00', '975.00', 42)).toEqual({
      walletId: 'w1',
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true, checkedEntries: 42,
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
    expect(reconcileAmounts('w1', 'BRL', '999999999999999999.99', '999999999999999999.98', 1).difference.amount).toBe('0.01');
  });
});
