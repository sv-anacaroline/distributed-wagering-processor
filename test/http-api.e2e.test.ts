import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}
interface WagerView {
  readonly transactionId: string;
  readonly status: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly idempotentReplay: boolean;
  readonly failureCode?: string;
  readonly walletVersion: number;
}
interface LedgerPage {
  readonly items: Array<{ id: string; direction: string; money: { amount: string } }>;
  readonly nextCursor: string | null;
}
let app: INestApplication;
let http: Server;
const uid = () => randomUUID();
const wager = (wallet: WalletView, kind = 'BET', amount = '25.00') => ({
  providerId: 'provider-a',
  externalTransactionId: uid(),
  playerId: wallet.playerId,
  walletId: wallet.id,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind,
  money: { amount, currency: 'BRL' },
});
async function createWallet(amount = '1000.00'): Promise<WalletView> {
  const response = await request(http).post('/wallets')
    .send({ playerId: uid(), initialBalance: { amount, currency: 'BRL' } })
    .expect(201);
  return response.body as WalletView;
}
async function submit(body: Record<string, unknown>, key: string, status: number): Promise<WagerView> {
  const response = await request(http).post('/wagering/transactions')
    .set('Idempotency-Key', key).send(body).expect(status);
  return response.body as WagerView;
}

beforeAll(async () => {
  process.env.HTTP_AUTH_MODE = 'disabled'; // Explicit test-only opt-out from the external IdP.
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.init();
  http = app.getHttpServer() as Server;
});
afterAll(async () => {
  await app.close();
});

