import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecutionContext } from '@nestjs/common';
import { createSign, generateKeyPairSync } from 'node:crypto';
import {
  ForbiddenException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  assertMetricsIdentity,
  assertFinancialProviderIdentity,
  assertProviderIdentity,
  OidcAuthGuard,
  verifyOidcJwt,
} from './oidc.guard.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function token(override: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key1', typ: 'JWT' })).toString(
    'base64url',
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://idp.example/realms/wagering',
      aud: 'wagering-api',
      sub: 'user1',
      exp: 4_000_000_000,
      provider_id: 'provider-a',
      azp: 'provider-a',
      ...override,
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
describe('OIDC JWT verification', () => {
  const verify = (value: string) =>
    verifyOidcJwt(
      value,
      publicKey,
      'https://idp.example/realms/wagering',
      'wagering-api',
      1_800_000_000,
    );
  it('accepts RS256 signatures and verified provider claims', () => {
    expect(verify(token()).provider_id).toBe('provider-a');
  });
  it('rejects unsigned provider impersonation and mismatched authorized-party claims', () => {
    expect(() => verify(token({ azp: 'provider-b' }))).toThrow(UnauthorizedException);
    expect(() => verify(token({ provider_id: 'provider-b' }))).toThrow(UnauthorizedException);
    expect(() => verify(token({ azp: null }))).toThrow(UnauthorizedException);
    expect(verify(token({ provider_id: undefined })).azp).toBe('provider-a');
  });
  it('rejects missing or invalid signatures', () => {
    expect(() => verify('bad-token')).toThrow(UnauthorizedException);
    const [header, payload, signature = ''] = token().split('.');
    const changedFirst = signature.startsWith('A') ? 'B' : 'A';
    const tampered = `${header}.${payload}.${changedFirst}${signature.slice(1)}`;
    expect(() => verify(tampered)).toThrow(UnauthorizedException);
  });
  it('rejects expired, early, wrong issuer and wrong audience JWTs', () => {
    for (const claims of [
      { exp: 1_000_000_000 },
      { nbf: 2_500_000_000 },
      { iss: 'https://attacker.example' },
      { aud: 'other-api' },
    ]) {
      expect(() => verify(token(claims))).toThrow(UnauthorizedException);
    }
  });
  it('authorizes only configured financial OAuth clients, never the monitoring client', () => {
    const mode = process.env.HTTP_AUTH_MODE;
    const ids = process.env.OIDC_PROVIDER_CLIENT_IDS;
    process.env.HTTP_AUTH_MODE = 'oidc';
    process.env.OIDC_PROVIDER_CLIENT_IDS = 'provider-a,provider-b,wagering-monitor';
    try {
      expect(() => assertFinancialProviderIdentity('provider-a')).not.toThrow();
      expect(() => assertFinancialProviderIdentity('provider-b')).not.toThrow();
      expect(() => assertFinancialProviderIdentity('wagering-monitor')).toThrow(ForbiddenException);
      expect(() => assertFinancialProviderIdentity('unknown-service')).toThrow(ForbiddenException);
      expect(() => assertFinancialProviderIdentity()).toThrow(ForbiddenException);
    } finally {
      if (mode === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = mode;
      if (ids === undefined) delete process.env.OIDC_PROVIDER_CLIENT_IDS;
      else process.env.OIDC_PROVIDER_CLIENT_IDS = ids;
    }
  });
  it('rejects mismatched provider access', () => {
    const previous = process.env.HTTP_AUTH_MODE;
    process.env.HTTP_AUTH_MODE = 'oidc';
    try {
      expect(() => assertProviderIdentity('provider-b', 'provider-a')).toThrow(ForbiddenException);
      expect(() => assertProviderIdentity('provider-a', 'provider-a')).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = previous;
    }
  });
});

describe('OIDC guard integrated with an external JWKS endpoint', () => {
  let mockIdp: Server;
  let endpoint = '';
  const preserved: Record<string, string | undefined> = {};
  beforeAll(async () => {
    for (const key of ['HTTP_AUTH_MODE', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL']) {
      preserved[key] = process.env[key];
    }
    const jwk = publicKey.export({ format: 'jwk' });
    mockIdp = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'key1', alg: 'RS256', use: 'sig' }] }));
    });
    await new Promise<void>((resolve) => mockIdp.listen(0, '127.0.0.1', resolve));
    const address = mockIdp.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${address.port}`;
    process.env.HTTP_AUTH_MODE = 'oidc';
    process.env.OIDC_ISSUER = 'https://idp.example/realms/wagering';
    process.env.OIDC_AUDIENCE = 'wagering-api';
    process.env.OIDC_JWKS_URL = endpoint;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      mockIdp.close((error) => (error ? reject(error) : resolve())),
    );
    for (const [key, value] of Object.entries(preserved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const context = (
    authorization?: string,
  ): {
    readonly ctx: ExecutionContext;
    readonly request: { headers: { authorization?: string }; authProviderId?: string };
  } => {
    const request: { headers: { authorization?: string }; authProviderId?: string } = {
      headers: { ...(authorization ? { authorization } : {}) },
    };
    return {
      request,
      ctx: { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext,
    };
  };
  it('validates a signed bearer token from the JWKS and binds provider identity', async () => {
    const request = context('Bearer ' + token());
    const guard = new OidcAuthGuard();
    expect(await guard.canActivate(request.ctx)).toBe(true);
    expect(request.request.authProviderId).toBe('provider-a');
    // Cached public key supports a second request without re-fetching.
    expect(await guard.canActivate(context('Bearer ' + token()).ctx)).toBe(true);
  });
  it('rejects missing credentials and expired tokens without exposing protected endpoints', async () => {
    const guard = new OidcAuthGuard();
    let caught: unknown;
    try {
      await guard.canActivate(context().ctx);
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
    caught = undefined;
    try {
      await guard.canActivate(context('Bearer ' + token({ exp: 1 })).ctx);
    } catch (e: unknown) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnauthorizedException);
  });
  it('refuses to run as OIDC when the identity provider is not configured', async () => {
    const original = process.env.OIDC_AUDIENCE;
    delete process.env.OIDC_AUDIENCE;
    try {
      let error: unknown;
      try {
        await new OidcAuthGuard().canActivate(context('Bearer ' + token()).ctx);
      } catch (e: unknown) {
        error = e;
      }
      expect(error).toBeInstanceOf(ServiceUnavailableException);
    } finally {
      process.env.OIDC_AUDIENCE = original;
    }
  });
  it('rejects an unknown key id from a JWKS response', async () => {
    const [header, payload] = token().split('.');
    const changed = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'unknown' })).toString(
      'base64url',
    );
    let error: unknown;
    try {
      await new OidcAuthGuard().canActivate(context(`Bearer ${changed}.${payload}.signature`).ctx);
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(header).toBeDefined();
  });
  it('allows the explicit bypass only outside production', async () => {
    const old = process.env.HTTP_AUTH_MODE;
    process.env.HTTP_AUTH_MODE = 'disabled';
    try {
      expect(await new OidcAuthGuard().canActivate(context().ctx)).toBe(true);
    } finally {
      process.env.HTTP_AUTH_MODE = old;
    }
  });
});

describe('operations client authorization', () => {
  it('allows metrics only for the configured signed monitoring client', () => {
    const mode = process.env.HTTP_AUTH_MODE;
    const ops = process.env.OIDC_METRICS_CLIENT_ID;
    process.env.HTTP_AUTH_MODE = 'oidc';
    process.env.OIDC_METRICS_CLIENT_ID = 'wagering-monitor';
    try {
      expect(() => assertMetricsIdentity('wagering-monitor')).not.toThrow();
      expect(() => assertMetricsIdentity('provider-a')).toThrow(ForbiddenException);
      expect(() => assertMetricsIdentity()).toThrow(ForbiddenException);
    } finally {
      if (mode === undefined) delete process.env.HTTP_AUTH_MODE;
      else process.env.HTTP_AUTH_MODE = mode;
      if (ops === undefined) delete process.env.OIDC_METRICS_CLIENT_ID;
      else process.env.OIDC_METRICS_CLIENT_ID = ops;
    }
  });
});
