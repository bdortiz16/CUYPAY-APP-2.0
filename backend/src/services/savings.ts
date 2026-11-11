import type { SavingsBlock, SavingsConfig, SavingsRateTier, Transaction, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { AdminContext, AuditService } from './admin/audit.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';
import type { LedgerService, Leg } from './ledger.js';
import { assertNotFrozen } from './runtime-config.js';

export const ALLOWED_SAVINGS_TERMS = [30, 60, 90, 180, 360] as const;

export interface EnrichedSavingsBlockDto {
  id: string;
  userId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  termDays: number;
  principalMinor: string;
  lockedRate: number;
  expectedYieldMinor: string;
  totalPayoutMinor: string;
  currency: string;
  status: SavingsBlock['status'];
  escrowStatus: NonNullable<SavingsBlock['escrowStatus']>;
  escrowFundedAt: string | null;
  escrowFundedBy: string | null;
  startedAt: string;
  maturesAt: string;
  completedAt: string | null;
  hoursRemaining: number;
}

export class SavingsService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
    private readonly audit?: AuditService,
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
    this.d.logger.info({ adminEmail, rates: updated.rates }, 'Tasas y configuración de Bolsillo de Ahorro actualizadas por admin');
    return updated;
  }

  async listUserBlocks(userId: string) {
    const now = this.d.clock.now();
    const blocks = await this.d.repos.savingsBlocks.listByUser(userId);
    let totalPrincipal = 0n;
    let totalExpectedActiveYield = 0n;
    let totalYieldEarned = 0n;
    let activeCount = 0;

    for (const b of blocks) {
      if (b.status === 'active' || b.status === 'maturing_soon') {
        totalPrincipal += b.principalMinor;
        totalExpectedActiveYield += b.expectedYieldMinor;
        activeCount++;
      } else if (b.status === 'completed') {
        totalYieldEarned += b.expectedYieldMinor;
      }
    }

    return {
      blocks: blocks.map((b) => {
        const diffMs = b.maturesAt.getTime() - now.getTime();
        const isWithin72h = (b.status === 'active' || b.status === 'maturing_soon') && diffMs <= 72 * 3600 * 1000 && diffMs > 0;
        const displayStatus = isWithin72h ? 'maturing_soon' : b.status;
        return {
          id: b.id,
          termDays: b.termDays,
          principalMinor: b.principalMinor.toString(),
          lockedRate: b.lockedRate,
          expectedYieldMinor: b.expectedYieldMinor.toString(),
          totalPayoutMinor: b.totalPayoutMinor.toString(),
          currency: b.currency,
          status: displayStatus,
          escrowStatus: b.escrowStatus ?? (b.status === 'completed' ? 'settled' : 'unfunded'),
          startedAt: b.startedAt.toISOString(),
          maturesAt: b.maturesAt.toISOString(),
          completedAt: b.completedAt?.toISOString() ?? null,
        };
      }),
      summary: {
        totalPrincipalMinor: totalPrincipal.toString(),
        totalExpectedYieldMinor: totalExpectedActiveYield.toString(),
        totalYieldEarnedMinor: totalYieldEarned.toString(),
        activeCount,
      },
    };
  }

  async createBlock(user: User, termDays: number, principalMinor: bigint): Promise<SavingsBlock> {
    requireKycApproved(user);
    await assertNotFrozen(this.d, user.id);

    const config = await this.d.repos.savingsConfig.get();
    const tier = config.rates.find((r: SavingsRateTier) => r.termDays === termDays && r.enabled);
    if (!tier) {
      throw new AppError('VALIDATION_ERROR', `El plazo de ${termDays} días no está disponible en este momento`, { termDays });
    }

    if (principalMinor < config.minAmountMinor) {
      throw new AppError(
        'VALIDATION_ERROR',
        `El monto mínimo para un bolsillo de ahorro es de $${Number(config.minAmountMinor / 100n).toLocaleString('es-CO')} COP`,
        { minAmountMinor: config.minAmountMinor.toString() },
      );
    }

    if (principalMinor > config.maxAmountMinor) {
      throw new AppError(
        'VALIDATION_ERROR',
        `El monto máximo permitido es de $${Number(config.maxAmountMinor / 100n).toLocaleString('es-CO')} COP`,
        { maxAmountMinor: config.maxAmountMinor.toString() },
      );
    }

    const now = this.d.clock.now();
    const wallet = await this.ledger.wallet(user.id, 'COP');
    if (wallet.availableMinor < principalMinor) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente en tu billetera COP para bloquear en tu Bolsillo de Ahorro', {
        available: wallet.availableMinor.toString(),
        required: principalMinor.toString(),
      });
    }

    // Rendimiento = Capital * (Tasa / 100) * (Días / 365)
    const expectedYieldNum = Math.round(Number(principalMinor) * (tier.ratePercent / 100) * (termDays / 365));
    const expectedYieldMinor = BigInt(Math.max(1, expectedYieldNum));
    const totalPayoutMinor = principalMinor + expectedYieldMinor;

    const blockId = newId('sbk', now);
    const maturesAt = new Date(now.getTime() + termDays * 24 * 3600 * 1000);

    // Doble partida: debita user_available del cliente y suma a nuestro Bolsillo Recaudo de Intereses / Ahorros (savings_vault)
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
      lockedRate: tier.ratePercent,
      expectedYieldMinor,
      totalPayoutMinor,
      currency: 'COP',
      status: 'active',
      escrowStatus: 'unfunded',
      escrowFundedAt: null,
      escrowFundedBy: null,
      startedAt: now,
      maturesAt,
      completedAt: null,
      contractVersion: 1,
      contractAcceptedAt: now,
      createdAt: now,
    };

    await this.d.repos.savingsBlocks.create(block);

    const txn: Transaction = {
      id: txId,
      userId: user.id,
      type: 'savings',
      direction: 'out',
      currency: 'COP',
      amountMinor: principalMinor,
      feeMinor: 0n,
      status: 'completed',
      title: 'Bolsillo de Ahorro',
      subtitle: `${termDays} días (${tier.ratePercent}% E.A.)`,
      description: `Capital bloqueado por ${termDays} días. Reintegro programado: ${maturesAt.toISOString()}`,
      conversion: null,
      beneficiaryId: null,
      quoteId: null,
      providerRef: blockId,
      flagged: false,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repos.transactions.create(txn);
    await this.d.events.publish({ type: 'transaction.created', txn });

    this.d.logger.info(
      { userId: user.id, blockId, termDays, principalMinor: principalMinor.toString(), lockedRate: tier.ratePercent },
      'Bolsillo de ahorro constituido exitosamente',
    );

    return block;
  }

  async listAllBlocks(): Promise<SavingsBlock[]> {
    return this.d.repos.savingsBlocks.listAll();
  }

  async listAllBlocksEnriched(): Promise<EnrichedSavingsBlockDto[]> {
    const now = this.d.clock.now();
    const [all, users] = await Promise.all([this.d.repos.savingsBlocks.listAll(), this.d.repos.users.listAll()]);
    const userMap = new Map(users.map((u) => [u.id, u]));

    const sorted = [...all].sort((a, b) => {
      const aActive = a.status === 'active' || a.status === 'maturing_soon' ? 0 : 1;
      const bActive = b.status === 'active' || b.status === 'maturing_soon' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      if (aActive === 0) return a.maturesAt.getTime() - b.maturesAt.getTime();
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    return sorted.map((b) => {
      const u = userMap.get(b.userId);
      const customerName = u ? `${u.firstName} ${u.lastName}`.trim() : b.userId;
      const hoursRemaining = Math.max(0, Math.round(((b.maturesAt.getTime() - now.getTime()) / (3600 * 1000)) * 10) / 10);
      return {
        id: b.id,
        userId: b.userId,
        customerName,
        customerEmail: u?.email ?? '',
        customerPhone: u?.phone ?? '',
        termDays: b.termDays,
        principalMinor: b.principalMinor.toString(),
        lockedRate: b.lockedRate,
        expectedYieldMinor: b.expectedYieldMinor.toString(),
        totalPayoutMinor: b.totalPayoutMinor.toString(),
        currency: b.currency,
        status: b.status,
        escrowStatus: b.escrowStatus ?? (b.status === 'completed' ? 'settled' : 'unfunded'),
        escrowFundedAt: b.escrowFundedAt?.toISOString() ?? null,
        escrowFundedBy: b.escrowFundedBy ?? null,
        startedAt: b.startedAt.toISOString(),
        maturesAt: b.maturesAt.toISOString(),
        completedAt: b.completedAt?.toISOString() ?? null,
        hoursRemaining,
      };
    });
  }

  /** Estado consolidado del Bolsillo Recaudo de Intereses / Ahorros y la Reserva Bloqueada 72h. */
  async getPoolSummary() {
    const now = this.d.clock.now();
    const window72hMs = 72 * 3600 * 1000;
    const [collectionPoolBalanceMinor, escrowLockedBalanceMinor, all] = await Promise.all([
      this.ledger.systemPoolBalance('savings_vault', 'COP'),
      this.ledger.systemPoolBalance('savings_escrow', 'COP'),
      this.d.repos.savingsBlocks.listAll(),
    ]);

    let totalActivePrincipalMinor = 0n;
    let totalPendingYieldMinor = 0n;
    let totalActivePayoutMinor = 0n;
    let unescrowedPrincipalMinor = 0n;
    let maturing72hUnfundedMinor = 0n;
    let maturing72hFundedMinor = 0n;
    let maturing72hUnfundedCount = 0;
    let maturing72hTotalCount = 0;
    let activeBlocksCount = 0;
    let completedBlocksCount = 0;

    for (const b of all) {
      if (b.status === 'active' || b.status === 'maturing_soon') {
        activeBlocksCount++;
        totalActivePrincipalMinor += b.principalMinor;
        totalPendingYieldMinor += b.expectedYieldMinor;
        totalActivePayoutMinor += b.totalPayoutMinor;

        const isFunded = b.escrowStatus === 'funded_locked';
        if (!isFunded) {
          unescrowedPrincipalMinor += b.principalMinor;
        }
        if (b.maturesAt.getTime() - now.getTime() <= window72hMs) {
          maturing72hTotalCount++;
          if (isFunded) {
            maturing72hFundedMinor += b.totalPayoutMinor;
          } else {
            maturing72hUnfundedCount++;
            maturing72hUnfundedMinor += b.totalPayoutMinor;
          }
        }
      } else if (b.status === 'completed') {
        completedBlocksCount++;
      }
    }

    const deployedExternallyMinor =
      unescrowedPrincipalMinor > collectionPoolBalanceMinor
        ? unescrowedPrincipalMinor - collectionPoolBalanceMinor
        : 0n;

    return {
      currency: 'COP' as const,
      collectionPoolBalanceMinor: collectionPoolBalanceMinor.toString(),
      escrowLockedBalanceMinor: escrowLockedBalanceMinor.toString(),
      totalActivePrincipalMinor: totalActivePrincipalMinor.toString(),
      totalPendingYieldMinor: totalPendingYieldMinor.toString(),
      totalActivePayoutMinor: totalActivePayoutMinor.toString(),
      deployedExternallyMinor: deployedExternallyMinor.toString(),
      maturing72hUnfundedMinor: maturing72hUnfundedMinor.toString(),
      maturing72hFundedMinor: maturing72hFundedMinor.toString(),
      maturing72hUnfundedCount,
      maturing72hTotalCount,
      activeBlocksCount,
      completedBlocksCount,
    };
  }

  /** Admin retira capital del Bolsillo Recaudo de Intereses / Ahorros para inversión y generación de rendimientos. */
  async withdrawFromPool(ctx: AdminContext | null, amountMinor: bigint, reason: string) {
    if (amountMinor <= 0n) {
      throw new AppError('VALIDATION_ERROR', 'El monto a retirar debe ser mayor a cero');
    }
    const available = await this.ledger.systemPoolBalance('savings_vault', 'COP');
    if (available < amountMinor) {
      throw new AppError(
        'INSUFFICIENT_FUNDS',
        `Saldo insuficiente en el Bolsillo Recaudo de Ahorros ($${Number(available / 100n).toLocaleString('es-CO')} COP disponibles).`,
        { availableMinor: available.toString(), requestedMinor: amountMinor.toString() },
      );
    }
    await this.ledger.post(
      [
        { kind: 'savings_vault', userId: null, currency: 'COP', amountMinor: -amountMinor },
        { kind: 'treasury_capital', userId: null, currency: 'COP', amountMinor: amountMinor },
      ],
      null,
    );
    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'savings.pool_withdraw',
        targetType: 'savings_vault',
        targetId: 'COP',
        reason,
        after: { amountMinor: amountMinor.toString() },
      });
    }
    return this.getPoolSummary();
  }

  /** Admin devuelve/inyecta capital + rendimientos al Bolsillo Recaudo de Intereses / Ahorros. */
  async depositToPool(ctx: AdminContext | null, amountMinor: bigint, reason: string) {
    if (amountMinor <= 0n) {
      throw new AppError('VALIDATION_ERROR', 'El monto a abonar debe ser mayor a cero');
    }
    await this.ledger.post(
      [
        { kind: 'treasury_capital', userId: null, currency: 'COP', amountMinor: -amountMinor },
        { kind: 'savings_vault', userId: null, currency: 'COP', amountMinor: amountMinor },
      ],
      null,
    );
    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'savings.pool_deposit',
        targetType: 'savings_vault',
        targetId: 'COP',
        reason,
        after: { amountMinor: amountMinor.toString() },
      });
    }
    return this.getPoolSummary();
  }

  /**
   * Faltando 72 horas (o antes), el Admin coloca y bloquea el capital + intereses del bloque en
   * `savings_escrow` para que a la fecha y hora exacta de vencimiento se reintegre automáticamente al cliente.
   */
  async fundBlockEscrow(ctx: AdminContext | null, blockId: string, reason: string) {
    const b = await this.d.repos.savingsBlocks.byId(blockId);
    if (!b) throw new AppError('NOT_FOUND', 'Bolsillo de ahorro no encontrado');
    if (b.status !== 'active' && b.status !== 'maturing_soon') {
      throw new AppError('CONFLICT', 'Solo se puede fondear y bloquear un bolsillo activo');
    }
    if (b.escrowStatus === 'funded_locked') {
      throw new AppError('CONFLICT', 'Este bolsillo ya tiene el capital e intereses bloqueados para el reintegro automático');
    }

    const now = this.d.clock.now();
    const vaultBal = await this.ledger.systemPoolBalance('savings_vault', 'COP');
    const fromVault = vaultBal <= 0n ? 0n : vaultBal >= b.totalPayoutMinor ? b.totalPayoutMinor : vaultBal;
    const fromCapital = b.totalPayoutMinor - fromVault;

    const legs: Leg[] = [];
    if (fromVault > 0n) {
      legs.push({ kind: 'savings_vault', userId: null, currency: 'COP', amountMinor: -fromVault });
    }
    if (fromCapital > 0n) {
      legs.push({ kind: 'treasury_capital', userId: null, currency: 'COP', amountMinor: -fromCapital });
    }
    legs.push({ kind: 'savings_escrow', userId: null, currency: 'COP', amountMinor: b.totalPayoutMinor });

    await this.ledger.post(legs, null);

    b.escrowStatus = 'funded_locked';
    b.escrowFundedAt = now;
    b.escrowFundedBy = ctx?.admin.email ?? 'admin@cuypay.com';
    await this.d.repos.savingsBlocks.update(b);

    if (ctx && this.audit) {
      await this.audit.record(ctx, {
        action: 'savings.escrow_lock',
        targetType: 'savings_block',
        targetId: b.id,
        reason,
        after: {
          totalPayoutMinor: b.totalPayoutMinor.toString(),
          fromVaultMinor: fromVault.toString(),
          fromCapitalMinor: fromCapital.toString(),
          maturesAt: b.maturesAt.toISOString(),
        },
      });
    }

    return {
      blockId: b.id,
      escrowStatus: b.escrowStatus,
      escrowFundedAt: b.escrowFundedAt.toISOString(),
      escrowFundedBy: b.escrowFundedBy,
      totalPayoutMinor: b.totalPayoutMinor.toString(),
      pool: await this.getPoolSummary(),
    };
  }

  /** Bloquea en lote todos los bolsillos activos que vencen en menos de 72 horas y aún no están bloqueados. */
  async fundAllMaturing72h(ctx: AdminContext | null, reason: string) {
    const now = this.d.clock.now();
    const maturing = await this.d.repos.savingsBlocks.findMaturing(72 * 3600 * 1000, now);
    let fundedCount = 0;
    let totalLockedMinor = 0n;
    for (const b of maturing) {
      if (b.escrowStatus !== 'funded_locked') {
        await this.fundBlockEscrow(ctx, b.id, reason);
        fundedCount++;
        totalLockedMinor += b.totalPayoutMinor;
      }
    }
    return {
      fundedCount,
      totalLockedMinor: totalLockedMinor.toString(),
      pool: await this.getPoolSummary(),
    };
  }

  /**
   * Alerta de tesorería: detecta bloques que vencen en menos de 72 horas para que
   * el administrador coloque y bloquee el capital + intereses.
   */
  async getTreasuryAlerts() {
    const now = this.d.clock.now();
    const window72hMs = 72 * 3600 * 1000;
    const [maturing, users] = await Promise.all([
      this.d.repos.savingsBlocks.findMaturing(window72hMs, now),
      this.d.repos.users.listAll(),
    ]);
    const userMap = new Map(users.map((u) => [u.id, u]));

    let totalMaturing72h = 0n;
    let unfundedMaturing72h = 0n;
    let unfundedCount = 0;

    const enriched = maturing.map((b) => {
      totalMaturing72h += b.totalPayoutMinor;
      const escrowStatus = b.escrowStatus ?? 'unfunded';
      if (escrowStatus !== 'funded_locked') {
        unfundedMaturing72h += b.totalPayoutMinor;
        unfundedCount++;
      }
      const u = userMap.get(b.userId);
      const customerName = u ? `${u.firstName} ${u.lastName}`.trim() : b.userId;
      const hoursRemaining = Math.max(0, Math.round((b.maturesAt.getTime() - now.getTime()) / (3600 * 1000)));
      return {
        id: b.id,
        userId: b.userId,
        customerName,
        customerEmail: u?.email ?? '',
        customerPhone: u?.phone ?? '',
        termDays: b.termDays,
        principalMinor: b.principalMinor.toString(),
        lockedRate: b.lockedRate,
        expectedYieldMinor: b.expectedYieldMinor.toString(),
        totalPayoutMinor: b.totalPayoutMinor.toString(),
        currency: b.currency,
        status: b.status,
        escrowStatus,
        escrowFundedAt: b.escrowFundedAt?.toISOString() ?? null,
        escrowFundedBy: b.escrowFundedBy ?? null,
        startedAt: b.startedAt.toISOString(),
        maturesAt: b.maturesAt.toISOString(),
        completedAt: b.completedAt?.toISOString() ?? null,
        hoursRemaining,
      };
    });

    return {
      windowHours: 72,
      totalMaturing72hMinor: totalMaturing72h.toString(),
      unfundedMaturing72hMinor: unfundedMaturing72h.toString(),
      totalMaturingCount: enriched.length,
      unfundedMaturingCount: unfundedCount,
      maturingBlocks: enriched,
    };
  }

  /**
   * Procesa la maduración y reintegro automático en el día y hora exacta (`now >= maturesAt`).
   * Ejecutado continuamente por `poller.ts` cada pocos segundos y disponible también bajo demanda en Admin.
   */
  async processMaturities(): Promise<{ completedCount: number }> {
    const now = this.d.clock.now();
    const all = await this.d.repos.savingsBlocks.listAll();
    let completedCount = 0;

    for (const b of all) {
      if ((b.status === 'active' || b.status === 'maturing_soon') && now.getTime() >= b.maturesAt.getTime()) {
        try {
          const txId = newId('txn', now);
          if (b.escrowStatus === 'funded_locked') {
            // Reintegra directamente desde la Reserva Bloqueada 72h (savings_escrow -> user_available)
            await this.ledger.post(
              [
                { kind: 'savings_escrow', userId: null, currency: 'COP', amountMinor: -b.totalPayoutMinor },
                { kind: 'user_available', userId: b.userId, currency: 'COP', amountMinor: b.totalPayoutMinor },
              ],
              txId,
            );
          } else {
            // Respaldo automático si venció sin pre-bloqueo manual previo
            await this.ledger.post(
              [
                { kind: 'savings_vault', userId: null, currency: 'COP', amountMinor: -b.principalMinor },
                { kind: 'fee_revenue', userId: null, currency: 'COP', amountMinor: -b.expectedYieldMinor },
                { kind: 'user_available', userId: b.userId, currency: 'COP', amountMinor: b.totalPayoutMinor },
              ],
              txId,
            );
          }

          b.status = 'completed';
          b.escrowStatus = 'settled';
          b.completedAt = now;
          await this.d.repos.savingsBlocks.update(b);

          const txn: Transaction = {
            id: txId,
            userId: b.userId,
            type: 'deposit',
            direction: 'in',
            currency: 'COP',
            amountMinor: b.totalPayoutMinor,
            feeMinor: 0n,
            status: 'completed',
            title: 'Bolsillo de Ahorro CuyPay',
            subtitle: `${b.termDays} días (Capital + Intereses)`,
            description: `Reintegro automático de capital ($${Number(b.principalMinor / 100n).toLocaleString('es-CO')}) + intereses ($${Number(b.expectedYieldMinor / 100n).toLocaleString('es-CO')})`,
            conversion: null,
            beneficiaryId: null,
            quoteId: null,
            providerRef: b.id,
            flagged: false,
            failureReason: null,
            createdAt: now,
            updatedAt: now,
          };
          await this.d.repos.transactions.create(txn);
          await this.d.events.publish({ type: 'transaction.created', txn });

          completedCount++;
          this.d.logger.info(
            { blockId: b.id, userId: b.userId, totalPayout: b.totalPayoutMinor.toString() },
            'Bolsillo de ahorro vencido y reintegrado automáticamente en hora exacta a la cuenta del cliente',
          );
        } catch (err) {
          this.d.logger.error({ err, blockId: b.id }, 'Error al procesar maduración de bolsillo de ahorro');
        }
      }
    }

    return { completedCount };
  }
}
