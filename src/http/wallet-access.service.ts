import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { EntityManager as CoreEntityManager } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { assertFinancialProviderIdentity } from './oidc.guard.js';

/** HTTP-only authorization. Internal trusted SQS commands retain domain checks. */
export function isLocalAuthBypass(): boolean {
  return process.env.HTTP_AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production';
}

@Injectable()
export class WalletAccessService {
  constructor(@Inject(CoreEntityManager) private readonly em: EntityManager) {}

  async assertAllowed(walletId: string, providerId?: string): Promise<void> {
    if (isLocalAuthBypass()) return;
    assertFinancialProviderIdentity(providerId);
    const granted = await this.em.fork().execute<Array<{ allowed: number }>>(
      `select 1 as allowed from wallet_provider_grants
       where wallet_id=?::uuid and provider_id=? limit 1`,
      [walletId, providerId],
    );
    if (granted.length === 0) {
      throw new ForbiddenException('Provider is not authorized for this wallet');
    }
  }
}
