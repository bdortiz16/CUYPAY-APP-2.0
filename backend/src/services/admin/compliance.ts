import type { AlertResolution, AlertSeverity, AlertType, ComplianceAlert } from '../../domain/admin.js';
import type { BeneficiaryStatus, Transaction } from '../../domain/types.js';
import { newId } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { minorToMajorString } from '../../lib/money.js';
import type { BeneficiaryService } from '../beneficiaries.js';
import type { ServiceDeps } from '../deps.js';
import type { DomainEvent } from '../events.js';
import type { AdminContext, AuditService } from './audit.js';
import type { AdminCustomerService } from './customers.js';
import type { AdminPresenter } from './presenters.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** > 5 envíos en 1 hora. */
export const VELOCITY_MAX_TRANSFERS_PER_HOUR = 5;
/** ≥ 3 depósitos en 24 h entre el 90 % y el 100 % del umbral de transacción grande. */
export const STRUCTURING_MIN_COUNT = 3;
export const STRUCTURING_BAND_BPS = 9000n;
/** > 3 dispositivos nuevos en 30 días. */
export const MAX_NEW_DEVICES_30D = 3;

/**
 * Cumplimiento (SARLAFT): motor de alertas por reglas sobre el bus de eventos, cola de revisión AML
 * de beneficiarios y resolución de alertas (con marca de reporte a la UIAF).
 */
