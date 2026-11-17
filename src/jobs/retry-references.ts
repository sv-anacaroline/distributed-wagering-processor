import { MikroORM } from '@mikro-orm/postgresql';
import { startTelemetry, stopTelemetry, log } from '../telemetry/otel.js';
import config from '../mikro-orm.config.js';
import { ProcessWager } from '../application/process-wager.js';
import { ReferenceRetryWorker } from '../workers/reference-retry-worker.js';

async function main(): Promise<void> {
  startTelemetry('wager-reference-worker');
  log('info', 'worker.started', { worker: 'wager-reference-worker' });
  const orm = await MikroORM.init(config);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  try {
    await new ReferenceRetryWorker(new ProcessWager(orm.em)).run(abort.signal);
  } finally {
    await orm.close(true);
    log('info', 'worker.stopped', { worker: 'wager-reference-worker' });
    await stopTelemetry();
  }
}

void main().catch((error: unknown) => {
  log('error', 'Reference retry worker stopped', error);
  process.exitCode = 1;
});
