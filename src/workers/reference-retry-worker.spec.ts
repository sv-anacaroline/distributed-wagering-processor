import { describe, expect, it } from 'bun:test';
import { InvalidDomainStateError } from '../domain/errors.js';
import { WagerTransactionStatus } from '../domain/wager-transaction.js';
import { ReferenceRetryWorker } from './reference-retry-worker.js';

describe('ReferenceRetryWorker', () => {
  it('processes due references once, without reprocessing records absent from the due query', async () => {
    const calls: string[] = [];
    const worker = new ReferenceRetryWorker({
      dueReferences: () =>
        Promise.resolve([
          { id: 'a', walletId: 'w1' },
          { id: 'b', walletId: 'w2' },
        ]),
      retryPending: (id) => {
        calls.push(id);
        return Promise.resolve(
          id === 'a'
            ? {
                transactionId: 'a',
                providerId: 'p',
                externalTransactionId: 'e',
                status: WagerTransactionStatus.Processed,
                balance: { amount: '1.00', currency: 'BRL' },
                walletVersion: 2,
                observedAt: new Date().toISOString(),
              }
            : null,
        );
      },
    });
    expect(await worker.runOnce()).toEqual({ scanned: 2, completed: 1 });
    expect(calls).toEqual(['a', 'b']);
  });

  it('rejects invalid batch size through the underlying SQL-backed coordinator', async () => {
    const worker = new ReferenceRetryWorker({
      dueReferences: (batchSize) => {
        if ((batchSize ?? 0) < 1) throw new InvalidDomainStateError('Invalid batch size');
        return Promise.resolve([]);
      },
      retryPending: () => Promise.resolve(null),
    });
    let error: unknown;
    try {
      await worker.runOnce(0);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidDomainStateError);
  });

  it('stops when aborted and refuses invalid intervals', async () => {
    const controller = new AbortController();
    let count = 0;
    const worker = new ReferenceRetryWorker({
      dueReferences: () => {
        count++;
        controller.abort();
        return Promise.resolve([]);
      },
      retryPending: () => Promise.resolve(null),
    });
    await worker.run(controller.signal, 100);
    expect(count).toBe(1);
    let error: unknown;
    try {
      await worker.run(new AbortController().signal, 0);
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidDomainStateError);
  });

  it('does not leave a failed reference poll running after shutdown', async () => {
    const controller = new AbortController();
    let polls = 0;
    const worker = new ReferenceRetryWorker({
      dueReferences: () => {
        polls++;
        controller.abort();
        return Promise.reject(new Error('PostgreSQL temporarily down'));
      },
      retryPending: () => Promise.resolve(null),
    });
    await worker.run(controller.signal, 100);
    expect(polls).toBe(1);
  });
});