describe('Section 9 REST API — actual PostgreSQL, no async SQS dependency', () => {
  it('creates a funded wallet, its internal OPENING and exactly one CREDIT ledger atomically', async () => {
    const playerId = uid();
    const created = await request(http).post('/wallets')
      .send({ playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } })
      .expect(201);
    const wallet = created.body as WalletView;
    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    const stored = await request(http).get(`/wallets/${wallet.id}`).expect(200);
    expect(stored.body).toEqual(wallet);

    const ledger = await request(http).get(`/wallets/${wallet.id}/ledger`).expect(200);
    const entries = ledger.body as LedgerPage;
    expect(entries.items).toHaveLength(1);
    expect(entries.items[0]?.direction).toBe('CREDIT');
    expect(entries.items[0]?.money.amount).toBe('1000.00');

    await request(http).post('/wallets')
      .send({ playerId, initialBalance: { amount: '1.00', currency: 'BRL' } })
      .expect(409);
  });

  it('creates a zero-balance wallet without any internal opening ledger', async () => {
    const wallet = await createWallet('0.00');
    expect(wallet.balance.amount).toBe('0.00');
    const ledger = await request(http).get(`/wallets/${wallet.id}/ledger`).expect(200);
    expect((ledger.body as LedgerPage).items).toHaveLength(0);
  });

  it('rejects invalid wallet amounts, IDs and a missing idempotency header', async () => {
    await request(http).post('/wallets')
      .send({ playerId: uid(), initialBalance: { amount: 1e3, currency: 'BRL' } })
      .expect(400);
    await request(http).get('/wallets/not-a-uuid').expect(400);
    await request(http).get(`/wallets/${uid()}`).expect(404);
    const wallet = await createWallet();
    await request(http).post('/wagering/transactions')
      .send(wager(wallet)).expect(400);
    await request(http).post('/wagering/transactions').set('Idempotency-Key', uid())
      .send({ ...wager(wallet), kind: 'OPENING' }).expect(400);
  });

  it('processes BET, replays the exact original response, and rejects changed payload hashes', async () => {
    const wallet = await createWallet();
    const command = wager(wallet);
    const key = 'provider-a:' + command.externalTransactionId;
    const first = await submit(command, key, 200);
    expect(first.status).toBe('PROCESSED');
    expect(first.balance.amount).toBe('975.00');
    expect(first.idempotentReplay).toBe(false);

    const win = wager(wallet, 'WIN', '50.00');
    await submit(win, 'provider-a:' + win.externalTransactionId, 200);
    const replay = await submit(command, key, 200);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.balance.amount).toBe('975.00');
    expect(replay.walletVersion).toBe(first.walletVersion);
    expect(replay.transactionId).toBe(first.transactionId);
    const conflict = await request(http).post('/wagering/transactions')
      .set('Idempotency-Key', key).send({ ...command, money: { amount: '24.00', currency: 'BRL' } })
      .expect(409);
    expect((conflict.body as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT');

    const internal = await request(http)
      .get(`/wagering/transactions/${first.transactionId}`).expect(200);
    expect((internal.body as { status: string }).status).toBe('PROCESSED');
    const external = await request(http)
      .get(`/providers/provider-a/wagering/transactions/${command.externalTransactionId}`)
      .expect(200);
    expect((external.body as { id: string }).id).toBe(first.transactionId);
  });

  it('distinguishes insufficient-funds rejection, LOSS and unresolved reference acceptance', async () => {
    const wallet = await createWallet('0.00');
    const bet = wager(wallet, 'BET', '1.00');
    const rejected = await submit(bet, uid(), 422);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
    const loss = await submit(wager(wallet, 'LOSS'), uid(), 200);
    expect(loss.status).toBe('PROCESSED');
    expect(loss.walletVersion).toBe(1);
    const pending = await submit({
      ...wager(wallet, 'REFUND'),
      referenceExternalTransactionId: 'bet-not-yet-seen',
    }, uid(), 202);
    expect(pending.status).toBe('PENDING_REFERENCE');
    const snapshot = await request(http)
      .get(`/wagering/transactions/${pending.transactionId}`).expect(200);
    expect((snapshot.body as { status: string }).status).toBe('PENDING_REFERENCE');
  });

  it('paginates ledger with a wallet-scoped opaque cursor and no repeated entries', async () => {
    const wallet = await createWallet();
    for (let i = 0; i < 3; i++) await submit(wager(wallet, 'BET', '1.00'), uid(), 200);
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const url = `/wallets/${wallet.id}/ledger?limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const response = await request(http).get(url).expect(200);
      const page = response.body as LedgerPage;
      expect(page.items).toHaveLength(1);
      const item = page.items[0];
      if (!item) throw new Error('Missing ledger entry');
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(4);
    await request(http).get(`/wallets/${wallet.id}/ledger?limit=101`).expect(400);
    const another = await createWallet();
    const page = (await request(http).get(`/wallets/${wallet.id}/ledger?limit=1`).expect(200)).body as LedgerPage;
    if (!page.nextCursor) throw new Error('Missing ledger cursor');
    await request(http).get(`/wallets/${another.id}/ledger?cursor=${encodeURIComponent(page.nextCursor)}`).expect(400);
  });

  it('returns reconciliation without changing the wallet or its ledger and exposes the metric', async () => {
    const wallet = await createWallet();
    await submit(wager(wallet), uid(), 200);
    const first = await request(http).post(`/wallets/${wallet.id}/reconciliation`).expect(201);
    const reconciliation = first.body as {
      walletId: string; storedBalance: { amount: string };
      calculatedBalance: { amount: string }; difference: { amount: string };
      consistent: boolean; checkedEntries: number;
    };
    expect(reconciliation.walletId).toBe(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('975.00');
    expect(reconciliation.calculatedBalance.amount).toBe('975.00');
    expect(reconciliation.difference.amount).toBe('0.00');
    expect(reconciliation.checkedEntries).toBe(2);
    const second = await request(http).post(`/wallets/${wallet.id}/reconciliation`).expect(201);
    expect(second.body).toEqual(first.body);
    const metric = await request(http).get('/internal/metrics').expect(200);
    expect(metric.text).toContain('wallet_reconciliation_divergences_total');
  });

  it('serializes competing BETs at the HTTP boundary without duplicate ledger debits', async () => {
    const wallet = await createWallet('100.00');
    const bets = [wager(wallet, 'BET', '80.00'), wager(wallet, 'BET', '80.00')];
    const replies = await Promise.all(bets.map(body =>
      request(http).post('/wagering/transactions')
        .set('Idempotency-Key', uid()).send(body),
    ));
    expect(replies.map(reply => reply.status).sort()).toEqual([200, 422]);
    const final = (await request(http).get(`/wallets/${wallet.id}`).expect(200)).body as WalletView;
    expect(final.balance.amount).toBe('20.00');
    expect(final.version).toBe(2);
    const page = (await request(http).get(`/wallets/${wallet.id}/ledger`).expect(200)).body as LedgerPage;
    expect(page.items.filter(item => item.direction === 'DEBIT')).toHaveLength(1);
  });

  it('keeps liveness public and reports PostgreSQL + SQS reachability separately', async () => {
    await request(http).get('/health/live').expect(200).expect({ status: 'live' });
    const original = process.env.SQS_ENDPOINT_URL;
    const mock = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
    await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
    const address = mock.address() as AddressInfo;
    process.env.SQS_ENDPOINT_URL = `http://127.0.0.1:${address.port}`;
    try {
      const response = await request(http).get('/health/ready').expect(200);
      expect(response.body).toEqual({ status: 'ready', postgres: 'up', sqs: 'up' });
    } finally {
      await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
      if (original === undefined) delete process.env.SQS_ENDPOINT_URL;
      else process.env.SQS_ENDPOINT_URL = original;
    }
  });
});
