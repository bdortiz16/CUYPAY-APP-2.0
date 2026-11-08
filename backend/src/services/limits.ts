import type { LimitOperation, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { periodRange } from '../lib/time.js';
import type { ServiceDeps } from './deps.js';
import { getLimitsConfig } from './runtime-config.js';

export interface LimitItemView {
  operation: LimitOperation;
  period: 'daily' | 'monthly' | 'annual';
  limitMinor: bigint;
  usedMinor: bigint;
}
export interface LimitsSnapshot {
  tier: User['tier'];
  currency: 'COP';
  items: LimitItemView[];
}

/**
 * Motor de límites. Todo en COP equivalente; periodos calendario en America/Bogota.
 * El uso se registra como filas `limit_usage` ligadas a una transacción; si la
 * transacción falla, se anulan (voided) y dejan de contar.
 */
export class LimitsService {
  constructor(private readonly d: ServiceDeps) {}

  /**
   * Reglas vigentes: configuración por tier (editable en caliente desde el portal admin)
   * + overrides individuales del cliente, que reemplazan (operation, period) o agregan reglas.
   */
  private async rules(user: User) {
    const base = (await getLimitsConfig(this.d)).value[user.tier];
    const overrides = (await this.d.repos.customerControls.get(user.id))?.limitOverrides ?? [];
    if (!overrides.length) return base;
    const merged = base.map((r) => overrides.find((o) => o.operation === r.operation && o.period === r.period) ?? r);
    for (const o of overrides) if (!merged.some((r) => r.operation === o.operation && r.period === o.period)) merged.push(o);
    return merged;
  }

  async snapshot(user: User): Promise<LimitsSnapshot> {
    const now = this.d.clock.now();
    const items: LimitItemView[] = [];
    for (const r of await this.rules(user)) {
      const { start, end } = periodRange(now, r.period);
      const used = await this.d.repos.limitUsage.sum(user.id, r.operation, start, end);
      items.push({ operation: r.operation, period: r.period, limitMinor: BigInt(r.limitMinor), usedMinor: used });
    }
    return { tier: user.tier, currency: 'COP', items };
  }

  /** Primera regla que se excedería con `amountMinor` adicional, o null. */
  async firstExceeded(user: User, operation: LimitOperation, amountMinor: bigint) {
    const now = this.d.clock.now();
    for (const r of await this.rules(user)) {
      if (r.operation !== operation) continue;
      const { start, end } = periodRange(now, r.period);
      const used = await this.d.repos.limitUsage.sum(user.id, operation, start, end);
      const limit = BigInt(r.limitMinor);
      if (used + amountMinor > limit) {
        return { operation, period: r.period, limitMinor: limit, usedMinor: used, remainingMinor: limit > used ? limit - used : 0n };
      }
    }
    return null;
  }

  /** Lanza 422 LIMIT_EXCEEDED con details { operation, period, limitMinor, usedMinor, remainingMinor }. */
  async assertWithin(user: User, operation: LimitOperation, amountMinor: bigint): Promise<void> {
    const ex = await this.firstExceeded(user, operation, amountMinor);
    if (ex) {
      throw new AppError('LIMIT_EXCEEDED', `Supera el límite ${ex.period} de ${operation}`, {
        operation: ex.operation,
        period: ex.period,
        limitMinor: Number(ex.limitMinor),
        usedMinor: Number(ex.usedMinor),
        remainingMinor: Number(ex.remainingMinor),
      });
    }
  }

  async record(userId: string, operation: LimitOperation, amountMinor: bigint, transactionId: string): Promise<void> {
    const now = this.d.clock.now();
    await this.d.repos.limitUsage.add({
      id: newId('lmu', now),
      userId,
      operation,
      amountMinor,
      transactionId,
      occurredAt: now,
      voidedAt: null,
    });
  }

  async voidFor(transactionId: string): Promise<void> {
    await this.d.repos.limitUsage.voidByTransaction(transactionId, this.d.clock.now());
  }
}
