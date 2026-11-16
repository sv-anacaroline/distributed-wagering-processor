import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../domain/money.js';
import { type FailureCode, WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction.js';
import type { Wallet } from '../domain/wallet.js';

export interface WagerCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
}

/** Whitelist and order every accepted field so JSON key ordering never changes idempotency. */
export function payloadHash(command: WagerCommand): string {
  const money = Money.from(command.money).toJSON();
  const canonical = JSON.stringify({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    amount: money.amount,
    currency: money.currency,
    referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface WagerResult {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps;
  readonly walletVersion: number;
  readonly observedAt: string;
  readonly failureCode?: FailureCode;
  readonly referenceTransactionId?: string;
}

/** This snapshot, not the wallet's live balance, is returned for idempotent replays. */
export function responseSnapshot(tx: WagerTransaction, wallet: Wallet, at: Date): WagerResult {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    status: tx.status,
    balance: wallet.balance.toJSON(),
    walletVersion: wallet.version,
    observedAt: at.toISOString(),
    ...(tx.failureCode ? { failureCode: tx.failureCode } : {}),
    ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
  };
}
