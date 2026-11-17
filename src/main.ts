import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module.js';
import { count, duration, log, startSpan, startTelemetry } from './telemetry/otel.js';

/** The route TEMPLATE is a metric label. Never use actual wallet/player IDs. */
export function httpRoute(method: string, path: string): string {
  const route = path.split('?')[0] ?? '';
  if (route === '/') return '/';
  if (route === '/health/live' || route === '/health/ready' || route === '/internal/metrics') return route;
  if (route === '/wallets') return method === 'POST' ? '/wallets' : 'unknown';
  if (/^\/wallets\/[^/]+\/ledger$/.test(route)) return '/wallets/:walletId/ledger';
  if (/^\/wallets\/[^/]+\/reconciliation$/.test(route)) return '/wallets/:walletId/reconciliation';
  if (/^\/wallets\/[^/]+$/.test(route)) return '/wallets/:walletId';
  if (route === '/wagering/transactions') return route;
  if (/^\/wagering\/transactions\/[^/]+$/.test(route)) return '/wagering/transactions/:transactionId';
  if (/^\/providers\/[^/]+\/wagering\/transactions\/[^/]+$/.test(route)) {
    return '/providers/:providerId/wagering/transactions/:externalTransactionId';
  }
  return 'unmatched';
}

async function bootstrap(): Promise<void> {
  startTelemetry('wager-api');
  const app = await NestFactory.create(AppModule);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const route = httpRoute(req.method, req.path);
    const span = startSpan(`HTTP ${req.method} ${route}`, {
      'http.request.method': req.method, 'http.route': route,
    }, req.header('traceparent'), 2);
    const started = performance.now();
    let ended = false;
    span.run(() => {
      res.setHeader('X-Trace-Id', span.traceId);
      const end = (closed: boolean) => {
        if (ended) return;
        ended = true;
        const elapsed = performance.now() - started;
        const status = closed && !res.writableEnded ? 499 : res.statusCode;
        const labels = { method: req.method, route, status: String(status) };
        duration('wager_http_request_duration_ms', elapsed, { method: req.method, route });
        count('wager_http_requests_total', labels);
        if (status >= 500 || status === 499) count('wager_http_errors_total', labels);
        const fields = { ...labels, duration_ms: Math.round(elapsed * 100) / 100 };
        log(status >= 500 ? 'error' : 'info', 'http.request.completed', fields);
        span.end({ 'http.response.status_code': status, 'http.server.request.duration_ms': elapsed },
          status >= 500 ? new Error('HTTP server error') : undefined);
      };
      res.once('finish', () => end(false));
      res.once('close', () => end(true));
      next();
    });
  });
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
  log('info', 'http.server.started', { port: Number(process.env.PORT ?? 3000) });
}
await bootstrap();
