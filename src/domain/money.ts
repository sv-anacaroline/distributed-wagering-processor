import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Immutable 2-decimal fixed-point money. All amounts are represented as bigint cents:
 * no number, floating point, rounding, or runtime dependency on an ORM/Decimal library.
 * The magnitude matches PostgreSQL NUMERIC(20,2) (18 integer digits + 2 decimals).
 */
export class Money {
  private static readonly maxCents = 10n ** 20n - 1n;

  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (
      !props ||
      typeof props.amount !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,17})\.[0-9]{2}$/.test(props.amount)
    ) {
      throw new InvalidMoneyError(
        'Amount must be a nonnegative decimal string with exactly 2 digits',
      );
    }
    Money.assertCurrency(props.currency);
    return Money.fromCents(BigInt(props.amount.replace('.', '')), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.fromCents(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const sign = this.cents < 0n ? '-' : '';
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const integer = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');
    return { amount: `${sign}${integer}.${fraction}`, currency: this.currency };
  }

  toString(): string {
    return `${this.toJSON().amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static fromCents(cents: bigint, currency: string): Money {
    if (cents > Money.maxCents || cents < -Money.maxCents) {
      throw new InvalidMoneyError('Amount exceeds NUMERIC(20,2) range');
    }
    return new Money(cents, currency);
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError('Currency must be an uppercase ISO-4217 code');
    }
  }
}
