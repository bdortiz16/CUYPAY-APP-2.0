// Matemática de cotización COP → BRL con enteros (BigInt), igual que el backend:
// toAmountMinor = floor((fromAmountMinor - feeMinor) * rate)

const RATE_SCALE = 10_000_000_000n; // 1e10

export interface FxParams {
  /** BRL por 1 COP después del spread (ej. 0.0013003). */
  customerRate: number;
  /** Comisión en puntos básicos sobre el monto de origen (100 = 1 %). */
  feeBps: number;
  /** Comisión mínima en unidades menores de COP. */
  minFeeMinor: number;
}

export interface FxQuote {
  fromAmountMinor: number;
  feeMinor: number;
  netMinor: number;
  toAmountMinor: number;
}

export function rateToScaled(rate: number): bigint {
  return BigInt(Math.round(rate * 1e10));
}

export function feeFor(fromAmountMinor: number, feeBps: number, minFeeMinor: number): number {
  if (fromAmountMinor <= 0) return 0;
  // ceil(from * bps / 10000) en enteros
  const pctFee = (BigInt(fromAmountMinor) * BigInt(feeBps) + 9_999n) / 10_000n;
  const fee = pctFee > BigInt(minFeeMinor) ? pctFee : BigInt(minFeeMinor);
  return Number(fee > BigInt(fromAmountMinor) ? BigInt(fromAmountMinor) : fee);
}

export function quote(fromAmountMinor: number, p: FxParams): FxQuote {
  const from = Math.max(0, Math.trunc(fromAmountMinor));
  const feeMinor = feeFor(from, p.feeBps, p.minFeeMinor);
  const netMinor = from - feeMinor;
  const toAmountMinor = Number((BigInt(netMinor) * rateToScaled(p.customerRate)) / RATE_SCALE);
  return { fromAmountMinor: from, feeMinor, netMinor, toAmountMinor };
}

export function customerRateFrom(midRate: number, spreadBps: number): number {
  const scaled = (rateToScaled(midRate) * BigInt(10_000 - spreadBps)) / 10_000n;
  return Number(scaled) / 1e10;
}

/** Tasa de demostración para la landing (no es una cotización real). */
export const DEMO_FX: FxParams & { midRate: number; spreadBps: number } = {
  midRate: 0.0013134,
  spreadBps: 100,
  customerRate: customerRateFrom(0.0013134, 100),
  feeBps: 100,
  minFeeMinor: 200_000, // COP 2.000
};
