import { randomUUID } from 'node:crypto';
import type { Currency } from '../../domain/types.js';
import type { Clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { RATE_SCALE, invertRate, parseRate } from '../../lib/money.js';
import { localDate } from '../../lib/time.js';
import type { BrlLiquidityProvider } from '../../ports/index.js';

/**
 * Proveedor de liquidez BRL simulado. Tasa media ~0.00130 BRL/COP con una
 * oscilación determinística (sin floats en el resultado: todo BigInt).
 */
export class MockBrlLiquidityProvider implements BrlLiquidityProvider {
  /** Tasa base escalada (0.0013200 BRL/COP). Los tests pueden fijarla. */
  baseRate = parseRate('0.0013200');
  failNext = false;
  readonly executions: { reference: string; fromAmountMinor: bigint; toAmountMinor: bigint }[] = [];
  /** Ajuste manual del saldo (tests de conciliación / cobertura). */
  balanceAdjustmentMinor = 0n;
  down = false;

  constructor(private readonly clock: Clock) {}

  /** Variación diaria determinística en ±1.5% basada en el día. */
  private rateForDay(dayIndex: number): bigint {
    const wave = [0, 35, 60, 80, 95, 100, 92, 75, 50, 20, -10, -40, -65, -85, -98, -100, -90, -70, -45, -15];
    const bps = BigInt(wave[((dayIndex % wave.length) + wave.length) % wave.length] ?? 0) * 15n / 10n; // hasta ±150 bps
    return (this.baseRate * (10_000n + bps)) / 10_000n;
  }

  private dayIndex(d: Date): number {
    return Math.floor(d.getTime() / 86_400_000);
  }

  async getMidRate(from: Currency, to: Currency) {
    const now = this.clock.now();
    const copBrl = this.rateForDay(this.dayIndex(now));
    if (from === 'COP' && to === 'BRL') return { rateScaled: copBrl, updatedAt: now };
    if (from === 'BRL' && to === 'COP') return { rateScaled: invertRate(copBrl), updatedAt: now };
    if (from === to) return { rateScaled: RATE_SCALE, updatedAt: now };
    throw new AppError('VALIDATION_ERROR', 'Par no soportado');
  }

  async getHistory(from: Currency, to: Currency, days: number) {
    const now = this.clock.now();
    const today = this.dayIndex(now);
    const out: { date: string; rateScaled: bigint }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const r = this.rateForDay(today - i);
      out.push({
        date: localDate(new Date(now.getTime() - i * 86_400_000)),
        rateScaled: from === 'COP' && to === 'BRL' ? r : invertRate(r),
      });
    }
    return out;
  }

  /** Saldo BRL simulado = BRL entregados por conversiones (+ ajuste). */
  async getBalance() {
    if (this.down) throw new AppError('PROVIDER_ERROR', 'Proveedor BRL (mock) caído', { provider: 'brl' });
    const bal = this.executions.reduce((s, e) => s + e.toAmountMinor, this.balanceAdjustmentMinor);
    return { currency: 'BRL' as const, balanceMinor: bal, asOf: this.clock.now() };
  }

  async healthCheck() {
    if (this.down) throw new AppError('PROVIDER_ERROR', 'Proveedor BRL (mock) caído', { provider: 'brl' });
  }

  async executeConversion(input: { reference: string; fromAmountMinor: bigint; toAmountMinor: bigint }) {
    if (this.failNext) {
      this.failNext = false;
      throw new AppError('PROVIDER_ERROR', 'Proveedor BRL (mock) no disponible', { provider: 'brl' });
    }
    this.executions.push({ reference: input.reference, fromAmountMinor: input.fromAmountMinor, toAmountMinor: input.toAmountMinor });
    return { providerRef: `brl_mock_${randomUUID()}` };
  }
}

/**
 * Proveedor real BRL/PIX: socio por definir.
 * TODO(brl-partner): integrar API de cotización en firme, ejecución, liquidación PIX y conciliación.
 */
export class LiveBrlLiquidityProvider implements BrlLiquidityProvider {
  private readonly benchmark: MockBrlLiquidityProvider;

  constructor(clock: Clock) {
    this.benchmark = new MockBrlLiquidityProvider(clock);
  }

  private notConfigured(): never {
    throw new AppError('PROVIDER_ERROR', 'Conversiones de cambio COP/BRL en proceso de habilitación', { provider: 'brl' });
  }

  async getMidRate(from: Currency, to: Currency): Promise<{ rateScaled: bigint; updatedAt: Date }> {
    return this.benchmark.getMidRate(from, to);
  }

  async getHistory(from: Currency, to: Currency, days: number): Promise<{ date: string; rateScaled: bigint }[]> {
    return this.benchmark.getHistory(from, to, days);
  }

  async executeConversion(): Promise<{ providerRef: string }> {
    return this.notConfigured();
  }

  async getBalance(): Promise<{ currency: Currency; balanceMinor: bigint; asOf: Date }> {
    return { currency: 'BRL', balanceMinor: 0n, asOf: new Date() };
  }

  async healthCheck(): Promise<void> {
    // Benchmark de tasas disponible
  }
}
