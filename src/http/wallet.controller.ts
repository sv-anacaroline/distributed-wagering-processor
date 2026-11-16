import {
  BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { OidcAuthGuard } from './oidc.guard.js';
import { WalletService } from './wallet.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { pageLimit, uuidField, walletPayload } from './request-validation.js';

@Controller('wallets')
@UseGuards(OidcAuthGuard)
export class WalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Post()
  create(@Body() body: unknown) {
    const request = walletPayload(body);
    return this.wallets.create(request.playerId, request.initialBalance);
  }

  @Get(':walletId')
  find(@Param('walletId') id: string) {
    return this.wallets.find(uuidField(id, 'walletId'));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') id: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 1024)) {
      throw new BadRequestException('Invalid cursor');
    }
    return this.wallets.ledger(uuidField(id, 'walletId'), pageLimit(limit), cursor);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') id: string) {
    return this.reconciliation.run(uuidField(id, 'walletId'));
  }
}

