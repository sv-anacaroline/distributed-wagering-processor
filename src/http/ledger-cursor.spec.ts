import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const value = {
  walletId,
  id: '0192f291-27dd-7d3f-8071-5f8685deef38',
  createdAt: '2026-11-16T12:30:00.000Z',
};
describe('signed opaque ledger cursor', () => {
  it('round-trips a stable wallet-scoped cursor', () => {
    const cursor = encodeLedgerCursor(value);
    expect(cursor).not.toContain(walletId);
    expect(decodeLedgerCursor(cursor, walletId)).toEqual(value);
    expect(encodeLedgerCursor(value)).toBe(cursor);
  });
  it('rejects tampered signatures, broken input and another wallet', () => {
    const token = encodeLedgerCursor(value);
    expect(() => decodeLedgerCursor(token.slice(0, -1) + 'A', walletId)).toThrow(
      BadRequestException,
    );
    expect(() => decodeLedgerCursor('broken', walletId)).toThrow(BadRequestException);
    expect(() => decodeLedgerCursor(token, '0192f291-27dd-7d3f-8071-5f8685deef39')).toThrow(
      BadRequestException,
    );
  });
  it('rejects a signed but invalid payload', () => {
    const token = encodeLedgerCursor({ ...value, createdAt: 'not-a-date' });
    expect(() => decodeLedgerCursor(token, walletId)).toThrow(BadRequestException);
  });
});
