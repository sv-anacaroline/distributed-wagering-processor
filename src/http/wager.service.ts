import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ProcessWager } from '../application/process-wager.js';
import type { WagerCommand, WagerResult } from '../application/wager-contracts.js';
import type { WagerTransactionKind, WagerTransactionStatus, FailureCode } from '../domain/wager-transaction.js';
import type { MoneyProps } from '../domain/money.js';

interface TransactionRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly wallet_id: string;
  readonly player_id: string;
  readonly round_id: string;
  readonly game_id: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly amount: string;
  readonly currency: string;
  readonly reference_external_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly failure_code: FailureCode | null;
  readonly created_at: Date;
  readonly processed_at: Date | null;
  readonly response_snapshot: WagerResult | null;
}
export interface TransactionView {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly money: MoneyProps;
  readonly createdAt: string;
  readonly processedAt?: string;
  readonly failureCode?: FailureCode;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly result?: WagerResult;
}
function transactionView(row: TransactionRow): TransactionView {
  return {
    id: row.id, providerId: row.provider_id, externalTransactionId: row.external_transaction_id,
    walletId: row.wallet_id, playerId: row.player_id, roundId: row.round_id,
    gameId: row.game_id, kind: row.kind, status: row.status,
    money: { amount: row.amount, currency: row.currency },
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.processed_at ? { processedAt: new Date(row.processed_at).toISOString() } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.reference_external_transaction_id ? { referenceExternalTransactionId: row.reference_external_transaction_id } : {}),
    ...(row.reference_transaction_id ? { referenceTransactionId: row.reference_transaction_id } : {}),
    ...(row.response_snapshot ? { result: row.response_snapshot } : {}),
  };
}

@Injectable()
export class WagerService {
  constructor(@Inject(CoreEntityManager) private readonly em: EntityManager) {}

  async submit(command: WagerCommand): Promise<WagerResult & { idempotentReplay: boolean }> {
    const processed = await new ProcessWager(this.em).processWithReplay(command);
    return { ...processed.result, idempotentReplay: processed.idempotentReplay };
  }

  async findById(id: string): Promise<TransactionView> {
    const [row] = await this.em.fork().execute<TransactionRow[]>(
      `select id,provider_id,external_transaction_id,wallet_id,player_id,round_id,game_id,
        kind,status,amount::text as amount,currency,reference_external_transaction_id,
        reference_transaction_id,failure_code,created_at,processed_at,response_snapshot
        from wager_transactions where id=?::uuid`,
      [id],
    );
    if (!row) throw new NotFoundException('Wager transaction not found');
    return transactionView(row);
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const [row] = await this.em.fork().execute<TransactionRow[]>(
      `select id,provider_id,external_transaction_id,wallet_id,player_id,round_id,game_id,
        kind,status,amount::text as amount,currency,reference_external_transaction_id,
        reference_transaction_id,failure_code,created_at,processed_at,response_snapshot
        from wager_transactions where provider_id=? and external_transaction_id=?`,
      [providerId, externalTransactionId],
    );
    if (!row) throw new NotFoundException('Wager transaction not found');
    return transactionView(row);
  }
}
