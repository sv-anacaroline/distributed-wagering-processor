import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config.js';
import { WalletService } from '../src/http/wallet.service.js';
import { WalletAccessService } from '../src/http/wallet-access.service.js';
import { ForbiddenException } from '@nestjs/common';

let orm: MikroORM;
beforeAll(async () => { orm = await MikroORM.init(config); });
afterAll(async () => { await orm.close(true); });

describe('PostgreSQL provider grants', () => {
  it('creates wallet and provider grant in one transaction; keeps wallet multi-provider capable', async () => {
    const player = randomUUID();
    const wallets = new WalletService(orm.em);
    const opened = await wallets.create(player, { amount: '10.00', currency: 'BRL' }, 'provider-a');
    const access = new WalletAccessService(orm.em);
    const oldMode = process.env.HTTP_AUTH_MODE;
    process.env.HTTP_AUTH_MODE = 'oidc';
    try {
      await access.assertAllowed(opened.id, 'provider-a');
      await expect(access.assertAllowed(opened.id, 'provider-b')).rejects.toThrow(ForbiddenException);
      await orm.em.execute(
        'insert into wallet_provider_grants(wallet_id,provider_id) values (?::uuid,?)',
        [opened.id, 'provider-b'],
      );
      await access.assertAllowed(opened.id, 'provider-b');
      const grants = await orm.em.execute<Array<{ provider_id: string }>>(
        'select provider_id from wallet_provider_grants where wallet_id=?::uuid order by provider_id',
        [opened.id],
      );
      expect(grants.map(row => row.provider_id)).toEqual(['provider-a', 'provider-b']);
      const wallet = await wallets.find(opened.id);
      expect(wallet.balance.amount).toBe('10.00');
    } finally {
      if (oldMode === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = oldMode;
    }
  });
});
