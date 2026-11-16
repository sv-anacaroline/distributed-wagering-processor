import { describe, expect, it } from 'bun:test';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { assertProviderIdentity, verifyOidcJwt } from './oidc.guard.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function token(override: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key1', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://idp.example/realms/wagering', aud: 'wagering-api', sub: 'user1',
    exp: 4_000_000_000, provider_id: 'provider-a', ...override,
  })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
describe('OIDC JWT verification', () => {
  const verify = (value: string) =>
    verifyOidcJwt(value, publicKey, 'https://idp.example/realms/wagering', 'wagering-api', 1_800_000_000);
  it('accepts RS256 signatures and verified provider claims', () => {
    expect(verify(token()).provider_id).toBe('provider-a');
  });
  it('rejects missing or invalid signatures', () => {
    expect(() => verify('bad-token')).toThrow(UnauthorizedException);
    expect(() => verify(token().slice(0, -2) + 'xx')).toThrow(UnauthorizedException);
  });
  it('rejects expired, early, wrong issuer and wrong audience JWTs', () => {
    for (const claims of [
      { exp: 1_000_000_000 }, { nbf: 2_500_000_000 },
      { iss: 'https://attacker.example' }, { aud: 'other-api' },
    ]) {
      expect(() => verify(token(claims))).toThrow(UnauthorizedException);
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