export class ComplianceService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
    private readonly beneficiaries: BeneficiaryService,
    private readonly customers: AdminCustomerService,
  ) {}

  /** Suscribe las reglas al bus. Devuelve la función para desuscribir. */
  start(): () => void {
    return this.d.events.subscribe((e) => this.onEvent(e));
  }

  private get largeTxMinor(): bigint {
    return BigInt(this.d.config.ALERT_LARGE_TX_MINOR);
  }

  private async onEvent(e: DomainEvent): Promise<void> {
    if (e.type === 'transaction.created') await this.evaluateTransaction(e.txn);
    else if (e.type === 'beneficiary.screened' && e.aml.result !== 'clear') {
      const hit = e.aml.result === 'hit';
      await this.raise({
        type: 'aml_hit',
        severity: hit ? 'high' : 'medium',
        customerId: e.beneficiary.userId,
        transactionId: null,
        description: hit
          ? `Beneficiario ${e.beneficiary.holderName} con coincidencia en listas restrictivas (Sartblock ${e.aml.referenceId}); inscripción rechazada`
          : `Beneficiario ${e.beneficiary.holderName} requiere revisión AML (Sartblock ${e.aml.referenceId})`,
        uiafSuggested: hit,
      });
    } else if (e.type === 'device.created') {
      const since = this.d.clock.now().getTime() - 30 * DAY;
      const recent = (await this.d.repos.devices.listByUser(e.device.userId)).filter((x) => x.createdAt.getTime() >= since);
      if (recent.length > MAX_NEW_DEVICES_30D) {
        await this.raise({
          type: 'multiple_devices',
          severity: 'medium',
          customerId: e.device.userId,
          transactionId: null,
          description: `${recent.length} dispositivos vinculados en los últimos 30 días`,
          uiafSuggested: false,
          dedupeWindowMs: 30 * DAY,
        });
      }
    }
  }

  /** COP equivalente simple para reglas (las transacciones de fase 1 son en COP). */
  private copAmount(t: Transaction): bigint | null {
    return t.currency === 'COP' ? t.amountMinor : null;
  }

  async evaluateTransaction(t: Transaction): Promise<void> {
    const amount = this.copAmount(t);
    const now = t.createdAt.getTime();
    if (t.type === 'deposit' && t.flagged) {
      await this.raise({
        type: 'deposit_over_limit',
        severity: 'medium',
        customerId: t.userId,
        transactionId: t.id,
        description: `Depósito de COP ${minorToMajorString(t.amountMinor)} supera el límite deposit_in del cliente`,
        uiafSuggested: false,
      });
    }
    if (amount !== null && amount >= this.largeTxMinor) {
      await this.raise({
        type: 'large_transaction',
        severity: 'high',
        customerId: t.userId,
        transactionId: t.id,
        description: `${t.type} individual de COP ${minorToMajorString(amount)} (umbral COP ${minorToMajorString(this.largeTxMinor)})`,
        uiafSuggested: true,
      });
    }
    if (t.type === 'transfer') {
      const recent = (await this.d.repos.transactions.listByUser(t.userId, { limit: 50 })).filter(
        (x) => x.type === 'transfer' && x.status !== 'failed' && now - x.createdAt.getTime() <= HOUR,
      );
      if (recent.length > VELOCITY_MAX_TRANSFERS_PER_HOUR) {
        await this.raise({
          type: 'velocity',
          severity: 'medium',
          customerId: t.userId,
          transactionId: t.id,
          description: `${recent.length} envíos en la última hora (máximo esperado ${VELOCITY_MAX_TRANSFERS_PER_HOUR})`,
          uiafSuggested: false,
          dedupeWindowMs: HOUR,
        });
      }
    }
    if (t.type === 'deposit' && amount !== null) {
      const low = (this.largeTxMinor * STRUCTURING_BAND_BPS) / 10_000n;
      const inBand = (x: Transaction) => x.currency === 'COP' && x.amountMinor >= low && x.amountMinor < this.largeTxMinor;
      if (inBand(t)) {
        const recent = (await this.d.repos.transactions.listByUser(t.userId, { limit: 200 })).filter(
          (x) => x.type === 'deposit' && x.status !== 'reversed' && now - x.createdAt.getTime() <= DAY && inBand(x),
        );
        if (recent.length >= STRUCTURING_MIN_COUNT) {
          const total = recent.reduce((s, x) => s + x.amountMinor, 0n);
          await this.raise({
            type: 'structuring',
            severity: 'high',
            customerId: t.userId,
            transactionId: t.id,
            description: `${recent.length} depósitos en 24 h justo bajo el umbral (total COP ${minorToMajorString(total)}); posible fraccionamiento`,
            uiafSuggested: true,
            dedupeWindowMs: DAY,
          });
        }
      }
    }
  }

  private async raise(a: {
    type: AlertType;
    severity: AlertSeverity;
    customerId: string;
    transactionId: string | null;
    description: string;
    uiafSuggested: boolean;
    /** No repetir la misma alerta abierta del cliente dentro de esta ventana. */
    dedupeWindowMs?: number;
  }): Promise<ComplianceAlert | null> {
    const now = this.d.clock.now();
    if (a.dedupeWindowMs) {
      const existing = (await this.d.repos.alerts.list()).find(
        (x) =>
          x.customerId === a.customerId &&
          x.type === a.type &&
          x.status === 'open' &&
          now.getTime() - x.createdAt.getTime() <= a.dedupeWindowMs!,
      );
      if (existing) return null;
    }
    const alert: ComplianceAlert = {
      id: newId('alr', now),
      type: a.type,
      severity: a.severity,
      customerId: a.customerId,
      transactionId: a.transactionId,
      description: a.description,
      uiafSuggested: a.uiafSuggested,
      status: 'open',
      resolution: null,
      resolutionNote: null,
      reportToUiaf: false,
      createdAt: now,
      resolvedAt: null,
      resolvedBy: null,
    };
    // La transacción queda marcada (flagged) en el portal vía la alerta; no se reescribe aquí para no
    // competir con el servicio que la está procesando.
    await this.d.repos.alerts.create(alert);
    this.d.logger.warn({ alertId: alert.id, type: alert.type, userId: alert.customerId }, 'compliance alert raised');
    await this.d.events.publish({ type: 'compliance.alert', alert });
    return alert;
  }

  // ── Cola AML de beneficiarios ──

  async listBeneficiaries(status: BeneficiaryStatus | undefined, p: AdminPresenter) {
    const items = (await this.d.repos.beneficiaries.listAll()).filter((b) => !b.deletedAt && (!status || b.status === status));
    return { items: await Promise.all(items.map((b) => p.beneficiaryJson(b))) };
  }

  async decideBeneficiary(ctx: AdminContext, id: string, decision: 'approve' | 'reject', reason: string, p: AdminPresenter) {
    const before = await this.d.repos.beneficiaries.byId(id);
    if (!before) throw new AppError('NOT_FOUND', 'Beneficiario no encontrado');
    const b = await this.beneficiaries.review(id, decision);
    await this.audit.record(ctx, {
      action: `beneficiary.${decision}`,
      targetType: 'beneficiary',
      targetId: id,
      reason,
      before: { status: before.status },
      after: { status: b.status, providerWithdrawAccountId: b.providerWithdrawAccountId },
    });
    return p.beneficiaryJson(b);
  }

  // ── Alertas ──

  async listAlerts(f: { status?: 'open' | 'resolved'; type?: AlertType; customerId?: string }, p: AdminPresenter) {
    const items = (await this.d.repos.alerts.list()).filter(
      (a) => (!f.status || a.status === f.status) && (!f.type || a.type === f.type) && (!f.customerId || a.customerId === f.customerId),
    );
    return { items: await Promise.all(items.map((a) => p.alert(a))) };
  }

  async resolveAlert(
    ctx: AdminContext,
    id: string,
    input: { resolution: AlertResolution; note: string; reportToUiaf: boolean },
    p: AdminPresenter,
  ) {
    const a = await this.d.repos.alerts.byId(id);
    if (!a) throw new AppError('NOT_FOUND', 'Alerta no encontrada');
    if (a.status === 'resolved') throw new AppError('CONFLICT', 'La alerta ya fue resuelta');
    const before = { status: a.status };
    const now = this.d.clock.now();
    a.status = 'resolved';
    a.resolution = input.resolution;
    a.resolutionNote = input.note;
    a.reportToUiaf = input.reportToUiaf || input.resolution === 'reported';
    a.resolvedAt = now;
    a.resolvedBy = ctx.admin.id;
    await this.d.repos.alerts.update(a);
    await this.audit.record(ctx, {
      action: 'compliance.alert_resolve',
      targetType: 'alert',
      targetId: id,
      reason: input.note,
      before,
      after: { status: a.status, resolution: a.resolution, reportToUiaf: a.reportToUiaf },
    });
    // TODO(compliance): generar el ROS en el formato de la UIAF (SIREL) cuando reportToUiaf = true.
    if (input.resolution === 'frozen' && (await this.d.repos.customerControls.get(a.customerId))?.status !== 'frozen') {
      await this.customers.freeze(ctx, a.customerId, `Alerta ${a.id}: ${input.note}`);
    }
    return p.alert(a);
  }
}
