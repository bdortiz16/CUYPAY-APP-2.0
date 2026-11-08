import { createHmac, timingSafeEqual } from 'node:crypto';
import type { KycStatus } from '../../domain/types.js';

/**
 * Verificación del webhook de Sumsub: HMAC del CUERPO CRUDO con el secreto del
 * webhook. Header `X-Payload-Digest` (hex) y `X-Payload-Digest-Alg`.
 */
const ALGS: Record<string, 'sha1' | 'sha256' | 'sha512'> = {
  HMAC_SHA1_HEX: 'sha1',
  HMAC_SHA256_HEX: 'sha256',
  HMAC_SHA512_HEX: 'sha512',
};

export function computeSumsubDigest(secret: string, rawBody: Buffer, alg = 'HMAC_SHA256_HEX'): string {
  const algo = ALGS[alg];
  if (!algo) throw new Error(`Algoritmo no soportado: ${alg}`);
  return createHmac(algo, secret).update(rawBody).digest('hex');
}

export function verifySumsubWebhook(
  secret: string,
  rawBody: Buffer | undefined,
  digest: string | undefined,
  alg: string | undefined,
): boolean {
  if (!rawBody || !digest) return false;
  const algName = alg ?? 'HMAC_SHA256_HEX';
  if (!ALGS[algName]) return false;
  const expected = Buffer.from(computeSumsubDigest(secret, rawBody, algName), 'hex');
  const given = /^[0-9a-fA-F]+$/.test(digest) ? Buffer.from(digest, 'hex') : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface SumsubWebhookPayload {
  type?: string;
  applicantId?: string;
  externalUserId?: string;
  levelName?: string;
  reviewStatus?: string;
  reviewResult?: { reviewAnswer?: 'GREEN' | 'RED'; reviewRejectType?: 'FINAL' | 'RETRY'; rejectLabels?: string[] };
}

/** Mapea el evento a un estado KYC de CuyPay (null = evento sin efecto en el estado). */
export function mapSumsubEvent(p: SumsubWebhookPayload): KycStatus | null {
  switch (p.type) {
    case 'applicantReviewed': {
      const answer = p.reviewResult?.reviewAnswer;
      if (answer === 'GREEN') return 'approved';
      if (answer === 'RED') return p.reviewResult?.reviewRejectType === 'RETRY' ? 'retry' : 'rejected';
      return null;
    }
    case 'applicantPending':
    case 'applicantOnHold':
    case 'applicantAwaitingUser':
      return 'pending';
    case 'applicantReset':
      return 'not_started';
    default:
      return null;
  }
}
