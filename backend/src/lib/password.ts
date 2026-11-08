import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hash de contraseñas con scrypt (node:crypto).
 * Formato: `scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>` para poder subir parámetros sin migrar.
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const maxmem = (n: number, r: number) => 128 * n * r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64url');
  try {
    const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: maxmem(Number(n), Number(r)),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Contraseña temporal aleatoria (para altas / reinicios de usuarios admin). */
export const generateTempPassword = (): string => randomBytes(15).toString('base64url');
