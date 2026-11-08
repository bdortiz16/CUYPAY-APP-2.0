import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import type { Clock } from '../lib/clock.js';

/** Normaliza `cuypay` / `cuypay.cloudflareaccess.com` / `https://cuypay.cloudflareaccess.com/` → origen https. */
export function cfTeamOrigin(team: string): string {
  let host = team.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host.includes('.')) host = `${host}.cloudflareaccess.com`;
  return `https://${host}`;
}

export interface CfAccessIdentity {
  email: string | null;
  sub: string | null;
}

export type CfAccessVerifier = (assertion: string | undefined) => Promise<CfAccessIdentity>;

/**
 * Valida el header `Cf-Access-Jwt-Assertion` (Cloudflare Zero Trust) contra el JWKS del equipo
 * (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`) y el AUD de la aplicación.
 * Devuelve null si CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD no están definidos (validación omitida).
 */
export function createCfAccessVerifier(config: AppConfig, clock: Clock, keySet?: JWTVerifyGetKey): CfAccessVerifier | null {
  if (!config.CF_ACCESS_TEAM_DOMAIN || !config.CF_ACCESS_AUD) return null;
  const issuer = cfTeamOrigin(config.CF_ACCESS_TEAM_DOMAIN);
  const jwks = keySet ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const audience = config.CF_ACCESS_AUD;
  return async (assertion) => {
    if (!assertion) throw new AppError('FORBIDDEN', 'Acceso denegado: falta la aserción de Cloudflare Access');
    try {
      const { payload } = await jwtVerify(assertion, jwks, { issuer, audience, algorithms: ['RS256'], currentDate: clock.now() });
      return { email: typeof payload.email === 'string' ? payload.email : null, sub: payload.sub ?? null };
    } catch {
      throw new AppError('FORBIDDEN', 'Acceso denegado: aserción de Cloudflare Access inválida');
    }
  };
}
