import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

export interface LedgerCursor {
  readonly walletId: string;
  readonly createdAt: string;
  readonly id: string;
}
function secret(): string {
  const value = process.env.PAGINATION_CURSOR_SECRET;
  if (process.env.NODE_ENV === 'production' && (!value || value.length < 32)) {
    throw new Error('PAGINATION_CURSOR_SECRET must have at least 32 characters');
  }
  return value ?? 'local-only-not-for-production';
}
function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}
export function encodeLedgerCursor(value: LedgerCursor): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function decodeLedgerCursor(cursor: string, walletId: string): LedgerCursor {
  if (!/^[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{43}$/.test(cursor)) {
    throw new BadRequestException('Invalid ledger cursor');
  }
  const [payload = '', digest = ''] = cursor.split('.');
  const expected = Buffer.from(signature(payload));
  const received = Buffer.from(digest);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new BadRequestException('Invalid ledger cursor signature');
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown; }
  catch { throw new BadRequestException('Invalid ledger cursor data'); }
  if (!value || typeof value !== 'object') throw new BadRequestException('Invalid ledger cursor');
  const fields = value as Record<string, unknown>;
  if (
    fields.walletId !== walletId ||
    typeof fields.id !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(fields.id) ||
    typeof fields.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(fields.createdAt))
  ) {
    throw new BadRequestException('Ledger cursor belongs to another wallet or is malformed');
  }
  return { walletId, id: fields.id, createdAt: fields.createdAt };
}
