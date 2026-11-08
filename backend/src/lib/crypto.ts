import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * Criptografía de dispositivo (Secure Enclave, P-256).
 * - Clave pública: X9.63 sin comprimir (0x04 || X(32) || Y(32)) en base64 → 65 bytes.
 * - Firma: ECDSA-SHA256 en DER, base64.
 */

export const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodeBase64Strict(value: string): Buffer | null {
  const s = value.trim();
  if (!s || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/** Convierte una clave X9.63 (base64) a KeyObject vía JWK (x/y). Lanza VALIDATION_ERROR si no es válida. */
export function p256PublicKeyFromX963(b64: string): KeyObject {
  const raw = decodeBase64Strict(b64);
  if (!raw || raw.length !== 65 || raw[0] !== 0x04) {
    throw new AppError('VALIDATION_ERROR', 'devicePublicKey debe ser una clave P-256 X9.63 sin comprimir (65 bytes) en base64', {
      field: 'devicePublicKey',
    });
  }
  const x = raw.subarray(1, 33).toString('base64url');
  const y = raw.subarray(33, 65).toString('base64url');
  try {
    // createPublicKey valida que el punto esté en la curva.
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
  } catch {
    throw new AppError('VALIDATION_ERROR', 'devicePublicKey no es un punto válido de P-256', { field: 'devicePublicKey' });
  }
}

/** Verifica una firma DER base64 (ECDSA-SHA256). Nunca lanza: devuelve false si algo es inválido. */
export function verifyP256Der(publicKeyX963B64: string, data: Buffer | string, signatureB64: string): boolean {
  try {
    const key = p256PublicKeyFromX963(publicKeyX963B64);
    const sig = decodeBase64Strict(signatureB64);
    if (!sig || sig.length < 8 || sig.length > 80 || sig[0] !== 0x30) return false;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return verify('sha256', buf, { key, dsaEncoding: 'der' }, sig);
  } catch {
    return false;
  }
}

/** Cadena canónica de §1 del contrato (separador \n, sin salto final). */
export function canonicalRequestString(p: {
  method: string;
  path: string;
  rawBody: Buffer | string | undefined;
  timestamp: string;
  nonce: string;
}): string {
  const body = p.rawBody ?? '';
  return [p.method.toUpperCase(), p.path, sha256Hex(body), p.timestamp, p.nonce].join('\n');
}

/** Hash estable de un objeto JSON (claves ordenadas) para idempotencia. */
export function stableHash(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return sha256Hex(JSON.stringify(norm(value)));
}
