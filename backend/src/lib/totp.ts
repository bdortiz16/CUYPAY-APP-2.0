import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226) con node:crypto: HMAC-SHA1, 6 dígitos, paso de 30 s,
 * ventana de tolerancia ±1 paso. Compatible con Google Authenticator, 1Password, Authy, etc.
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secreto aleatorio de 160 bits (recomendado por RFC 4226) en base32. */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (at: Date): number => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);

export function generateTotp(secretB32: string, at: Date): string {
  return hotp(base32Decode(secretB32), totpStep(at));
}

/**
 * Verifica un código con ventana ±`window` pasos. Devuelve el paso que coincidió (para impedir
 * la reutilización del mismo código) o null.
 */
export function verifyTotp(secretB32: string, code: string, at: Date, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = totpStep(at);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secret, step + w));
    // Se recorren todos los pasos (sin cortocircuito) para no filtrar tiempos.
    if (timingSafeEqual(expected, given) && matched === null) matched = step + w;
  }
  return matched;
}

export function otpauthUrl(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
