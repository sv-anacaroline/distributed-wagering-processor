import { describe, expect, it } from 'bun:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InvalidMoneyError } from '../domain/errors.js';
import { IdempotencyConflictError } from '../application/process-wager.js';
import { httpError } from './http-exception.filter.js';

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
