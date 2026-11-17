import {
  Inject,
  Controller,
  Get,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { sqsClient, sqsQueueUrl } from '../events/sqs-client.js';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly sqsClient = sqsClient();

  constructor(@Inject(CoreEntityManager) private readonly em: EntityManager) {}

  onModuleDestroy(): void {
    this.sqsClient.destroy();
  }

  async ready(): Promise<{ status: 'ready'; postgres: 'up'; sqs: 'up' }> {
    let postgres = false;
    let sqs = false;
    try {
      await this.em.fork().execute('select 1');
      postgres = true;
    } catch {
      /* unavailable */
    }
    try {
      // A reachable HTTP endpoint returning 403 is NOT an operational SQS
      // dependency. Read the actual queue with signed AWS SDK credentials;
      // this also checks IAM permissions and missing queue configuration.
      const queueUrl = await sqsQueueUrl(
        this.sqsClient,
        process.env.SQS_WAGER_TRANSACTIONS_URL,
        process.env.SQS_WAGER_TRANSACTIONS_QUEUE_NAME ?? 'wager-transactions.fifo',
      );
      const result = await this.sqsClient.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
        { abortSignal: AbortSignal.timeout(1800) },
      );
      sqs = Boolean(result.Attributes?.QueueArn);
    } catch {
      /* unavailable or unauthorized */
    }
    if (!postgres || !sqs) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        postgres: postgres ? 'up' : 'down',
        sqs: sqs ? 'up' : 'down',
      });
    }
    return { status: 'ready', postgres: 'up', sqs: 'up' };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly service: HealthService) {}
  @Get('live')
  live(): { status: 'live' } {
    return { status: 'live' };
  }
  @Get('ready')
  ready(): Promise<{ status: 'ready'; postgres: 'up'; sqs: 'up' }> {
    return this.service.ready();
  }
}
