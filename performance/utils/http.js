import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const baseUrl = (__ENV.BASE_URL || 'http://api:3000').replace(/\/$/, '');
const correctness = new Rate('financial_correctness');
const violations = new Counter('financial_invariant_violations');
const processed = new Counter('financial_bets_processed');
const rejected = new Counter('financial_bets_rejected');
const replays = new Counter('financial_idempotent_replays');
const betLatency = new Trend('financial_bet_batch_ms', true);
const routeNames = [
  'root',
  'health-live',
  'health-ready',
  'wallet-create',
  'wager-racing-bet',
  'wager-bet',
  'wallet-read',
  'ledger-read',
  'reconciliation',
  'wager-by-id',
  'wager-by-provider-external-id',
  'internal-metrics',
  'hot-wallet-read',
  'hot-wallet-ledger',
  'hot-wallet-reconciliation',
];
const routeTrends = Object.fromEntries(
  routeNames.map((route) => [route, new Trend(`financial_route_${route.replace(/-/g, '_')}_ms`, true)]),
);
function measured(response, route) {
  if (response?.timings && typeof response.timings.duration === 'number') {
    routeTrends[route].add(response.timings.duration);
  }
  return response;
}

const expectedBetStatuses = http.expectedStatuses(200, 422);
let cachedToken = '';
let expiresAt = 0;
let cachedMonitorToken = '';
let monitorExpiresAt = 0;

/** IDs are test-only correlation keys; financial amounts never use JS numbers. */
export function newId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const digit = Math.floor(Math.random() * 16);
    return (char === 'x' ? digit : (digit & 3) | 8).toString(16);
  });
}

export function authHeaders() {
  if ((__ENV.K6_AUTH_MODE || 'oidc') === 'disabled') return {};
  if (__ENV.K6_AUTH_TOKEN) return { Authorization: `Bearer ${__ENV.K6_AUTH_TOKEN}` };
  if (cachedToken && Date.now() < expiresAt) {
    return { Authorization: `Bearer ${cachedToken}` };
  }
  if (!__ENV.K6_OIDC_TOKEN_URL || !__ENV.K6_OIDC_CLIENT_ID || !__ENV.K6_OIDC_CLIENT_SECRET) {
    fail(
      'OIDC load test requires K6_OIDC_TOKEN_URL, CLIENT_ID and CLIENT_SECRET (or K6_AUTH_MODE=disabled)',
    );
  }
  const response = http.post(
    __ENV.K6_OIDC_TOKEN_URL,
    {
      grant_type: 'client_credentials',
      client_id: __ENV.K6_OIDC_CLIENT_ID,
      client_secret: __ENV.K6_OIDC_CLIENT_SECRET,
    },
    { tags: { endpoint: 'oidc-token' }, timeout: '10s' },
  );
  if (response.status !== 200) fail(`OIDC token request failed: HTTP ${response.status}`);
  const token = response.json('access_token');
  const seconds = Number(response.json('expires_in') || 60);
  if (typeof token !== 'string' || !token) fail('OIDC access_token is missing');
  cachedToken = token;
  expiresAt = Date.now() + Math.max(5, seconds - 20) * 1000;
  return { Authorization: `Bearer ${cachedToken}` };
}

function monitorHeaders() {
  if ((__ENV.K6_AUTH_MODE || 'oidc') === 'disabled') return {};
  if (__ENV.K6_MONITOR_AUTH_TOKEN) {
    return { Authorization: `Bearer ${__ENV.K6_MONITOR_AUTH_TOKEN}` };
  }
  if (cachedMonitorToken && Date.now() < monitorExpiresAt) {
    return { Authorization: `Bearer ${cachedMonitorToken}` };
  }
  const clientId = __ENV.K6_OIDC_MONITOR_CLIENT_ID || 'wagering-monitor';
  const secret = __ENV.K6_OIDC_MONITOR_CLIENT_SECRET;
  if (!__ENV.K6_OIDC_TOKEN_URL || !secret) {
    fail('Metrics route needs an independent monitoring OIDC client');
  }
  const response = http.post(
    __ENV.K6_OIDC_TOKEN_URL,
    {
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
    },
    { tags: { endpoint: 'oidc-monitor-token' }, timeout: '10s' },
  );
  if (response.status !== 200) fail(`Monitor token request failed: HTTP ${response.status}`);
  const token = response.json('access_token');
  if (typeof token !== 'string' || !token) fail('Monitoring access_token missing');
  cachedMonitorToken = token;
  const expires = Number(response.json('expires_in') || 60);
  monitorExpiresAt = Date.now() + Math.max(5, expires - 20) * 1000;
  return { Authorization: `Bearer ${cachedMonitorToken}` };
}

