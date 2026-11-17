import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

interface JwkRecord {
  readonly kid?: string;
  readonly kty?: string;
}
interface JwkSet {
  readonly keys: JwkRecord[];
}
export interface OidcClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | string[];
  readonly exp: number;
  readonly nbf?: number;
  /** Custom provider claim issued by the external IdP, never trusted from request JSON. */
  readonly provider_id?: string;
  /** Keycloak authorized party (the OAuth client ID). */
  readonly azp: string;
}
interface JwtHeader {
  readonly alg?: string;
  readonly kid?: string;
}
function decoded(input: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* invalid JWT */
  }
  throw new UnauthorizedException('Invalid JWT encoding');
}
export function verifyOidcJwt(
  token: string,
  key: KeyObject,
  issuer: string,
  audience: string,
  nowSeconds: number,
): OidcClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Invalid JWT format');
  const header = decoded(parts[0] ?? '') as JwtHeader;
  if (header.alg !== 'RS256') throw new UnauthorizedException('Unsupported JWT algorithm');
  const claims = decoded(parts[1] ?? '');
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2] ?? '', 'base64url'),
  );
  if (
    !valid ||
    claims.iss !== issuer ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof claims.azp !== 'string' ||
    claims.azp.length === 0 ||
    (claims.provider_id !== undefined && claims.provider_id !== claims.azp) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= nowSeconds ||
    (typeof claims.nbf === 'number' && claims.nbf > nowSeconds) ||
    !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience)))
  ) {
    throw new UnauthorizedException('Invalid JWT claims or signature');
  }
  return claims as unknown as OidcClaims;
}
export function assertProviderIdentity(providerId: string, authenticatedProvider?: string): void {
  if (process.env.HTTP_AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production') return;
  if (!authenticatedProvider || authenticatedProvider !== providerId) {
    throw new ForbiddenException('Provider identity does not match token');
  }
}

export function assertMetricsIdentity(authorizedParty?: string): void {
  if (process.env.HTTP_AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production') return;
  if (
    !authorizedParty ||
    authorizedParty !== (process.env.OIDC_METRICS_CLIENT_ID ?? 'wagering-monitor')
  ) {
    throw new ForbiddenException('An operations identity is required');
  }
}

@Injectable()
export class OidcAuthGuard implements CanActivate {
  private readonly keys = new Map<string, { key: KeyObject; expiresAt: number }>();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Allowed by challenge section 2 only as an explicit local/test opt-out.
    if (process.env.HTTP_AUTH_MODE === 'disabled' && process.env.NODE_ENV !== 'production')
      return true;
    const issuer = process.env.OIDC_ISSUER;
    const audience = process.env.OIDC_AUDIENCE;
    const jwksUrl = process.env.OIDC_JWKS_URL;
    if (!issuer || !audience || !jwksUrl) {
      throw new ServiceUnavailableException('OIDC identity provider is not configured');
    }
    const req = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      authProviderId?: string;
    }>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token is required');
    }
    const token = header.slice(7).trim();
    const jwtParts = token.split('.');
    if (jwtParts.length !== 3) throw new UnauthorizedException('Invalid JWT');
    const jwtHeader = decoded(jwtParts[0] ?? '') as JwtHeader;
    if (jwtHeader.alg !== 'RS256' || !jwtHeader.kid || jwtHeader.kid.length > 128) {
      throw new UnauthorizedException('JWT must use RS256 with kid');
    }
    let entry = this.keys.get(jwtHeader.kid);
    if (!entry || entry.expiresAt <= Date.now()) {
      let jwks: JwkSet;
      try {
        const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error('JWKS unavailable');
        jwks = (await response.json()) as JwkSet;
        if (!Array.isArray(jwks.keys)) throw new Error('Invalid JWKS');
      } catch {
        throw new ServiceUnavailableException('Identity provider is unreachable');
      }
      const jwk = jwks.keys.find(
        (item) =>
          item.kid === jwtHeader.kid &&
          item.kty === 'RSA' &&
          (!('use' in item) || item.use === 'sig') &&
          (!('alg' in item) || item.alg === 'RS256'),
      );
      if (!jwk) throw new UnauthorizedException('Unknown JWT key ID');
      try {
        entry = {
          key: createPublicKey({ key: jwk, format: 'jwk' } as Extract<
            Parameters<typeof createPublicKey>[0],
            { format: 'jwk' }
          >),
          expiresAt: Date.now() + 300_000,
        };
      } catch {
        throw new UnauthorizedException('Invalid OIDC public key');
      }
      this.keys.set(jwtHeader.kid, entry);
    }
    const claims = verifyOidcJwt(token, entry.key, issuer, audience, Math.floor(Date.now() / 1000));
    req.authProviderId = claims.azp;
    return true;
  }
}
