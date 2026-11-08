import { AppError } from './errors.js';

/**
 * Aritmética monetaria y de tasas con enteros (BigInt). Nunca floats para saldos.
 *
 * Las tasas se representan como enteros escalados por RATE_SCALE (1e10):
 *   0.0013003 BRL/COP  →  13_003_000n
 * Ambas monedas usan 2 decimales, así que la tasa entre unidades menores es la misma
 * que entre unidades mayores.
 */
export const RATE_DECIMALS = 10;
export const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
export const BPS = 10_000n;

/** Parsea una tasa decimal en string ("0.0013003") a entero escalado (trunca decimales extra). */
export function parseRate(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new AppError('VALIDATION_ERROR', `Tasa inválida: ${decimal}`);
  const intPart = m[1] ?? '0';
  const frac = (m[2] ?? '').slice(0, RATE_DECIMALS).padEnd(RATE_DECIMALS, '0');
  return BigInt(intPart) * RATE_SCALE + BigInt(frac);
}

/** Formatea una tasa escalada como decimal string sin ceros finales ("0.0013003"). */
export function formatRate(scaled: bigint): string {
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const int = abs / RATE_SCALE;
  const frac = (abs % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? '.' + frac : ''}`;
}

/** Número JSON para mostrar (solo presentación; el cálculo usa BigInt). */
export const rateToNumber = (scaled: bigint): number => Number(formatRate(scaled));

/** Aplica el spread (bps) a la tasa media: floor(mid * (10000 - spread) / 10000). */
export function applySpread(midScaled: bigint, spreadBps: number): bigint {
  return (midScaled * (BPS - BigInt(spreadBps))) / BPS;
}

/** Inversa (COP por BRL) escalada, floor. */
export function invertRate(scaled: bigint): bigint {
  if (scaled <= 0n) return 0n;
  return (RATE_SCALE * RATE_SCALE) / scaled;
}

/** fee = max(min, floor(amount * bps / 10000)) */
export function computeFee(amountMinor: bigint, bps: number, minMinor: number): bigint {
  const pct = (amountMinor * BigInt(bps)) / BPS;
  const min = BigInt(minMinor);
  return pct > min ? pct : min;
}

/** toAmountMinor = floor((fromAmountMinor - feeMinor) * rate)  (contrato §8) */
export function convertMinor(fromAmountMinor: bigint, feeMinor: bigint, rateScaled: bigint): bigint {
  const net = fromAmountMinor - feeMinor;
  if (net <= 0n) return 0n;
  return (net * rateScaled) / RATE_SCALE;
}

/** Convierte bigint a number validando que sea un entero seguro (para JSON). */
export function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new AppError('INTERNAL_ERROR', 'Monto fuera del rango seguro');
  }
  return Number(v);
}

/** Unidades menores → string decimal en unidades mayores ("150000.00"). */
export function minorToMajorString(minor: bigint, decimals = 2): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const scale = 10n ** BigInt(decimals);
  return `${neg ? '-' : ''}${abs / scale}.${(abs % scale).toString().padStart(decimals, '0')}`;
}

/** String decimal en unidades mayores ("150000.5") → unidades menores (trunca). */
export function majorStringToMinor(value: string | number, decimals = 2): bigint {
  const s = typeof value === 'number' ? value.toFixed(decimals) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new AppError('PROVIDER_ERROR', `Monto inválido del proveedor: ${s}`);
  const frac = (m[3] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const v = BigInt(m[2] ?? '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return m[1] ? -v : v;
}
