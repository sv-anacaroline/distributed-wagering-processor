import { MikroORM } from '@mikro-orm/postgresql';
import { startTelemetry, stopTelemetry, log } from '../telemetry/otel.js';
import config from '../mikro-orm.config.js';
import { sqsClient, sqsQueueUrl } from '../events/sqs-client.js';
import { OutboxPublisher } from '../events/outbox-publisher.js';

const termination = new AbortController();
process.once('SIGTERM', () => termination.abort());
process.once('SIGINT', () => termination.abort());

async function main(): Promise<void> {
  startTelemetry('wager-outbox-publisher');
  log('info', 'worker.started', { worker: 'wager-outbox-publisher' });
  const orm = await MikroORM.init({ ...config, pool: { min: 0, max: 5 } });
  const client = sqsClient();
  try {
    const queue = await sqsQueueUrl(
      client,
      process.env.SQS_WAGER_EVENTS_URL,
      process.env.SQS_WAGER_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
    );
    await new OutboxPublisher(orm.em, client, queue).run(termination.signal);
  } finally {
    client.destroy();
    await orm.close(true);
    log('info', 'worker.stopped', { worker: 'wager-outbox-publisher' });
    await stopTelemetry();
  }
}
void main().catch((error: unknown) => {
  log('error', 'Outbox publisher terminated', error);
  process.exitCode = 1;
});