function params(endpoint, statuses = null) {
  return {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    tags: { endpoint },
    timeout: '15s',
    ...(statuses ? { responseCallback: statuses } : {}),
  };
}

function json(response) {
  if (!response) return null;
  try {
    return response.json();
  } catch {
    return null;
  }
}

export function waitForApp() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = http.get(`${baseUrl}/health/live`, { timeout: '3s' });
    if (response.status === 200) return;
    sleep(1);
  }
  fail(`NestJS financial service not reachable at ${baseUrl}/health/live`);
}

export function createFinancialWallet(amount = '100.00') {
  const playerId = newId();
  const response = http.post(
    `${baseUrl}/wallets`,
    JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
    params('wallet-create'),
  );
  measured(response, 'wallet-create');
  const wallet = json(response);
  if (response.status !== 201 || !wallet || !wallet.id) {
    fail(`Cannot create a financial wallet: HTTP ${response.status}`);
  }
  return { walletId: wallet.id, playerId };
}

export function wagerRequest(wallet, amount = '80.00') {
  const externalTransactionId = newId();
  return {
    providerId: __ENV.K6_OIDC_CLIENT_ID || 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'k6-race',
    gameId: 'k6-financial',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

export function submitBet(command) {
  return measured(http.post(`${baseUrl}/wagering/transactions`, JSON.stringify(command), {
    ...params('wager-bet', expectedBetStatuses),
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      'Idempotency-Key': `${command.providerId}:${command.externalTransactionId}`,
    },
  }), 'wager-bet');
}

export function financialIteration() {
  const wallet = createFinancialWallet();
  const first = wagerRequest(wallet);
  const second = wagerRequest(wallet);
  const requests = [first, second].map((command) => ({
    method: 'POST',
    url: `${baseUrl}/wagering/transactions`,
    body: JSON.stringify(command),
    params: {
      ...params('wager-racing-bet', expectedBetStatuses),
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        'Idempotency-Key': `${command.providerId}:${command.externalTransactionId}`,
      },
    },
  }));
  const start = Date.now();
  const responses = http.batch(requests);
  for (const response of responses) measured(response, 'wager-racing-bet');
  betLatency.add(Date.now() - start);
  const succeeded = responses.filter((r) => r.status === 200);
  const denied = responses.filter((r) => r.status === 422);
  const winningCommand = responses[0]?.status === 200 ? first : second;
  const win = json(succeeded[0]);
  const reject = json(denied[0]);
  const oneWinner =
    succeeded.length === 1 &&
    denied.length === 1 &&
    win?.status === 'PROCESSED' &&
    reject?.status === 'REJECTED' &&
    reject?.failureCode === 'INSUFFICIENT_FUNDS';
  if (succeeded.length) processed.add(succeeded.length);
  if (denied.length) rejected.add(denied.length);

  const repeat = oneWinner ? submitBet(winningCommand) : null;
  const replay = repeat ? json(repeat) : null;
  const historicalReplay =
    repeat?.status === 200 &&
    replay?.idempotentReplay === true &&
    replay?.transactionId === win?.transactionId &&
    replay?.balance?.amount === win?.balance?.amount;
  if (historicalReplay) replays.add(1);

  const balance = measured(
    http.get(`${baseUrl}/wallets/${wallet.walletId}`, params('wallet-read')),
    'wallet-read',
  );
  const ledger = measured(
    http.get(`${baseUrl}/wallets/${wallet.walletId}/ledger?limit=10`, params('ledger-read')),
    'ledger-read',
  );
  const recon = measured(
    http.post(`${baseUrl}/wallets/${wallet.walletId}/reconciliation`, '{}', params('reconciliation')),
    'reconciliation',
  );
  // Exercise every HTTP route, including operational and both read models.
  // Individual endpoint tags give separate p50/p95/p99 distributions in k6.
  const root = measured(http.get(`${baseUrl}/`, params('root')), 'root');
  const live = measured(http.get(`${baseUrl}/health/live`, params('health-live')), 'health-live');
  const ready = measured(http.get(`${baseUrl}/health/ready`, params('health-ready')), 'health-ready');
  const byId = oneWinner
    ? measured(
        http.get(`${baseUrl}/wagering/transactions/${win.transactionId}`, params('wager-by-id')),
        'wager-by-id',
      )
    : null;
  const byExternal = oneWinner
    ? measured(
        http.get(
          `${baseUrl}/providers/${winningCommand.providerId}/wagering/transactions/${winningCommand.externalTransactionId}`,
          params('wager-by-provider-external-id'),
        ),
        'wager-by-provider-external-id',
      )
    : null;
  const metrics = measured(
    http.get(`${baseUrl}/internal/metrics`, {
      ...params('internal-metrics'),
      headers: { ...monitorHeaders() },
    }),
    'internal-metrics',
  );
  const allRoutes =
    root.status === 200 &&
    live.status === 200 &&
    ready.status === 200 &&
    byId?.status === 200 &&
    json(byId)?.id === win?.transactionId &&
    byExternal?.status === 200 &&
    json(byExternal)?.id === win?.transactionId &&
    metrics.status === 200 &&
    String(metrics.body).includes('wallet_reconciliation_divergences_total');
  const walletView = json(balance);
  const ledgerView = json(ledger);
  const reconciled = json(recon);
  const rows = ledgerView?.items || [];
  const exact =
    balance.status === 200 &&
    walletView?.balance?.amount === '20.00' &&
    walletView?.version === 2 &&
    ledger.status === 200 &&
    rows.length === 2 &&
    rows.filter((row) => row.direction === 'DEBIT').length === 1 &&
    rows.filter((row) => row.direction === 'CREDIT').length === 1 &&
    recon.status === 200 &&
    reconciled?.consistent === true &&
    reconciled?.calculatedBalance?.amount === '20.00';
  const correct = oneWinner && historicalReplay && exact && allRoutes;
  correctness.add(correct);
  if (!correct) violations.add(1);
  check(
    { correct },
    { 'financial race, replay, ledger and reconciliation agree': (v) => v.correct },
  );
  sleep(0.15);
}

