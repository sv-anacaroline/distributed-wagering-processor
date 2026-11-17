import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import ormConfig from './mikro-orm.config.js';
import { WalletService } from './http/wallet.service.js';
import { WalletAccessService } from './http/wallet-access.service.js';
import { WagerService } from './http/wager.service.js';
import { ReconciliationService } from './http/reconciliation.service.js';
import { WalletController } from './http/wallet.controller.js';
import { WagerController, ProviderWagerController } from './http/wager.controller.js';
import { HealthController, HealthService } from './http/health.controller.js';
import { MetricsController } from './http/metrics.controller.js';
import { HttpExceptionFilter } from './http/http-exception.filter.js';
import { APP_FILTER } from '@nestjs/core';
import { TelemetryShutdown } from './telemetry/shutdown.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(ormConfig),
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
    WalletAccessService,
    WagerService,
    ReconciliationService,
    HealthService,
    TelemetryShutdown,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
