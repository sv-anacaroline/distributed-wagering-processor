import { setTimeout as sleep } from 'node:timers/promises';
import { InvalidDomainStateError } from '../domain/errors.js';
import type { ProcessWager } from '../application/process-wager.js';

/**
 * Database-backed scheduler. Any number of instances may scan due rows:
 * retryPending locks the wallet then rechecks the row state under FOR UPDATE.
 */
export class ReferenceRetryWorker {
  constructor(
    private readonly processWager: Pick<ProcessWager, 'dueReferences' | 'retryPending'>,
  ) {}

  async runOnce(batchSize = 25): Promise<{ scanned: number; completed: number }> {
    const due = await this.processWager.dueReferences(batchSize);
    let completed = 0;
    for (const item of due) {
      const result = await this.processWager.retryPending(item.id, item.walletId);
      if (result) completed += 1;
    }
    return { scanned: due.length, completed };
  }

  async run(signal: AbortSignal, intervalMs = 1000): Promise<void> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new InvalidDomainStateError('Retry poll interval must be at least 100ms');
    }
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        // A failed SQL transaction leaves the row due for a later retry.
        console.error('Reference retry iteration failed', error);
      }
      try {
        await sleep(intervalMs, undefined, { signal });
      } catch (error: unknown) {
        if (signal.aborted) break;
        throw error;
      }
    }
  }
}
