import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config.js';
import { ProcessWager } from '../application/process-wager.js';
import { ReferenceRetryWorker } from '../workers/reference-retry-worker.js';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  try {
    await new ReferenceRetryWorker(new ProcessWager(orm.em)).run(abort.signal);
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error('Reference retry worker stopped', error);
  process.exitCode = 1;
});
