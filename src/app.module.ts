import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import ormConfig from './mikro-orm.config.js';
import { WalletService } from './http/wallet.service.js';
import { WagerService } from './http/wager.service.js';
import { ReconciliationService } from './http/reconciliation.service.js';
import { WalletController } from './http/wallet.controller.js';
import { WagerController, ProviderWagerController } from './http/wager.controller.js';
import { HealthController, HealthService } from './http/health.controller.js';
import { MetricsController } from './http/metrics.controller.js';
import { HttpExceptionFilter } from './http/http-exception.filter.js';
import { APP_FILTER } from '@nestjs/core';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      runtimeMetrics: !Boolean(process.versions?.['webcontainer']),
      serviceId: 'distributed-wagering-processor',
    }),
  ],
  controllers: [
    AppController,
    WalletController,
    WagerController,
    ProviderWagerController,
    HealthController,
    MetricsController,
  ],
  providers: [
    AppService,
    WalletService,
    WagerService,
    ReconciliationService,
    HealthService,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
