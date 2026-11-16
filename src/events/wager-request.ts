import { createHash } from 'node:crypto';
import { Money } from '../domain/money.js';
import { WagerTransactionKind } from '../domain/wager-transaction.js';
import type { WagerCommand } from '../application/wager-contracts.js';

export class InvalidSqsMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSqsMessageError';
  }
}

export interface WagerRequest {
  readonly messageId: string;
  readonly occurredAt: string;
  readonly command: WagerCommand;
  readonly payloadHash: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const VALID_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSqsMessageError(`${label} must be an object`);
  }
  return raw as Record<string, unknown>;
}
function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new InvalidSqsMessageError(`${name} must be a nonempty identifier of at most 128 chars`);
  }
  return value;
}
function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new InvalidSqsMessageError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/**
 * Only a versioned business envelope is hashed. SQS receiptHandle, receiveCount,
 * delivery timestamp, AWS message IDs and request attributes are excluded.
 * All JSON object keys are recursively sorted before hashing with SHA-256.
 */
export function parseWagerRequest(body: string): WagerRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch {
    throw new InvalidSqsMessageError('Message body must be valid JSON');
  }
  const envelope = record(raw, 'message');
  const messageId = token(envelope.messageId, 'messageId');
  if (envelope.type !== 'WagerTransactionRequested') {
    throw new InvalidSqsMessageError('Unsupported integration message type');
  }
  if (typeof envelope.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(envelope.occurredAt)) ||
      new Date(envelope.occurredAt).toISOString() !== envelope.occurredAt) {
    throw new InvalidSqsMessageError('occurredAt must be ISO-8601 with milliseconds');
  }
  const data = record(envelope.data, 'data');
  if (typeof data.kind !== 'string' || !VALID_KINDS.has(data.kind)) {
    throw new InvalidSqsMessageError('Unsupported wager kind (OPENING is internal)');
  }
  const kind = data.kind as Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  const idempotencyKey = data.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 ||
      idempotencyKey.length > 256) {
    throw new InvalidSqsMessageError('idempotencyKey must be present (max 256 chars)');
  }
  const moneyFields = record(data.money, 'money');
  let money: ReturnType<Money['toJSON']>;
  try {
    const amount = Money.from({
      amount: moneyFields.amount as string, currency: moneyFields.currency as string,
    });
    if (!amount.isPositive()) throw new Error('Non-positive wager money');
    money = amount.toJSON();
  } catch {
    throw new InvalidSqsMessageError('money must be positive, exact decimal string with currency');
  }
  const reference = data.referenceExternalTransactionId === undefined
    ? undefined
    : token(data.referenceExternalTransactionId, 'referenceExternalTransactionId');
  if ([WagerTransactionKind.Refund, WagerTransactionKind.Rollback].includes(kind) && !reference) {
    throw new InvalidSqsMessageError('REFUND/ROLLBACK must contain referenceExternalTransactionId');
  }
  if (reference && ![WagerTransactionKind.Refund, WagerTransactionKind.Rollback, WagerTransactionKind.Win].includes(kind)) {
    throw new InvalidSqsMessageError('Reference not supported by this kind');
  }
  const command: WagerCommand = {
    providerId: token(data.providerId, 'providerId'),
    externalTransactionId: token(data.externalTransactionId, 'externalTransactionId'),
    idempotencyKey,
    walletId: uuid(data.walletId, 'walletId'),
    playerId: uuid(data.playerId, 'playerId'),
    roundId: token(data.roundId, 'roundId'),
    gameId: token(data.gameId, 'gameId'),
    kind,
    money,
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
  if (reference === command.externalTransactionId) {
    throw new InvalidSqsMessageError('Message cannot reference itself');
  }
  const logical = { messageId, type: 'WagerTransactionRequested', occurredAt: envelope.occurredAt, data: command };
  const payloadHash = createHash('sha256').update(JSON.stringify(canonical(logical))).digest('hex');
  return { messageId, occurredAt: envelope.occurredAt, command, payloadHash };
}
