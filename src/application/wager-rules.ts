import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidReferenceError,
  InvalidTransactionStateError,
} from '../domain/errors.js';
import { WagerTransactionKind, WagerTransactionStatus, FailureCode, type WagerTransaction } from '../domain/wager-transaction.js';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry.js';
import type { Wallet } from '../domain/wallet.js';

export interface WagerRuleInput {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId) within the SQL transaction. */
  readonly reference?: WagerTransaction;
  /** Any active REFUND/ROLLBACK of the same original, including cross-kind. */
  readonly hasActiveReversal: boolean;
  readonly ledgerEntryId: string;
  readonly at: Date;
}

export interface WagerRuleResult {
  readonly transaction: WagerTransaction;
  readonly ledgerEntry?: WalletLedgerEntry;
}

/**
 * Pure financial decisions, independent of HTTP, SQS and the ORM.
 * Caller must persist the returned wallet, transaction and optional ledger atomically.
 */
export function applyWagerRules(input: WagerRuleInput): WagerRuleResult {
  const { transaction: tx, wallet, reference, at } = input;
  if (tx.isTerminal()) throw new InvalidTransactionStateError('Cannot reprocess a terminal wager');

  const reject = (code: FailureCode): WagerRuleResult => {
    tx.reject(code);
    return { transaction: tx };
  };
  const unresolved = tx.referenceExternalTransactionId !== undefined && !reference;
  if (unresolved) {
    tx.markPendingReference();
    return { transaction: tx };
  }
  if (reference && reference.status !== WagerTransactionStatus.Processed) {
    if (reference.isTerminal()) return reject(FailureCode.ReferenceNotProcessed);
    tx.markPendingReference();
    return { transaction: tx };
  }

  if (
    (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback) &&
    input.hasActiveReversal
  ) {
    return reject(FailureCode.AlreadyReversed);
  }

  // The reference and its amount are validated by the domain entity.
  let direction: LedgerDirection | null;
  try {
    direction = tx.ledgerDirectionFor(reference);
  } catch (error: unknown) {
    if (!(error instanceof InvalidReferenceError)) throw error;
    if (
      reference &&
      (tx.kind === WagerTransactionKind.Refund || tx.kind === WagerTransactionKind.Rollback) &&
      reference.providerId === tx.providerId &&
      reference.walletId === tx.walletId &&
      reference.playerId === tx.playerId &&
      reference.roundId === tx.roundId &&
      reference.gameId === tx.gameId &&
      reference.money.currency === tx.money.currency &&
      !reference.money.equals(tx.money)
    ) {
      return reject(FailureCode.ReferenceAmountMismatch);
    }
    return reject(FailureCode.InvalidReference);
  }

  if (wallet.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);
  if (wallet.id !== tx.walletId || wallet.playerId !== tx.playerId) {
    return reject(FailureCode.InvalidReference);
  }
  if (at.getTime() < tx.createdAt.getTime()) {
    throw new InvalidTransactionStateError('Processing timestamp precedes the transaction');
  }

  let ledgerEntry: WalletLedgerEntry | undefined;
  if (direction !== null) {
    const movement = { transactionId: tx.id, ledgerEntryId: input.ledgerEntryId, money: tx.money, at };
    try {
      ledgerEntry =
        direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error: unknown) {
      if (error instanceof InsufficientFundsError) {
        return reject(
          tx.kind === WagerTransactionKind.Rollback
            ? FailureCode.ReversalInsufficientFunds
            : FailureCode.InsufficientFunds,
        );
      }
      if (error instanceof CurrencyMismatchError) return reject(FailureCode.CurrencyMismatch);
      throw error;
    }
  }

  tx.markProcessed(reference?.id, at);
  return { transaction: tx, ...(ledgerEntry ? { ledgerEntry } : {}) };
}
