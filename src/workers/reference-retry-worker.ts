import { setTimeout as sleep } from 'node:timers/promises';
import { count, duration, log, withSpan } from '../telemetry/otel.js';
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
    return withSpan('references.poll', { 'worker.name': 'reference-retry' }, async () => {
      const startedAt = performance.now();
      const due = await this.processWager.dueReferences(batchSize);
      let completed = 0;
      for (const item of due) {
        const result = await withSpan(
          'references.retry.one',
          { transaction_id: item.id, wallet_id: item.walletId },
          () => this.processWager.retryPending(item.id, item.walletId),
        );
        if (result) completed += 1;
      }
      count('wager_reference_scanned_total', {}, due.length);
      count('wager_reference_completed_total', {}, completed);
      duration('wager_reference_poll_duration_ms', performance.now() - startedAt);
      if (due.length) log('info', 'references.poll.completed', { scanned: due.length, completed });
      return { scanned: due.length, completed };
    });
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
        log('error', 'references.poll.failed', {
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });
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
