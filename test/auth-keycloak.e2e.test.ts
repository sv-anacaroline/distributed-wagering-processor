import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

const suite = process.env.AUTH_E2E === '1' ? describe : describe.skip;
const realm = process.env.KEYCLOAK_BASE_URL ?? 'http://localhost:8080';
let app: INestApplication;
let http: Server;
let aToken: string;
let bToken: string;
let monitorToken: string;

async function token(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`${realm}/realms/wagering/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`Keycloak rejected ${clientId} (HTTP ${response.status})`);
  }
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error('No access token for ' + clientId);
  return data.access_token;
}

suite('Keycloak client credentials — real HTTP authorization and PostgreSQL', () => {
  beforeAll(async () => {
    process.env.HTTP_AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER ??= `${realm}/realms/wagering`;
    process.env.OIDC_JWKS_URL ??= `${realm}/realms/wagering/protocol/openid-connect/certs`;
    process.env.OIDC_AUDIENCE ??= 'wagering-api';
    aToken = await token('provider-a',
      process.env.KEYCLOAK_PROVIDER_A_SECRET ?? 'local-provider-a-change-me');
    bToken = await token('provider-b',
      process.env.KEYCLOAK_PROVIDER_B_SECRET ?? 'local-provider-b-change-me');
    monitorToken = await token('wagering-monitor',
      process.env.KEYCLOAK_MONITOR_SECRET ?? 'local-monitor-change-me');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    await app.init();
    http = app.getHttpServer() as Server;
  }, 90_000);
  afterAll(async () => {
    if (app) await app.close();
  });

  it('rejects anonymous and invalid Bearer tokens while leaving health public', async () => {
    await request(http).get('/health/live').expect(200);
    await request(http).post('/wallets')
      .send({ playerId: randomUUID(), initialBalance: { amount: '0.00', currency: 'BRL' } })
      .expect(401);
    await request(http).get('/wallets/' + randomUUID())
      .set('Authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('authenticates provider-a and prevents provider-b from accessing wallet, ledger and reconciliation', async () => {
    const walletResponse = await request(http).post('/wallets')
      .set('Authorization', 'Bearer ' + aToken)
      .send({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } })
      .expect(201);
    const wallet = walletResponse.body as { id: string; balance: { amount: string } };
    expect(wallet.balance.amount).toBe('100.00');
    await request(http).get('/wallets/' + wallet.id)
      .set('Authorization', 'Bearer ' + aToken).expect(200);
    await request(http).get('/wallets/' + wallet.id)
      .set('Authorization', 'Bearer ' + bToken).expect(403);
    await request(http).get('/wallets/' + wallet.id + '/ledger')
      .set('Authorization', 'Bearer ' + bToken).expect(403);
    await request(http).post('/wallets/' + wallet.id + '/reconciliation')
      .set('Authorization', 'Bearer ' + bToken).expect(403);

    const externalId = randomUUID();
    const command = {
      providerId: 'provider-a', externalTransactionId: externalId,
      playerId: walletResponse.body.playerId as string,
      walletId: wallet.id, roundId: 'round-a', gameId: 'game-a',
      kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
    };
    const key = 'provider-a:' + externalId;
    await request(http).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + bToken).set('Idempotency-Key', key)
      .send(command).expect(403);
    await request(http).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + bToken).set('Idempotency-Key', key)
      .send({ ...command, providerId: 'provider-b' }).expect(403);
    const processed = await request(http).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + aToken).set('Idempotency-Key', key)
      .send(command).expect(200);
    expect(processed.body.status).toBe('PROCESSED');
    expect(processed.body.balance.amount).toBe('75.00');
    const replay = await request(http).post('/wagering/transactions')
      .set('Authorization', 'Bearer ' + aToken).set('Idempotency-Key', key)
      .send(command).expect(200);
    expect(replay.body.idempotentReplay).toBe(true);
    const id = processed.body.transactionId as string;
    await request(http).get('/wagering/transactions/' + id)
      .set('Authorization', 'Bearer ' + bToken).expect(403);
    await request(http).get('/providers/provider-a/wagering/transactions/' + externalId)
      .set('Authorization', 'Bearer ' + bToken).expect(403);
    await request(http).get('/providers/provider-a/wagering/transactions/' + externalId)
      .set('Authorization', 'Bearer ' + aToken).expect(200);
    const current = await request(http).get('/wallets/' + wallet.id)
      .set('Authorization', 'Bearer ' + aToken).expect(200);
    expect(current.body.balance.amount).toBe('75.00');
    expect(current.body.version).toBe(2);
  });

  it('restricts operational metrics to the dedicated monitoring client', async () => {
    await request(http).get('/internal/metrics')
      .set('Authorization', 'Bearer ' + aToken).expect(403);
    await request(http).get('/internal/metrics')
      .set('Authorization', 'Bearer ' + bToken).expect(403);
    const result = await request(http).get('/internal/metrics')
      .set('Authorization', 'Bearer ' + monitorToken).expect(200);
    expect(result.text).toContain('wallet_reconciliation_divergences_total');
  });
});
