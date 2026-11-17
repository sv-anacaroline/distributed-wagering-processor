import { describe, expect, it } from 'bun:test';
import { ForbiddenException } from '@nestjs/common';
import { WalletAccessService } from './wallet-access.service.js';

describe('provider-to-wallet grants', () => {
  const previousAuth = process.env.HTTP_AUTH_MODE;
  const previousNode = process.env.NODE_ENV;
  const check = (rows: unknown[]) => {
    const calls: unknown[][] = [];
    const em = {
      fork: () => ({
        execute: (_sql: string, params: unknown[]) => {
          calls.push(params);
          return Promise.resolve(rows);
        },
      }),
    };
    return { service: new WalletAccessService(em as never), calls };
  };
  it('permits the identity with an explicit SQL wallet grant', async () => {
    process.env.HTTP_AUTH_MODE = 'oidc';
    try {
      const { service, calls } = check([{ allowed: 1 }]);
      await service.assertAllowed('wallet-id', 'provider-a');
      expect(calls).toEqual([['wallet-id', 'provider-a']]);
    } finally {
      if (previousAuth === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = previousAuth;
    }
  });
  it('denies missing claims and other provider identities without a grant', () => {
    process.env.HTTP_AUTH_MODE = 'oidc';
    try {
      const { service, calls } = check([]);
      expect(service.assertAllowed('wallet-id', 'provider-b')).rejects.toThrow(ForbiddenException);
      expect(service.assertAllowed('wallet-id')).rejects.toThrow(ForbiddenException);
      expect(calls).toEqual([['wallet-id', 'provider-b']]);
    } finally {
      if (previousAuth === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = previousAuth;
    }
  });
  it('allows explicit local bypass but not in production', async () => {
    process.env.HTTP_AUTH_MODE = 'disabled';
    process.env.NODE_ENV = 'test';
    const { service, calls } = check([]);
    try {
      await service.assertAllowed('wallet-id');
      expect(calls).toHaveLength(0);
      process.env.NODE_ENV = 'production';
      expect(service.assertAllowed('wallet-id')).rejects.toThrow(ForbiddenException);
    } finally {
      if (previousAuth === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = previousAuth;
      if (previousNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNode;
    }
  });
});
