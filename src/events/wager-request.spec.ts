import { describe, expect, it } from 'bun:test';
import { parseWagerRequest, InvalidSqsMessageError } from './wager-request.js';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const envelope = () => ({
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    walletId,
    playerId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
});
describe('WagerTransactionRequested contract', () => {
  it('decodes and hashes a canonical transport-independent business envelope', () => {
    const input = envelope();
    const first = parseWagerRequest(JSON.stringify(input));
    const reordered = {
      data: { ...input.data, money: { currency: 'BRL', amount: '25.00' } },
      occurredAt: input.occurredAt,
      type: input.type,
      messageId: input.messageId,
    };
    expect(parseWagerRequest(JSON.stringify(reordered)).payloadHash).toBe(first.payloadHash);
    expect(first.command.money.amount).toBe('25.00');
    expect(first.command.idempotencyKey).toBe('provider-a:transaction-123');
  });
  it('changes the hash if the key, amount, message id or timestamp changes', () => {
    const a = envelope();
    const baseline = parseWagerRequest(JSON.stringify(a)).payloadHash;
    const variants = [
      { ...a, messageId: 'msg-456' },
      { ...a, occurredAt: '2026-07-29T15:00:01.000Z' },
      { ...a, data: { ...a.data, idempotencyKey: 'another' } },
      { ...a, data: { ...a.data, money: { amount: '24.00', currency: 'BRL' } } },
    ];
    for (const variant of variants) {
      expect(parseWagerRequest(JSON.stringify(variant)).payloadHash).not.toBe(baseline);
    }
  });
  it('rejects an invalid JSON body, unsupported kind, missing IDs and malformed timestamps', () => {
    const a = envelope();
    for (const raw of ['not-json', '[]', '{}']) {
      expect(() => parseWagerRequest(raw)).toThrow(InvalidSqsMessageError);
    }
    for (const value of [
      { ...a, type: 'Unknown' },
      { ...a, messageId: '' },
      { ...a, occurredAt: 'yesterday' },
      { ...a, data: { ...a.data, kind: 'OPENING' } },
      { ...a, data: { ...a.data, playerId: 'invalid' } },
      { ...a, data: { ...a.data, idempotencyKey: '' } },
    ]) {
      expect(() => parseWagerRequest(JSON.stringify(value))).toThrow(InvalidSqsMessageError);
    }
  });
  it('rejects money numbers, negative money, fractions and scientific notation', () => {
    const a = envelope();
    for (const amount of [42, '-0.01', '1.999', '5e1', '0.00']) {
      expect(() =>
        parseWagerRequest(
          JSON.stringify({
            ...a,
            data: { ...a.data, money: { amount, currency: 'BRL' } },
          }),
        ),
      ).toThrow(InvalidSqsMessageError);
    }
  });
  it('enforces REFUND/ROLLBACK references and forbids references for BET', () => {
    const a = envelope();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      expect(() => parseWagerRequest(JSON.stringify({ ...a, data: { ...a.data, kind } }))).toThrow(
        InvalidSqsMessageError,
      );
      expect(
        parseWagerRequest(
          JSON.stringify({
            ...a,
            data: { ...a.data, kind, referenceExternalTransactionId: 'other-bet' },
          }),
        ).command.referenceExternalTransactionId,
      ).toBe('other-bet');
    }
    expect(() =>
      parseWagerRequest(
        JSON.stringify({
          ...a,
          data: { ...a.data, referenceExternalTransactionId: 'other-bet' },
        }),
      ),
    ).toThrow(InvalidSqsMessageError);
  });
});
