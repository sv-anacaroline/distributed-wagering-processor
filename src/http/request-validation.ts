import { BadRequestException } from '@nestjs/common';
import { Money, type MoneyProps } from '../domain/money.js';
import { WagerTransactionKind } from '../domain/wager-transaction.js';
import type { WagerCommand } from '../application/wager-contracts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSINESS_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BET_KINDS: readonly string[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export function objectField(input: unknown, name = 'body'): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException(`${name} must be a JSON object`);
  }
  return input as Record<string, unknown>;
}
export function uuidField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}
export function textField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !BUSINESS_ID.test(value)) {
    throw new BadRequestException(`${name} must be a nonempty business identifier (max 128)`);
  }
  return value;
}
export function moneyField(value: unknown, positive = false): MoneyProps {
  const props = objectField(value, 'money');
  try {
    const result = Money.from({
      amount: props.amount as string,
      currency: props.currency as string,
    });
    if (positive && !result.isPositive()) {
      throw new BadRequestException('Wager money must be greater than zero');
    }
    return result.toJSON();
  } catch (error: unknown) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Money must contain a valid decimal string and currency');
  }
}
export function walletPayload(input: unknown): { playerId: string; initialBalance: MoneyProps } {
  const body = objectField(input);
  return {
    playerId: uuidField(body.playerId, 'playerId'),
    initialBalance: moneyField(body.initialBalance),
  };
}
export function wagerPayload(input: unknown, header: unknown): WagerCommand {
  const body = objectField(input);
  if (typeof header !== 'string' || !header.trim() || header.length > 256) {
    throw new BadRequestException('Idempotency-Key header is required (max 256 chars)');
  }
  if (typeof body.kind !== 'string' || !BET_KINDS.includes(body.kind)) {
    throw new BadRequestException('kind must be BET, WIN, LOSS, REFUND or ROLLBACK');
  }
  const kind = body.kind as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  const reference =
    body.referenceExternalTransactionId === undefined
      ? undefined
      : textField(body.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if (
    (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
    !reference
  ) {
    throw new BadRequestException('REFUND/ROLLBACK require referenceExternalTransactionId');
  }
  if (
    reference &&
    ![
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ].includes(kind)
  ) {
    throw new BadRequestException('Reference is not allowed for this operation');
  }
  return {
    providerId: textField(body.providerId, 'providerId'),
    externalTransactionId: textField(body.externalTransactionId, 'externalTransactionId'),
    idempotencyKey: header,
    playerId: uuidField(body.playerId, 'playerId'),
    walletId: uuidField(body.walletId, 'walletId'),
    roundId: textField(body.roundId, 'roundId'),
    gameId: textField(body.gameId, 'gameId'),
    kind,
    money: moneyField(body.money, true),
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}

export function pageLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,2}$/.test(raw)) {
    throw new BadRequestException('limit must be an integer between 1 and 100');
  }
  const limit = Number(raw);
  if (limit > 100) throw new BadRequestException('limit must be at most 100');
  return limit;
}
