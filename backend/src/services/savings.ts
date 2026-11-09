import type { Currency, SavingsBlock, SavingsConfig, SavingsRateTier, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';
import type { LedgerService } from './ledger.js';

export class SavingsService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
  ) {}

  async getConfig(): Promise<SavingsConfig> {
    return this.d.repos.savingsConfig.get();
  }

  async updateConfig(
    rates: SavingsRateTier[],
    contractTerms?: string,
    minAmountMinor?: bigint,
    maxAmountMinor?: bigint,
    adminEmail = 'admin@cuypay.com',
  ): Promise<SavingsConfig> {
    const current = await this.d.repos.savingsConfig.get();
    const updated: SavingsConfig = {
      rates: rates.map((r) => ({
        termDays: Number(r.termDays),
        ratePercent: Number(r.ratePercent),
        enabled: Boolean(r.enabled),
      })),
      minAmountMinor: minAmountMinor ?? current.minAmountMinor,
      maxAmountMinor: maxAmountMinor ?? current.maxAmountMinor,
      contractTerms: contractTerms?.trim() || current.contractTerms,
      updatedAt: this.d.clock.now(),
      updatedBy: adminEmail,
    };
    await this.d.repos.savingsConfig.set(updated);
    this.d.logger.info({ adminEmail, rates: updated.rates }, 'Tasas y configuración de Bloque de Ahorro actualizadas por admin');
    return updated;
  }

  async listUserBlocks(userId: string) {
    const blocks = await this.d.repos.savingsBlocks.listByUser(userId);
    let totalPrincipal = 0n;
    let totalYieldEarned = 0n;
    let activeCount = 0;

    for (const b of blocks) {
      if (b.status === 'active' || b.status === 'maturing_soon') {
        totalPrincipal += b.principalMinor;
        activeCount++;
      } else if (b.status === 'completed') {
        totalYieldEarned += b.expectedYieldMinor;
      }
    }

    return {
      blocks: blocks.map((b) => ({
        id: b.id,
        termDays: b.termDays,
        principalMinor: b.principalMinor.toString(),
        lockedRate: b.lockedRate,
        expectedYieldMinor: b.expectedYieldMinor.toString(),
        totalPayoutMinor: b.totalPayoutMinor.toString(),
        currency: b.currency,
        status: b.status,
        startedAt: b.startedAt.toISOString(),
        maturesAt: b.maturesAt.toISOString(),
        completedAt: b.completedAt?.toISOString() ?? null,
      })),
      summary: {
        totalPrincipalMinor: totalPrincipal.toString(),
        totalYieldEarnedMinor: totalYieldEarned.toString(),
        activeCount,
      },
    };
  }

  async createBlock(user: User, termDays: number, principalMinor: bigint): Promise<SavingsBlock> {
    requireKycApproved(user);
    const config = await this.d.repos.savingsConfig.get();
    const tier = config.rates.find((r: SavingsRateTier) => r.termDays === termDays && r.enabled);
    if (!tier) {
      throw new AppError('VALIDATION_ERROR', `El plazo de ${termDays} días no está disponible en este momento`, { termDays });
    }

    if (principalMinor < config.minAmountMinor) {
      throw new AppError('VALIDATION_ERROR', `El monto mínimo para un bloque de ahorro es de $${Number(config.minAmountMinor / 100n).toLocaleString('es-CO')} COP`, {
        minAmountMinor: config.minAmountMinor.toString(),
      });
    }

    if (principalMinor > config.maxAmountMinor) {
      throw new AppError('VALIDATION_ERROR', `El monto máximo permitido es de $${Number(config.maxAmountMinor / 100n).toLocaleString('es-CO')} COP`, {
        maxAmountMinor: config.maxAmountMinor.toString(),
      });
    }

    // Verificar saldo disponible en COP
    const now = this.d.clock.now();
    const wallet = await this.ledger.wallet(user.id, 'COP');
    if (wallet.availableMinor < principalMinor) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente en tu bolsillo COP para constituir el bloque de ahorro', {
        available: wallet.availableMinor.toString(),
        required: principalMinor.toString(),
      });
    }

    // Calcular rendimiento fijo garantizado
    // Rendimiento = Capital * (Tasa / 100) * (Días / 365)
    const expectedYieldNum = Math.round(Number(principalMinor) * (tier.ratePercent / 100) * (termDays / 365));
    const expectedYieldMinor = BigInt(Math.max(1, expectedYieldNum));
    const totalPayoutMinor = principalMinor + expectedYieldMinor;

    const blockId = newId('sbk', now);
    const maturesAt = new Date(now.getTime() + termDays * 24 * 3600 * 1000);

    // Registro contable de inmovilización: debita user_available y acredita savings_vault
    const txId = newId('txn', now);
    await this.ledger.post(
      [
        { kind: 'user_available', userId: user.id, currency: 'COP', amountMinor: -principalMinor },
        { kind: 'savings_vault', userId: null, currency: 'COP', amountMinor: principalMinor },
      ],
      txId,
    );

    const block: SavingsBlock = {
      id: blockId,
      userId: user.id,
      principalMinor,
      termDays,
      lockedRate: tier.ratePercent, // Tasa fija garantizada e inmutable
      expectedYieldMinor,
      totalPayoutMinor,
      currency: 'COP',
      status: 'active',
      startedAt: now,
      maturesAt,
      completedAt: null,
      contractVersion: 1,
      contractAcceptedAt: now,
      createdAt: now,
    };

    await this.d.repos.savingsBlocks.create(block);

    // Guardar transacción en el feed del usuario
    await this.d.repos.transactions.create({
      id: txId,
      userId: user.id,
      type: 'transfer',
      direction: 'out',
      currency: 'COP',
      amountMinor: principalMinor,
      feeMinor: 0n,
      status: 'completed',
      title: 'Bloque de Ahorro',
      subtitle: `${termDays} días (${tier.ratePercent}% E.A.)`,
      description: 'Capital inmovilizado con rendimiento garantizado',
      conversion: null,
      beneficiaryId: null,
      quoteId: null,
      providerRef: blockId,
      flagged: false,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    });

    this.d.logger.info(
      { userId: user.id, blockId, termDays, principalMinor: principalMinor.toString(), lockedRate: tier.ratePercent },
      'Bloque de ahorro constituido exitosamente',
    );

    return block;
  }

  async listAllBlocks(): Promise<SavingsBlock[]> {
    return this.d.repos.savingsBlocks.listAll();
  }

  /**
   * Alerta de tesorería: detecta bloques que vencen en menos de 72 horas para que
   * la mesa de dinero asegure el saldo necesario en la caja de liquidación de Coinsenda.
   */
  async getTreasuryAlerts() {
    const now = this.d.clock.now();
    const window72hMs = 72 * 3600 * 1000;
    const maturing = await this.d.repos.savingsBlocks.findMaturing(window72hMs, now);

    let totalMaturing72h = 0n;
    const enriched = maturing.map((b) => {
      totalMaturing72h += b.totalPayoutMinor;
      const hoursRemaining = Math.max(0, Math.round((b.maturesAt.getTime() - now.getTime()) / (3600 * 1000)));
      return {
        id: b.id,
        userId: b.userId,
        termDays: b.termDays,
        principalMinor: b.principalMinor.toString(),
        lockedRate: b.lockedRate,
        expectedYieldMinor: b.expectedYieldMinor.toString(),
        totalPayoutMinor: b.totalPayoutMinor.toString(),
        currency: b.currency,
        status: b.status,
        startedAt: b.startedAt.toISOString(),
        maturesAt: b.maturesAt.toISOString(),
        hoursRemaining,
      };
    });

    return {
      windowHours: 72,
      totalMaturing72hMinor: totalMaturing72h.toString(),
      totalMaturingCount: enriched.length,
      maturingBlocks: enriched,
    };
  }

  /**
   * Procesa la maduración y liquidación automática de bloques vencidos.
   */
  async processMaturities(): Promise<{ completedCount: number }> {
    const now = this.d.clock.now();
    const all = await this.d.repos.savingsBlocks.listAll();
    let completedCount = 0;

    for (const b of all) {
      if (b.status === 'active' && now.getTime() >= b.maturesAt.getTime()) {
        try {
          const txId = newId('txn', now);
          // Doble partida de liquidación:
          // - Retira principal de savings_vault
          // - Retira rendimiento de fee_revenue (o reserva de tesorería)
          // - Acredita totalPayoutMinor a user_available
          await this.ledger.post(
            [
              { kind: 'savings_vault', userId: null, currency: 'COP', amountMinor: -b.principalMinor },
              { kind: 'fee_revenue', userId: null, currency: 'COP', amountMinor: -b.expectedYieldMinor },
              { kind: 'user_available', userId: b.userId, currency: 'COP', amountMinor: b.totalPayoutMinor },
            ],
            txId,
          );

          b.status = 'completed';
          b.completedAt = now;
          await this.d.repos.savingsBlocks.update(b);

          // Transacción en el feed
          await this.d.repos.transactions.create({
            id: txId,
            userId: b.userId,
            type: 'deposit',
            direction: 'in',
            currency: 'COP',
            amountMinor: b.totalPayoutMinor,
            feeMinor: 0n,
            status: 'completed',
            title: 'Vencimiento Bloque de Ahorro',
            subtitle: `${b.termDays} días (Capital + Intereses)`,
            description: `Liberación de capital: $${Number(b.principalMinor / 100n).toLocaleString('es-CO')} + Rendimiento: $${Number(b.expectedYieldMinor / 100n).toLocaleString('es-CO')}`,
            conversion: null,
            beneficiaryId: null,
            quoteId: null,
            providerRef: b.id,
            flagged: false,
            failureReason: null,
            createdAt: now,
            updatedAt: now,
          });

          completedCount++;
          this.d.logger.info(
            { blockId: b.id, userId: b.userId, totalPayout: b.totalPayoutMinor.toString() },
            'Bloque de ahorro vencido y liquidado automáticamente a la cuenta del usuario',
          );
        } catch (err) {
          this.d.logger.error({ err, blockId: b.id }, 'Error al procesar maduración de bloque de ahorro');
        }
      }
    }

    return { completedCount };
  }
}
