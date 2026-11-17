import { randomUUID, createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money, type MoneyProps } from '../domain/money.js';
import { Wallet } from '../domain/wallet.js';
import { WalletLedgerEntry, LedgerDirection } from '../domain/wallet-ledger-entry.js';
import { WagerTransaction } from '../domain/wager-transaction.js';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';

interface WalletRow {
  readonly id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
  readonly created_at: Date;
}
interface LedgerRow {
  readonly id: string;
  readonly transaction_id: string;
  readonly direction: LedgerDirection;
  readonly amount: string;
  readonly currency: string;
  readonly balance_before: string;
  readonly balance_after: string;
  readonly created_at: Date;
}
export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
}
export interface LedgerView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
}

function sqlState(error: unknown): string | undefined {
  let node: unknown = error;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!node || typeof node !== 'object') return undefined;
    const value = node as Record<string, unknown>;
    if (typeof value.code === 'string') return value.code;
    node = value.driverException ?? value.cause;
  }
  return undefined;
}
function walletView(row: WalletRow): WalletView {
  return {
    id: row.id,
    playerId: row.player_id,
    balance: Money.from({ amount: row.balance, currency: row.currency }).toJSON(),
    version: row.version,
  };
}

@Injectable()
export class WalletService {
  constructor(@Inject(CoreEntityManager) private readonly em: EntityManager) {}

  async create(playerId: string, initialBalance: MoneyProps, providerId?: string): Promise<WalletView> {
    const balance = Money.from(initialBalance);
    const id = randomUUID();
    const at = new Date();
    const wallet = Wallet.open({ id, playerId, initialBalance: balance, at });
    try {
      return await this.em.fork().transactional(async (em) => {
        await em.execute(
          `insert into wallets(id,player_id,currency,balance,version,created_at,updated_at)
           values(?::uuid,?::uuid,?,?::numeric,1,?,?)`,
          [wallet.id, wallet.playerId, wallet.currency, wallet.balance.toJSON().amount, at, at],
        );
        if (providerId) {
          // Grant only as part of the wallet opening commit; a failed
          // ledger/OPENING transaction cannot leave a dangling access grant.
          await em.execute(
            'insert into wallet_provider_grants(wallet_id,provider_id) values (?::uuid,?)',
            [wallet.id, providerId],
          );
        }
        if (balance.isPositive()) {
          const transactionId = randomUUID();
          const tx = WagerTransaction.opening({
            id: transactionId,
            providerId: 'internal',
            externalTransactionId: transactionId,
            idempotencyKey: `opening:${id}`,
            payloadHash: createHash('sha256')
              .update(`opening:${id}:${balance.toString()}`)
              .digest('hex'),
            walletId: id,
            playerId,
            roundId: 'opening',
            gameId: 'internal',
            money: balance,
            createdAt: at,
          });
          tx.markProcessed(undefined, at);
          const ledger = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: id,
            transactionId: tx.id,
            direction: LedgerDirection.Credit,
            money: balance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: balance,
            createdAt: at,
          });
          await em.execute(
            `insert into wager_transactions(
               id,provider_id,external_transaction_id,idempotency_key,payload_hash,
               wallet_id,player_id,round_id,game_id,kind,amount,currency,
               status,created_at,processed_at
             ) values (?::uuid,?,?,?,?,?::uuid,?::uuid,?,?,?,?::numeric,?,?,?,?)`,
            [
              tx.id,
              tx.providerId,
              tx.externalTransactionId,
              tx.idempotencyKey,
              tx.payloadHash,
              id,
              playerId,
              tx.roundId,
              tx.gameId,
              tx.kind,
              balance.toJSON().amount,
              wallet.currency,
              tx.status,
              at,
              tx.processedAt,
            ],
          );
          await em.execute(
            `insert into wallet_ledger_entries(
               id,wallet_id,transaction_id,wallet_version,direction,amount,currency,
               balance_before,balance_after,created_at
             ) values (?::uuid,?::uuid,?::uuid,1,?,?::numeric,?,?::numeric,?::numeric,?)`,
            [
              ledger.id,
              id,
              transactionId,
              ledger.direction,
              ledger.money.toJSON().amount,
              wallet.currency,
              ledger.balanceBefore.toJSON().amount,
              ledger.balanceAfter.toJSON().amount,
              ledger.createdAt,
            ],
          );
        }
        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error: unknown) {
      if (sqlState(error) === '23505') {
        throw new ConflictException('Wallet already exists for playerId and currency');
      }
      throw error;
    }
  }

  async find(walletId: string): Promise<WalletView> {
    const [row] = await this.em
      .fork()
      .execute<WalletRow[]>(
        'select id,player_id,currency,balance::text as balance,version,created_at from wallets where id=?::uuid',
        [walletId],
      );
    if (!row) throw new NotFoundException('Wallet not found');
    return walletView(row);
  }

  async ledger(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<{
    items: LedgerView[];
    nextCursor: string | null;
  }> {
    await this.find(walletId);
    const at = cursor ? decodeLedgerCursor(cursor, walletId) : undefined;
    const query = `select id,transaction_id,direction,amount::text as amount,currency,
      balance_before::text as balance_before,balance_after::text as balance_after,created_at
      from wallet_ledger_entries where wallet_id=?::uuid
      ${at ? 'and (created_at,id) < (?::timestamptz,?::uuid)' : ''}
      order by created_at desc,id desc limit ?`;
    const result = await this.em
      .fork()
      .execute<LedgerRow[]>(
        query,
        at ? [walletId, at.createdAt, at.id, limit + 1] : [walletId, limit + 1],
      );
    const page = result.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        transactionId: row.transaction_id,
        direction: row.direction,
        money: { amount: row.amount, currency: row.currency },
        balanceBefore: { amount: row.balance_before, currency: row.currency },
        balanceAfter: { amount: row.balance_after, currency: row.currency },
        createdAt: new Date(row.created_at).toISOString(),
      })),
      nextCursor:
        result.length > limit && last
          ? encodeLedgerCursor({
              walletId,
              id: last.id,
              createdAt: new Date(last.created_at).toISOString(),
            })
          : null,
    };
  }
}
