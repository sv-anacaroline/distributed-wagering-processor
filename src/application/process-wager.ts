import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/postgresql';
import { DomainError, InvalidDomainStateError } from '../domain/errors.js';
import { Money } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  FailureCode,
} from '../domain/wager-transaction.js';
import { WagerTransactionProcessed } from '../domain/wager-transaction-processed.js';
import { WagerTransactionRejected } from '../domain/wager-transaction-rejected.js';
import { WagerTransactionPendingReference } from '../domain/wager-transaction-pending-reference.js';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed.js';
import { OutboxMessage } from '../domain/outbox-message.js';
import type { IntegrationEvent } from '../domain/integration-event.js';
import { applyWagerRules } from './wager-rules.js';
import { initialReferenceRetry, nextReferenceRetry } from './reference-retry.js';
import { withTransactionRetry } from './transaction-retry.js';
import {
  payloadHash,
  responseSnapshot,
  type WagerCommand,
  type WagerResult,
} from './wager-contracts.js';

interface WalletRow {
  readonly id: string;
  readonly player_id: string;
  readonly balance: string;
  readonly currency: string;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}
interface WagerRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_transaction_id: string;
  readonly idempotency_key: string;
  readonly payload_hash: string;
  readonly wallet_id: string;
  readonly player_id: string;
  readonly round_id: string;
  readonly game_id: string;
  readonly kind: Kind;
  readonly amount: string;
  readonly currency: string;
  readonly reference_external_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly created_at: Date;
  readonly processed_at: Date | null;
  readonly status: Status;
  readonly failure_code: FailureCode | null;
  readonly response_snapshot: WagerResult | null;
  readonly reference_retry_attempts: number;
  readonly reference_next_attempt_at: Date | null;
  readonly reference_expires_at: Date | null;
}
interface DueReferenceRow {
  readonly id: string;
  readonly wallet_id: string;
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key or provider transaction ID conflicts with a different payload',
    );
  }
}
function domainWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}
function domainWager(row: WagerRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    ...(row.reference_external_transaction_id
      ? { referenceExternalTransactionId: row.reference_external_transaction_id }
      : {}),
    ...(row.reference_transaction_id
      ? { referenceTransactionId: row.reference_transaction_id }
      : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    ...(row.processed_at ? { processedAt: new Date(row.processed_at) } : {}),
    status: row.status,
    createdAt: new Date(row.created_at),
  });
}
async function rows<T>(em: EntityManager, sql: string, values: unknown[] = []): Promise<T[]> {
  return em.execute<T[]>(sql, values, 'all');
}
async function lockWallet(em: EntityManager, walletId: string): Promise<Wallet> {
  const [row] = await rows<WalletRow>(em, 'select * from wallets where id=? for no key update', [
    walletId,
  ]);
  if (!row) throw new InvalidDomainStateError('Wallet not found');
  return domainWallet(row);
}
async function dbNow(em: EntityManager, wallet: Wallet): Promise<Date> {
  const [row] = await rows<{ at: Date }>(
    em,
    'select greatest(clock_timestamp(), ?::timestamptz) as at',
    [wallet.updatedAt],
  );
  if (!row) throw new InvalidDomainStateError('Database clock unavailable');
  return new Date(row.at);
}
async function findExisting(em: EntityManager, cmd: WagerCommand): Promise<WagerRow | undefined> {
  const found = await rows<WagerRow>(
    em,
    `
    select * from wager_transactions
    where idempotency_key=? or (provider_id=? and external_transaction_id=?)
    order by id for update
  `,
    [cmd.idempotencyKey, cmd.providerId, cmd.externalTransactionId],
  );
  // Two distinct existing rows claiming the two identities are always a conflict.
  if (found.length > 1) throw new IdempotencyConflictError();
  return found[0];
}
function replay(row: WagerRow, hash: string): WagerResult {
  if (row.payload_hash !== hash) throw new IdempotencyConflictError();
  if (!row.response_snapshot) throw new InvalidDomainStateError('Recorded result is not available');
  // Detach immutable historical data from any persistence identity map.
  return structuredClone(row.response_snapshot);
}
async function findReference(
  em: EntityManager,
  tx: WagerTransaction,
): Promise<WagerTransaction | undefined> {
  if (!tx.referenceExternalTransactionId) return undefined;
  const [row] = await rows<WagerRow>(
    em,
    `
    select * from wager_transactions
    where provider_id=? and external_transaction_id=?
  `,
    [tx.providerId, tx.referenceExternalTransactionId],
  );
  return row ? domainWager(row) : undefined;
}
async function activeReversal(em: EntityManager, tx: WagerTransaction): Promise<boolean> {
  if (![Kind.Refund, Kind.Rollback].includes(tx.kind) || !tx.referenceExternalTransactionId) {
    return false;
  }
  const [row] = await rows<{ id: string }>(
    em,
    `
    select id from wager_transactions
    where provider_id=? and reference_external_transaction_id=?
      and kind in ('REFUND','ROLLBACK')
      and status in ('PENDING','PENDING_REFERENCE','PROCESSED')
      and id<>? limit 1
  `,
    [tx.providerId, tx.referenceExternalTransactionId, tx.id],
  );
  return Boolean(row);
}
async function emit(em: EntityManager, event: IntegrationEvent<unknown>): Promise<void> {
  const outbox = OutboxMessage.enqueue(event);
  await em.execute(
    `
    insert into outbox_messages(id, aggregate_id, event_type, payload, occurred_at, attempts)
    values (?::uuid, ?::uuid, ?, ?::jsonb, ?, 0)
  `,
    [
      outbox.id,
      outbox.aggregateId,
      outbox.eventType,
      JSON.stringify(outbox.payload),
      outbox.occurredAt,
    ],
  );
}
async function emitResult(
  em: EntityManager,
  tx: WagerTransaction,
  wallet: Wallet,
  at: Date,
  ledger?: ReturnType<Wallet['debit']>,
): Promise<void> {
  const ctx = { eventId: randomUUID(), correlationId: tx.idempotencyKey, causationId: tx.id, at };
  if (tx.status === Status.Processed) {
    await emit(em, WagerTransactionProcessed.from(tx, ctx));
    if (ledger) {
      await emit(em, WalletBalanceChanged.from(wallet, ledger, { ...ctx, eventId: randomUUID() }));
    }
  } else if (tx.status === Status.Rejected) {
    await emit(em, WagerTransactionRejected.from(tx, ctx));
  } else if (tx.status === Status.PendingReference) {
    await emit(em, WagerTransactionPendingReference.from(tx, ctx));
  }
}
async function persist(
  em: EntityManager,
  tx: WagerTransaction,
  wallet: Wallet,
  at: Date,
  ledger?: ReturnType<Wallet['debit']>,
  retry?: { readonly attempts: number; readonly nextAttemptAt: Date; readonly expiresAt: Date },
  publishEvent = true,
): Promise<WagerResult> {
  const response = responseSnapshot(tx, wallet, at);
  if (ledger) {
    const changes = await em.execute<{ affectedRows?: number }>(
      `
      update wallets set balance=?, version=?, updated_at=?
      where id=? and version=?
    `,
      [
        wallet.balance.toJSON().amount,
        wallet.version,
        wallet.updatedAt,
        wallet.id,
        wallet.version - 1,
      ],
      'run',
    );
    if (changes.affectedRows !== 1)
      throw new InvalidDomainStateError('Concurrent wallet write detected');
    await em.execute(
      `
      insert into wallet_ledger_entries(
        id, wallet_id, transaction_id, wallet_version, direction,
        amount, currency, balance_before, balance_after, created_at
      ) values(?::uuid, ?::uuid, ?::uuid, ?, ?, ?::numeric, ?, ?::numeric, ?::numeric, ?)
    `,
      [
        ledger.id,
        ledger.walletId,
        ledger.transactionId,
        wallet.version,
        ledger.direction,
        ledger.money.toJSON().amount,
        ledger.money.currency,
        ledger.balanceBefore.toJSON().amount,
        ledger.balanceAfter.toJSON().amount,
        ledger.createdAt,
      ],
    );
  }
  await em.execute(
    `
    update wager_transactions set
      status=?, reference_transaction_id=?::uuid, failure_code=?, processed_at=?,
      response_snapshot=?::jsonb,
      reference_retry_attempts=coalesce(?, reference_retry_attempts),
      reference_next_attempt_at=coalesce(?, reference_next_attempt_at),
      reference_expires_at=coalesce(?, reference_expires_at)
    where id=?::uuid
  `,
    [
      tx.status,
      tx.referenceTransactionId ?? null,
      tx.failureCode ?? null,
      tx.processedAt ?? null,
      JSON.stringify(response),
      retry?.attempts ?? null,
      retry?.nextAttemptAt ?? null,
      retry?.expiresAt ?? null,
      tx.id,
    ],
  );
  if (publishEvent) await emitResult(em, tx, wallet, at, ledger);
  return response;
}

