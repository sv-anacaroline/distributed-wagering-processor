import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';
import { Money } from './money.js';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

describe('Money', () => {
  it('accepts exact two-decimal strings and serializes without rounding', () => {
    expect(money('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(money('0.01').toString()).toBe('0.01 BRL');
    expect(money('0.00').isZero()).toBe(true);
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  it('rejects invalid external money and malformed currency', () => {
    for (const amount of [
      '25.1',
      '25.123',
      '-1.00',
      '1e3',
      'NaN',
      'Infinity',
      '',
      ' 1.00',
      '01.00',
      '1',
      '.10',
      '9999999999999999999.99',
    ]) {
      expect(() => money(amount)).toThrow(InvalidMoneyError);
    }
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
      InvalidMoneyError,
    );
    for (const currency of ['brl', 'BR', '', 'BRLL', '1BR']) {
      expect(() => money('1.00', currency)).toThrow(InvalidMoneyError);
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
  });

  it('adds and subtracts exactly with no float loss', () => {
    expect(money('0.10').add(money('0.20')).toJSON().amount).toBe('0.30');
    expect(money('1.00').subtract(money('0.01')).toJSON().amount).toBe('0.99');
    expect(money('0.01').subtract(money('0.02')).toJSON().amount).toBe('-0.01');
    expect(money('0.01').subtract(money('0.01')).isZero()).toBe(true);
  });

  it('negates amounts and preserves zero without negative zero', () => {
    const original = money('10.25');
    const opposite = original.negate();
    expect(opposite.isNegative()).toBe(true);
    expect(opposite.toJSON().amount).toBe('-10.25');
    expect(opposite.negate().equals(original)).toBe(true);
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
  });

  it('does not mutate original values', () => {
    const original = money('1.00');
    const next = original.add(money('2.00'));
    expect(original.toJSON().amount).toBe('1.00');
    expect(next.toJSON().amount).toBe('3.00');
    expect(next).not.toBe(original);
  });

  it('checks comparisons and sign predicates', () => {
    expect(money('0.01').isPositive()).toBe(true);
    expect(money('0.00').isPositive()).toBe(false);
    expect(money('0.00').isNegative()).toBe(false);
    expect(money('0.01').isLessThan(money('0.02'))).toBe(true);
    expect(money('0.02').isLessThan(money('0.01'))).toBe(false);
    expect(money('1.00').equals(money('1.00'))).toBe(true);
    expect(money('1.00').equals(money('1.01'))).toBe(false);
  });

  it('rejects mixed currencies in every binary operation', () => {
    const brl = money('1.00', 'BRL');
    const usd = money('1.00', 'USD');
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
  });

  it('supports the SQL numeric limit and rejects overflow', () => {
    const max = money('999999999999999999.99');
    expect(max.add(money('0.00')).equals(max)).toBe(true);
    expect(() => max.add(money('0.01'))).toThrow(InvalidMoneyError);
    expect(() => max.negate().subtract(money('0.01'))).toThrow(InvalidMoneyError);
  });
});
