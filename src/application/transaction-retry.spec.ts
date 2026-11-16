import { describe, expect, it } from 'bun:test';
import { InsufficientFundsError } from '../domain/errors.js';
import { isTransientDatabaseError, withTransactionRetry } from './transaction-retry.js';

const sqlError = (code: string): Error & { code: string } =>
  Object.assign(new Error('database error'), { code });

async function rejected(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected an exception');
}

describe('transaction retries', () => {
  it('recognizes only retryable PostgreSQL SQLSTATE codes, including nested driver errors', () => {
    for (const code of ['40001', '40P01', '55P03']) {
      expect(isTransientDatabaseError(sqlError(code))).toBe(true);
      expect(isTransientDatabaseError({ driverException: { cause: sqlError(code) } })).toBe(true);
    }
    expect(isTransientDatabaseError(sqlError('23505'))).toBe(false);
    expect(isTransientDatabaseError(sqlError('23514'))).toBe(false);
    expect(isTransientDatabaseError(new InsufficientFundsError())).toBe(false);
    expect(isTransientDatabaseError(null)).toBe(false);
    const recursive: { cause?: unknown } = {};
    recursive.cause = recursive;
    expect(isTransientDatabaseError(recursive)).toBe(false);
  });

  it('does not introduce a delay when the operation succeeds', async () => {
    let waits = 0;
    const result = await withTransactionRetry(
      () => Promise.resolve('committed'),
      () => {
        waits++;
        return Promise.resolve();
      },
    );
    expect(result).toBe('committed');
    expect(waits).toBe(0);
  });

  it('restarts the complete transaction on a deadlock and then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withTransactionRetry(
      () => {
        calls++;
        if (calls === 1) return Promise.reject(sqlError('40P01'));
        return Promise.resolve('committed');
      },
      (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      () => 0,
    );
    expect(result).toBe('committed');
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
  });

  it('bounds transient failures to three complete attempts with increasing delays', async () => {
    let calls = 0;
    const delays: number[] = [];
    const failure = sqlError('40001');
    const caught = await rejected(() =>
      withTransactionRetry(
        () => {
          calls++;
          return Promise.reject(failure);
        },
        (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        () => 0,
      ),
    );
    expect(caught).toBe(failure);
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('never retries uniqueness or business errors', async () => {
    for (const error of [sqlError('23505'), new InsufficientFundsError()]) {
      let calls = 0;
      const caught = await rejected(() =>
        withTransactionRetry(() => {
          calls++;
          return Promise.reject(error);
        }),
      );
      expect(caught).toBe(error);
      expect(calls).toBe(1);
    }
  });

  it('uses the default short sleep and jitter when recovering from a transient SQL error', async () => {
    let calls = 0;
    const result = await withTransactionRetry(() => {
      calls++;
      return calls === 1 ? Promise.reject(sqlError('40001')) : Promise.resolve('committed');
    });
    expect(result).toBe('committed');
    expect(calls).toBe(2);
  });

  it('caps jitter and handles wrapped lock errors', async () => {
    let calls = 0;
    const delays: number[] = [];
    await withTransactionRetry(
      () => {
        calls++;
        return calls < 3
          ? Promise.reject(
              Object.assign(new Error('wrapped DB error'), { cause: sqlError('55P03') }),
            )
          : Promise.resolve();
      },
      (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      () => 5,
    );
    expect(calls).toBe(3);
    expect(delays).toEqual([19, 29]);
  });
});
