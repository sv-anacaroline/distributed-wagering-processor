import {
  Body, Controller, Get, Headers, HttpCode, Param, Post,
  Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { WagerTransactionStatus as Status } from '../domain/wager-transaction.js';
import { OidcAuthGuard, assertProviderIdentity } from './oidc.guard.js';
import { textField, uuidField, wagerPayload } from './request-validation.js';
import { WagerService } from './wager.service.js';

interface ProviderRequest {
  readonly authProviderId?: string;
}
@Controller('wagering/transactions')
@UseGuards(OidcAuthGuard)
export class WagerController {
  constructor(private readonly wagers: WagerService) {}

  @Post()
  @HttpCode(200)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Req() req: ProviderRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = wagerPayload(body, key);
    assertProviderIdentity(command.providerId, req.authProviderId);
    const result = await this.wagers.submit(command);
    res.status(
      result.status === Status.PendingReference ? 202 : result.status === Status.Rejected ? 422 : 200,
    );
    return result;
  }

  @Get(':transactionId')
  async find(
    @Param('transactionId') id: string,
    @Req() req: ProviderRequest,
  ) {
    const result = await this.wagers.findById(uuidField(id, 'transactionId'));
    assertProviderIdentity(result.providerId, req.authProviderId);
    return result;
  }
}

@Controller('providers/:providerId/wagering/transactions')
@UseGuards(OidcAuthGuard)
export class ProviderWagerController {
  constructor(private readonly wagers: WagerService) {}

  @Get(':externalTransactionId')
  find(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
    @Req() req: ProviderRequest,
  ) {
    const provider = textField(providerId, 'providerId');
    assertProviderIdentity(provider, req.authProviderId);
    return this.wagers.findByExternalId(provider, textField(externalId, 'externalTransactionId'));
  }
}
