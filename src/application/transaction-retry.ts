import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Retry only PostgreSQL failures where repeating the WHOLE SQL transaction
 * is safe. Never retry a business rejection or a uniqueness violation.
 */
const TRANSIENT_CODES = new Set(['40001', '40P01', '55P03']);
const MAX_ATTEMPTS = 3;

/** MikroORM and pg may wrap the SQLSTATE in driverException/cause. */
export function isTransientDatabaseError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 16) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (typeof record.code === 'string' && TRANSIENT_CODES.has(record.code)) return true;
    pending.push(record.cause, record.driverException, record.originalError, record.parent);
  }
  return false;
}

export async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => sleep(milliseconds),
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isTransientDatabaseError(error) || attempt === MAX_ATTEMPTS) throw error;
      // Backoff is outside the failed transaction: no wallet lock is held.
      const jitter = Math.max(0, Math.min(9, Math.floor(random() * 10)));
      await wait(10 * 2 ** (attempt - 1) + jitter);
    }
  }
  throw new Error('Unreachable transaction retry state');
}
