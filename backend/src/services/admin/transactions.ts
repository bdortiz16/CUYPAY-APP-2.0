import type { LedgerAccount, Transaction, TxnStatus, TxnType } from '../../domain/types.js';
import { AppError } from '../../lib/errors.js';
import { minorToMajorString } from '../../lib/money.js';
import type { KeyedMutex, ServiceDeps } from '../deps.js';
import type { LedgerService } from '../ledger.js';
import type { LimitsService } from '../limits.js';
import type { AdminContext, AuditService } from './audit.js';
import { paginate } from './paginate.js';
import type { AdminPresenter } from './presenters.js';

export interface TxnFilters {
  type?: TxnType;
  status?: TxnStatus;
  currency?: 'COP' | 'BRL';
  customerId?: string;
  from?: Date;
  to?: Date;
  minAmountMinor?: number;
  flagged?: boolean;
  limit: number;
  cursor?: string;
}

/** Un envío `pending` se considera atascado (reversible) después de este tiempo. */
export const STUCK_PENDING_MS = 15 * 60_000;

export function accountLabel(a: LedgerAccount | undefined): string {
  if (!a) return 'unknown';
  if (a.kind === 'user_available') return `customer:${a.userId}:${a.currency}`;
  if (a.kind === 'user_held') return `customer:${a.userId}:${a.currency}:held`;
  return `${a.kind}:${a.currency}`;
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  // Evita inyección de fórmulas en Excel / Sheets.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export class AdminTransactionService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly mutex: KeyedMutex,
  ) {}

  async filter(f: Omit<TxnFilters, 'limit' | 'cursor'>): Promise<Transaction[]> {
    const alerted = new Set((await this.d.repos.alerts.list()).map((a) => a.transactionId));
    return (await this.d.repos.transactions.listAll()).filter(
      (t) =>
        (!f.type || t.type === f.type) &&
        (!f.status || t.status === f.status) &&
        (!f.currency || t.currency === f.currency || t.conversion?.toCurrency === f.currency) &&
        (!f.customerId || t.userId === f.customerId) &&
        (!f.from || t.createdAt >= f.from) &&
        (!f.to || t.createdAt < f.to) &&
        (f.minAmountMinor === undefined || t.amountMinor >= BigInt(f.minAmountMinor)) &&
        (f.flagged === undefined || (t.flagged || alerted.has(t.id)) === f.flagged),
    );
  }

  async list(f: TxnFilters, p: AdminPresenter) {
    const rows = await this.filter(f);
    const { page, nextCursor } = paginate(rows, (t) => ({ at: t.createdAt, id: t.id }), f.limit, f.cursor);
    return { items: await Promise.all(page.map((t) => p.transaction(t))), nextCursor };
  }

  private async get(id: string): Promise<Transaction> {
    const t = await this.d.repos.transactions.byId(id);
    if (!t) throw new AppError('NOT_FOUND', 'Transacción no encontrada');
    return t;
  }

  async detail(id: string, p: AdminPresenter) {
    const t = await this.get(id);
    const accounts = new Map((await this.d.repos.ledger.accounts()).map((a) => [a.id, a]));
    const entries = (await this.d.repos.ledger.entriesByTransaction(id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const ledgerEntries = entries.map((e) => ({
      id: e.id,
      journalId: e.journalId,
      account: accountLabel(accounts.get(e.accountId)),
      debitMinor: e.amountMinor < 0n ? Number(-e.amountMinor) : 0,
      creditMinor: e.amountMinor > 0n ? Number(e.amountMinor) : 0,
      currency: e.currency,
      createdAt: e.createdAt.toISOString(),
    }));

    // Línea de tiempo derivada de la transacción y de sus journals.
    const timeline: { at: string; event: string; detail: string | null }[] = [{ at: t.createdAt.toISOString(), event: 'created', detail: null }];
    const journals = [...new Map(entries.map((e) => [e.journalId, e.createdAt])).entries()];
    if (t.type === 'transfer') {
      if (journals[0]) timeline.push({ at: journals[0][1].toISOString(), event: 'held', detail: 'Fondos retenidos' });
      if (t.providerRef) timeline.push({ at: t.createdAt.toISOString(), event: 'provider_submitted', detail: `Coinsenda ${t.providerRef}` });
    } else if (t.providerRef) {
      timeline.push({ at: t.createdAt.toISOString(), event: 'provider_confirmed', detail: t.providerRef });
    }
    if (t.status === 'completed') timeline.push({ at: t.updatedAt.toISOString(), event: 'completed', detail: null });
    if (t.status === 'failed') timeline.push({ at: t.updatedAt.toISOString(), event: 'failed', detail: t.failureReason });
    if (t.status === 'reversed') timeline.push({ at: t.updatedAt.toISOString(), event: 'reversed', detail: t.failureReason });

    const providerRefs: Record<string, string | null> = {
      coinsendaWithdrawId: t.type === 'transfer' ? t.providerRef : null,
      coinsendaDepositId: t.type === 'deposit' ? t.providerRef : null,
      brlExecutionId: t.type === 'conversion' ? t.providerRef : null,
    };
    return {
      ...(await p.transaction(t)),
      title: t.title,
      subtitle: t.subtitle,
      description: t.description,
      beneficiaryId: t.beneficiaryId,
      quoteId: t.quoteId,
      ledgerEntries,
      timeline,
      providerRefs,
      alerts: (await this.d.repos.alerts.list()).filter((a) => a.transactionId === t.id).map((a) => ({ id: a.id, type: a.type, status: a.status })),
    };
  }

  /** Reverso con asientos compensatorios (nunca se borra historia). */
  async reverse(ctx: AdminContext, id: string, reason: string, p: AdminPresenter) {
    const first = await this.get(id);
    return this.mutex.run(first.userId, async () => {
      const t = await this.get(id);
      const now = this.d.clock.now();
      if (t.status !== 'completed' && t.status !== 'pending') {
        throw new AppError('CONFLICT', `No se puede reversar una transacción ${t.status}`, { status: t.status });
      }
      if (t.status === 'pending' && now.getTime() - t.createdAt.getTime() < STUCK_PENDING_MS) {
        throw new AppError('CONFLICT', 'La transacción sigue en curso; solo se reversan pendientes atascadas', {
          stuckAfterSeconds: STUCK_PENDING_MS / 1000,
        });
      }
      // El reverso no puede dejar saldo disponible negativo al cliente.
      const accounts = new Map((await this.d.repos.ledger.accounts()).map((a) => [a.id, a]));
      for (const [accountId, net] of await this.ledger.netByAccount(t.id)) {
        const acc = accounts.get(accountId);
        if (acc?.kind !== 'user_available' || net.amountMinor <= 0n) continue;
        const bal = await this.d.repos.ledger.balance(accountId);
        if (bal < net.amountMinor) {
          throw new AppError('INSUFFICIENT_FUNDS', 'El cliente no tiene saldo disponible suficiente para el reverso', {
            currency: net.currency,
            requiredMinor: Number(net.amountMinor),
            availableMinor: Number(bal),
          });
        }
      }
      const before = await p.transaction(t);
      const journalId = await this.ledger.reverseTransaction(t.id);
      await this.limits.voidFor(t.id);
      t.status = 'reversed';
      t.failureReason = `reversed_by_admin: ${reason}`;
      t.updatedAt = now;
      await this.d.repos.transactions.update(t);
      const after = await p.transaction(t);
      await this.audit.record(ctx, { action: 'transaction.reverse', targetType: 'transaction', targetId: t.id, reason, before, after: { ...after, journalId } });
      await this.d.events.publish({ type: 'transaction.updated', txn: t });
      const warnings: string[] = [];
      if (before.status === 'pending' && t.type === 'transfer' && t.providerRef) {
        warnings.push('Verifica/cancela el retiro en Coinsenda: el reverso solo afecta el libro de CuyPay.');
      }
      return { transaction: after, journalId, warnings };
    });
  }

  async exportCsv(f: { from?: Date; to?: Date; type?: TxnType }, p: AdminPresenter): Promise<string> {
    const rows = await this.filter(f);
    const header = [
      'id',
      'created_at',
      'updated_at',
      'customer_id',
      'customer_name',
      'type',
      'direction',
      'status',
      'currency',
      'amount',
      'fee',
      'to_currency',
      'to_amount',
      'rate',
      'counterparty',
      'provider_ref',
      'flagged',
    ];
    const lines = [header.join(',')];
    for (const t of [...rows].reverse()) {
      const j = await p.transaction(t);
      lines.push(
        [
          t.id,
          j.createdAt,
          j.updatedAt,
          t.userId,
          j.customerName,
          t.type,
          t.direction,
          t.status,
          t.currency,
          minorToMajorString(t.amountMinor),
          minorToMajorString(t.feeMinor),
          t.conversion?.toCurrency ?? '',
          t.conversion ? minorToMajorString(t.conversion.toAmountMinor) : '',
          j.conversion?.rate ?? '',
          j.counterparty,
          t.providerRef,
          t.flagged,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\r\n') + '\r\n';
  }
}