export function hotWalletBet(wallet) {
  const command = wagerRequest(wallet);
  const response = submitBet(command);
  const result = json(response);
  const allowed =
    (response.status === 200 && result?.status === 'PROCESSED') ||
    (response.status === 422 &&
      result?.status === 'REJECTED' &&
      result?.failureCode === 'INSUFFICIENT_FUNDS');
  correctness.add(allowed);
  if (!allowed) violations.add(1);
  if (response.status === 200) processed.add(1);
  if (response.status === 422) rejected.add(1);
  check(
    { allowed },
    { 'contended bet resolves to exactly one valid business outcome': (v) => v.allowed },
  );
}

export function verifyHotWallet(wallet) {
  const balance = measured(
    http.get(`${baseUrl}/wallets/${wallet.walletId}`, params('hot-wallet-read')),
    'hot-wallet-read',
  );
  const ledger = measured(
    http.get(`${baseUrl}/wallets/${wallet.walletId}/ledger?limit=10`, params('hot-wallet-ledger')),
    'hot-wallet-ledger',
  );
  const recon = measured(
    http.post(
      `${baseUrl}/wallets/${wallet.walletId}/reconciliation`,
      '{}',
      params('hot-wallet-reconciliation'),
    ),
    'hot-wallet-reconciliation',
  );
  const rows = json(ledger)?.items || [];
  const correct =
    balance.status === 200 &&
    json(balance)?.balance?.amount === '20.00' &&
    json(balance)?.version === 2 &&
    ledger.status === 200 &&
    rows.filter((row) => row.direction === 'DEBIT').length === 1 &&
    rows.filter((row) => row.direction === 'CREDIT').length === 1 &&
    recon.status === 200 &&
    json(recon)?.consistent === true;
  correctness.add(correct);
  if (!correct) violations.add(1);
  check({ correct }, { 'hot wallet has exactly one debit and reconciles': (v) => v.correct });
  if (!correct) fail('Shared hot-wallet financial invariant violated');
}
