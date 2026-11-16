import { Inject, Controller, Get, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

@Injectable()
export class HealthService {
  constructor(@Inject(CoreEntityManager) private readonly em: EntityManager) {}

  async ready(): Promise<{ status: 'ready'; postgres: 'up'; sqs: 'up' }> {
    let postgres = false;
    let sqs = false;
    try {
      await this.em.fork().execute('select 1');
      postgres = true;
    } catch { /* unavailable */ }
    try {
      const region = process.env.AWS_REGION ?? 'us-east-1';
      const endpoint = process.env.SQS_ENDPOINT_URL ?? `https://sqs.${region}.amazonaws.com`;
      const url = new URL(endpoint);
      // A lightweight network/service reachability probe, not an SQS message.
      url.searchParams.set('Action', 'ListQueues');
      url.searchParams.set('Version', '2012-11-05');
      const response = await fetch(url, { signal: AbortSignal.timeout(1800) });
      // Unsigned public check: AWS may return 400/403 for credentials;
      // only 2xx or known request-validation responses count as reachable.
      sqs = response.ok || response.status === 400 || response.status === 403;
    } catch { /* unavailable */ }
    if (!postgres || !sqs) {
      throw new ServiceUnavailableException({
        status: 'unavailable', postgres: postgres ? 'up' : 'down', sqs: sqs ? 'up' : 'down',
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
