import { createInterface } from 'node:readline';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../src/mikro-orm.config.js';
import { ProcessWager } from '../../src/application/process-wager.js';
import type { WagerCommand } from '../../src/application/wager-contracts.js';

type Request =
  | { readonly id: string; readonly action: 'process'; readonly command: WagerCommand }
  | {
      readonly id: string;
      readonly action: 'retry';
      readonly transactionId: string;
      readonly walletId: string;
    };

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...config, pool: { min: 0, max: 4 } });
  const processor = new ProcessWager(orm.em);
  const pending = new Set<Promise<void>>();
  process.stdout.write('{"action":"ready"}\n');

  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      const request = JSON.parse(line) as Request;
      const task = (async (): Promise<void> => {
        try {
          const result =
            request.action === 'process'
              ? await processor.process(request.command)
              : await processor.retryPending(request.transactionId, request.walletId);
          process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
        } catch (error: unknown) {
          const ex = error instanceof Error ? error : new Error(String(error));
          const code = 'code' in ex && typeof ex.code === 'string' ? ex.code : undefined;
          process.stdout.write(
            JSON.stringify({
              id: request.id,
              ok: false,
              message: ex.message,
              code,
            }) + '\n',
          );
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    await Promise.all(pending);
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
