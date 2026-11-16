import { describe, expect, it } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController, HealthService } from './health.controller.js';

describe('health checks', () => {
  it('live does not query external services', () => {
    const controller = new HealthController(null as never);
    expect(controller.live()).toEqual({ status: 'live' });
  });
  it('readiness fails with 503 when SQS is unreachable', async () => {
    const original = process.env.SQS_ENDPOINT_URL;
    process.env.SQS_ENDPOINT_URL = 'http://127.0.0.1:1';
    const fake = { fork: () => ({ execute: () => Promise.resolve([{ '?column?': 1 }]) }) };
    const service = new HealthService(fake as never);
    let error: unknown;
    try { await service.ready(); } catch (caught: unknown) { error = caught; }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    if (original === undefined) delete process.env.SQS_ENDPOINT_URL;
    else process.env.SQS_ENDPOINT_URL = original;
  });
});