/** Single shared orchestration for future HTTP and SQS entrypoints, with no global locks. */
export class ProcessWager {
  constructor(private readonly em: EntityManager) {}

  /** Each retry uses a fresh EntityManager + SQL transaction after releasing locks. */
  private async transaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return withTransactionRetry(() => this.em.fork().transactional(work, { clear: true }));
  }

  async process(cmd: WagerCommand): Promise<WagerResult> {
    return (await this.processWithReplay(cmd)).result;
  }

  /** Indicates actual replay from the locked SQL row; never guesses from live balance. */
  async processWithReplay(cmd: WagerCommand): Promise<{
    result: WagerResult;
    idempotentReplay: boolean;
  }> {
    const money = Money.from(cmd.money);
    const hash = payloadHash(cmd);
    return this.transaction(async (em) => {
      // Lock ordering: wallet first, then wager rows. The retry worker uses the same order.
      const wallet = await lockWallet(em, cmd.walletId);
      const recorded = await findExisting(em, cmd);
      if (recorded) return { result: replay(recorded, hash), idempotentReplay: true };

      const at = await dbNow(em, wallet);
      const tx = WagerTransaction.create({
        ...cmd,
        id: randomUUID(),
        money,
        payloadHash: hash,
        createdAt: at,
      });

      // Cross-kind active compensation must be checked before inserting the
      // PENDING row, otherwise PostgreSQL would reject the unique active index.
      const blocked = await activeReversal(em, tx);
      if (blocked) tx.reject(FailureCode.AlreadyReversed);
      const inserted = await rows<{ id: string }>(
        em,
        `
        insert into wager_transactions(
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          reference_external_transaction_id, status, failure_code, created_at,
          response_snapshot
        ) values(
          ?::uuid, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, ?, ?, ?::numeric, ?, ?, ?, ?, ?, ?::jsonb
        ) on conflict do nothing returning id
      `,
        [
          tx.id,
          tx.providerId,
          tx.externalTransactionId,
          tx.idempotencyKey,
          tx.payloadHash,
          tx.walletId,
          tx.playerId,
          tx.roundId,
          tx.gameId,
          tx.kind,
          tx.money.toJSON().amount,
          tx.money.currency,
          tx.referenceExternalTransactionId ?? null,
          tx.status,
          tx.failureCode ?? null,
          tx.createdAt,
          blocked ? JSON.stringify(responseSnapshot(tx, wallet, at)) : null,
        ],
      );
      if (inserted.length === 0) {
        const collided = await findExisting(em, cmd);
        if (collided) return { result: replay(collided, hash), idempotentReplay: true };
        throw new InvalidDomainStateError('Conflicting active financial reversal');
      }
      if (blocked) {
        const snapshot = responseSnapshot(tx, wallet, at);
        await emitResult(em, tx, wallet, at);
        return { result: snapshot, idempotentReplay: false };
      }

      const reference = await findReference(em, tx);
      const hasActiveReversal = await activeReversal(em, tx);
      const result = applyWagerRules({
        wallet,
        transaction: tx,
        ...(reference ? { reference } : {}),
        hasActiveReversal,
        ledgerEntryId: randomUUID(),
        at,
      });
      const snapshot = await persist(
        em,
        tx,
        wallet,
        at,
        result.ledgerEntry,
        tx.status === Status.PendingReference ? initialReferenceRetry(at) : undefined,
      );
      return { result: snapshot, idempotentReplay: false };
    });
  }

  /** Called by a database-backed scheduler; never reprocesses a terminal row. */
  async retryPending(id: string, walletId: string): Promise<WagerResult | null> {
    return this.transaction(async (em) => {
      const wallet = await lockWallet(em, walletId);
      const [row] = await rows<WagerRow>(
        em,
        `
        select * from wager_transactions where id=?::uuid and wallet_id=?::uuid for update
      `,
        [id, walletId],
      );
      if (!row || row.status !== Status.PendingReference) return null;
      const at = await dbNow(em, wallet);
      if (!row.reference_next_attempt_at || !row.reference_expires_at) {
        throw new InvalidDomainStateError('Missing reference retry schedule');
      }
      if (at < row.reference_next_attempt_at) return null;
      const tx = domainWager(row);
      const retry = nextReferenceRetry(
        {
          attempts: row.reference_retry_attempts,
          nextAttemptAt: new Date(row.reference_next_attempt_at),
          expiresAt: new Date(row.reference_expires_at),
        },
        at,
      );
      if (retry.expired) {
        tx.reject(FailureCode.ReferenceNotFound);
        return persist(em, tx, wallet, at);
      }
      const reference = await findReference(em, tx);
      if (
        !reference ||
        reference.status === Status.Pending ||
        reference.status === Status.PendingReference
      ) {
        // Only the first PENDING_REFERENCE transition generated an event.
        await em.execute(
          `
          update wager_transactions set reference_retry_attempts=?, reference_next_attempt_at=?
          where id=?::uuid
        `,
          [retry.state.attempts, retry.state.nextAttemptAt, id],
        );
        return null;
      }
      const result = applyWagerRules({
        wallet,
        transaction: tx,
        reference,
        hasActiveReversal: await activeReversal(em, tx),
        ledgerEntryId: randomUUID(),
        at,
      });
      return persist(em, tx, wallet, at, result.ledgerEntry);
    });
  }

  /** Search is intentionally lock-free; retryPending rechecks after wallet FOR UPDATE. */
  async dueReferences(batchSize = 25): Promise<readonly { id: string; walletId: string }[]> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      throw new InvalidDomainStateError('Invalid retry batch size');
    }
    const found = await rows<DueReferenceRow>(
      this.em.fork(),
      `
      select id, wallet_id from wager_transactions
      where status='PENDING_REFERENCE' and reference_next_attempt_at <= clock_timestamp()
      order by reference_next_attempt_at, id limit ?
    `,
      [batchSize],
    );
    return found.map((row) => ({ id: row.id, walletId: row.wallet_id }));
  }
}
