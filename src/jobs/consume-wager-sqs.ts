import { MikroORM } from '@mikro-orm/postgresql';
import { startTelemetry, stopTelemetry, log } from '../telemetry/otel.js';
import config from '../mikro-orm.config.js';
import { ProcessWager } from '../application/process-wager.js';
import { sqsClient, sqsQueueUrl } from '../events/sqs-client.js';
import { SqsWagerConsumer } from '../events/sqs-wager-consumer.js';

const termination = new AbortController();
process.once('SIGTERM', () => termination.abort());
process.once('SIGINT', () => termination.abort());

async function main(): Promise<void> {
  startTelemetry('wager-sqs-consumer');
  log('info', 'worker.started', { worker: 'wager-sqs-consumer' });
  const orm = await MikroORM.init({ ...config, pool: { min: 0, max: 10 } });
  const client = sqsClient();
  try {
    const [incoming, deadLetter] = await Promise.all([
      sqsQueueUrl(
        client,
        process.env.SQS_WAGER_TRANSACTIONS_URL,
        process.env.SQS_WAGER_TRANSACTIONS_QUEUE_NAME ?? 'wager-transactions.fifo',
      ),
      sqsQueueUrl(
        client,
        process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL,
        process.env.SQS_WAGER_TRANSACTIONS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
      ),
    ]);
    const consumer = new SqsWagerConsumer(
      client,
      { incoming, deadLetter },
      new ProcessWager(orm.em),
    );
    // No new receives after SIGTERM. Wait for ongoing SQL + ack/DLQ operations
    // before closing the connection pool; SQS visibility recovers forced kills.
    await consumer.run(termination.signal);
  } finally {
    client.destroy();
    await orm.close(true);
    log('info', 'worker.stopped', { worker: 'wager-sqs-consumer' });
    await stopTelemetry();
  }
}
void main().catch((error: unknown) => {
  log('error', 'SQS wager worker terminated', {
    error_type: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exitCode = 1;
});
