import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { OidcAuthGuard, assertFinancialProviderIdentity } from './oidc.guard.js';
import { WalletAccessService } from './wallet-access.service.js';
import { WalletService } from './wallet.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { pageLimit, uuidField, walletPayload } from './request-validation.js';

@Controller('wallets')
@UseGuards(OidcAuthGuard)
export class WalletController {
  constructor(
    private readonly wallets: WalletService,
    private readonly reconciliation: ReconciliationService,
    private readonly access: WalletAccessService,
  ) {}

  @Post()
  create(@Body() body: unknown, @Req() req: { authProviderId?: string }) {
    const request = walletPayload(body);
    assertFinancialProviderIdentity(req.authProviderId);
    return this.wallets.create(request.playerId, request.initialBalance, req.authProviderId);
  }

  @Get(':walletId')
  async find(@Param('walletId') id: string, @Req() req: { authProviderId?: string }) {
    const walletId = uuidField(id, 'walletId');
    await this.access.assertAllowed(walletId, req.authProviderId);
    return this.wallets.find(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') id: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
    @Req() req: { authProviderId?: string },
  ) {
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 1024)) {
      throw new BadRequestException('Invalid cursor');
    }
    const walletId = uuidField(id, 'walletId');
    return this.access
      .assertAllowed(walletId, req.authProviderId)
      .then(() => this.wallets.ledger(walletId, pageLimit(limit), cursor));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') id: string, @Req() req: { authProviderId?: string }) {
    const walletId = uuidField(id, 'walletId');
    await this.access.assertAllowed(walletId, req.authProviderId);
    return this.reconciliation.run(walletId);
  }
}
