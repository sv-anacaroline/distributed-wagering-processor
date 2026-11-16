import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../domain/errors.js';

function databaseCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 5; i++) {
    if (!current || typeof current !== 'object') break;
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    current = record.driverException ?? record.cause;
  }
  return undefined;
}
export function httpError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof DomainError) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      return { status: 409, code: error.code, message: error.message };
    }
    if (error.code === 'INVALID_MONEY' || error.code === 'INVALID_REFERENCE' ||
        error.code === 'INVALID_DOMAIN_STATE' || error.code === 'CURRENCY_MISMATCH') {
      return { status: 400, code: error.code, message: error.message };
    }
    return { status: 422, code: error.code, message: error.message };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const codes: Record<number, string> = {
      400: 'INVALID_PAYLOAD', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN',
      404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'BUSINESS_REJECTION',
      503: 'INFRASTRUCTURE_UNAVAILABLE',
    };
    return { status, code: codes[status] ?? 'HTTP_ERROR', message: error.message };
  }
  const code = databaseCode(error);
  if (code && (code.startsWith('08') || ['40001', '40P01', '55P03', '53300', '57P01'].includes(code))) {
    return { status: HttpStatus.SERVICE_UNAVAILABLE, code: 'INFRASTRUCTURE_UNAVAILABLE', message: 'Temporary database error' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const error = httpError(exception);
    const original = exception instanceof HttpException ? exception.getResponse() : null;
    const details = original && typeof original === 'object' && !Array.isArray(original)
      ? original as Record<string, unknown>
      : null;
    response.status(error.status).json({
      statusCode: error.status, code: error.code, message: error.message,
      ...(details?.postgres !== undefined && details.sqs !== undefined
        ? { postgres: details.postgres, sqs: details.sqs }
        : {}),
    });
  }
}
