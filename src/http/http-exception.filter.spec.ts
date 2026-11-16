import { describe, expect, it } from 'bun:test';
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InvalidMoneyError, DomainError } from '../domain/errors.js';
import { IdempotencyConflictError } from '../application/process-wager.js';
import { HttpExceptionFilter, httpError } from './http-exception.filter.js';

describe('stable HTTP error taxonomy', () => {
  it('distinguishes invalid payload from idempotency conflicts', () => {
    expect(httpError(new BadRequestException()).status).toBe(400);
    expect(httpError(new InvalidMoneyError('invalid')).status).toBe(400);
    expect(httpError(new IdempotencyConflictError())).toMatchObject({
      status: 409, code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(httpError(new ConflictException()).status).toBe(409);
    expect(httpError(new NotFoundException()).status).toBe(404);
  });
  it('maps transient infrastructure failures to 503 and masks unknown errors', () => {
    expect(httpError({ driverException: { code: '08006' } }).status).toBe(503);
    expect(httpError({ cause: { code: '40P01' } }).code).toBe('INFRASTRUCTURE_UNAVAILABLE');
    expect(httpError(new Error('secret')).message).toBe('Internal server error');
  });
});

describe('HTTP exception filter response', () => {
  it('preserves readiness dependency status while exposing a machine-readable error code', () => {
    const sent: { status?: number; body?: unknown } = {};
    const res = {
      status: (value: number) => { sent.status = value; return res; },
      json: (value: unknown) => { sent.body = value; return res; },
    };
    const host = { switchToHttp: () => ({ getResponse: () => res }) };
    new HttpExceptionFilter().catch(
      new ServiceUnavailableException({ status: 'unavailable', postgres: 'up', sqs: 'down' }),
      host as never,
    );
    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({
      statusCode: 503, code: 'INFRASTRUCTURE_UNAVAILABLE', postgres: 'up', sqs: 'down',
    });
  });
  it('returns a stable 422 code for business-domain exceptions', () => {
    const error = httpError(new DomainError('INSUFFICIENT_FUNDS', 'No funds'));
    expect(error.status).toBe(422);
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
  });
});
