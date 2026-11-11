import type { LimitRule, LimitsConfig } from '../../config.js';
import type { ReconBreak, ReconciliationRun } from '../../domain/admin.js';
import type { Currency, LedgerAccountKind, Tier } from '../../domain/types.js';
import { newId } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { applySpread, rateToNumber } from '../../lib/money.js';
import { periodRange } from '../../lib/time.js';
import type { ServiceDeps } from '../deps.js';
import { getFxSettings, getLimitsConfig, setFxSettings, setLimitsConfig, type FxSettings } from '../runtime-config.js';
import type { AdminContext, AuditService } from './audit.js';

const STALE_MS = 10 * 60_000;
const RECON_LOOKBACK_MS = 30 * 86_400_000;

const n = (v: bigint) => Number(v);

interface ProviderAccountDef {
  id: 'coinsenda_cop' | 'brl_partner';
  name: string;
  provider: 'coinsenda' | 'brl_partner';
  currency: Currency;
  /** Cuenta contable cuyo saldo (negado) es el saldo esperado en el proveedor. */
  ledgerKind: LedgerAccountKind;
}

const ACCOUNTS: ProviderAccountDef[] = [
  { id: 'coinsenda_cop', name: 'Coinsenda · COP (Bre-B)', provider: 'coinsenda', currency: 'COP', ledgerKind: 'breb_settlement' },
  { id: 'brl_partner', name: 'Socio BRL / PIX', provider: 'brl_partner', currency: 'BRL', ledgerKind: 'fx_clearing' },
];

const breakJson = (b: ReconBreak) => ({ kind: b.kind, reference: b.reference, amountMinor: n(b.amountMinor), currency: b.currency, detail: b.detail });

export function presentRecon(r: ReconciliationRun | null) {
  if (!r) return { status: 'never' as const, lastRunAt: null, runId: null, breaks: [] };
  return {
    status: r.status,
    runId: r.id,
    lastRunAt: (r.finishedAt ?? r.startedAt).toISOString(),
    triggeredBy: r.triggeredBy,
    error: r.error,
    breaks: r.breaks.map(breakJson),
  };
}

/** Tesorería: saldos en proveedores vs. pasivos del ledger, cobertura, ingresos, conciliación y FX. */
export class TreasuryService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  private async providerBalance(def: ProviderAccountDef) {
    const port = def.provider === 'coinsenda' ? this.d.coinsenda : this.d.brl;
    if (!port.getBalance) return { balance: null, asOf: null, error: 'El adaptador no expone saldo' };
    try {
      const b = await port.getBalance();
      return { balance: b.balanceMinor, asOf: b.asOf, error: null };
    } catch (err) {
      return { balance: null, asOf: null, error: (err as Error).message };
    }
  }

  /** Saldo neto de cuentas contables por (kind, currency). */
  private async ledgerTotals() {
    const accounts = await this.d.repos.ledger.accounts();
    const byKind = new Map<string, bigint>();
    for (const a of accounts) {
      const k = `${a.kind}:${a.currency}`;
      byKind.set(k, (byKind.get(k) ?? 0n) + (await this.d.repos.ledger.balance(a.id)));
    }
    const get = (kind: LedgerAccountKind, c: Currency) => byKind.get(`${kind}:${c}`) ?? 0n;
    const liabilities = (c: Currency) => get('user_available', c) + get('user_held', c) + get('card_pocket', c);
    return { get, liabilities, accounts };
  }

  async snapshot() {
    const now = this.d.clock.now();
    const totals = await this.ledgerTotals();
    const accounts = [];
    const providerByCurrency = new Map<Currency, bigint | null>();
    for (const def of ACCOUNTS) {
      const pb = await this.providerBalance(def);
      const ledgerExpected = -totals.get(def.ledgerKind, def.currency);
      providerByCurrency.set(def.currency, pb.balance);
      accounts.push({
        id: def.id,
        name: def.name,
        provider: def.provider,
        currency: def.currency,
        providerBalanceMinor: pb.balance === null ? null : n(pb.balance),
        ledgerBalanceMinor: n(ledgerExpected),
        differenceMinor: pb.balance === null ? null : n(pb.balance - ledgerExpected),
        lastSyncedAt: pb.asOf?.toISOString() ?? null,
        status: pb.error ? ('error' as const) : pb.asOf && now.getTime() - pb.asOf.getTime() > STALE_MS ? ('stale' as const) : ('ok' as const),
        error: pb.error,
      });
    }
    const currencies: Currency[] = ['COP', 'BRL'];
    const liabilities = Object.fromEntries(currencies.map((c) => [c, n(totals.liabilities(c))])) as Record<Currency, number>;
    const coverage = currencies.map((c) => {
      const prov = providerByCurrency.get(c) ?? null;
      const liab = totals.liabilities(c);
      return {
        currency: c,
        providerMinor: prov === null ? null : n(prov),
        liabilitiesMinor: n(liab),
        differenceMinor: prov === null ? null : n(prov - liab),
        ratio: prov === null ? null : liab === 0n ? (prov >= 0n ? 1 : 0) : Math.round((Number(prov) / Number(liab)) * 10_000) / 10_000,
      };
    });

    // Ingresos por comisiones (cuenta fee_revenue COP) hoy y en el mes calendario de Bogotá.
    const feeIds = new Set(totals.accounts.filter((a) => a.kind === 'fee_revenue' && a.currency === 'COP').map((a) => a.id));
    const day = periodRange(now, 'daily');
    const month = periodRange(now, 'monthly');
    let todayMinor = 0n;
    let monthMinor = 0n;
    for (const e of await this.d.repos.ledger.allEntries()) {
      if (!feeIds.has(e.accountId)) continue;
      if (e.createdAt >= day.start && e.createdAt < day.end) todayMinor += e.amountMinor;
      if (e.createdAt >= month.start && e.createdAt < month.end) monthMinor += e.amountMinor;
    }
    return {
      asOf: now.toISOString(),
      accounts,
      liabilities,
      coverage,
      revenue: { todayMinor: n(todayMinor), monthMinor: n(monthMinor), currency: 'COP' as const },
      reconciliation: presentRecon(await this.d.repos.reconciliations.latest()),
    };
  }

  /** Conciliación ledger vs. proveedores (saldos, depósitos Coinsenda, retiros Coinsenda). */
  async reconcile(ctx: AdminContext | null, reason: string) {
    const now = this.d.clock.now();
    const latest = await this.d.repos.reconciliations.latest();
    if (latest?.status === 'running') throw new AppError('CONFLICT', 'Ya hay una conciliación en curso');
    const run: ReconciliationRun = {
      id: newId('rec', now),
      startedAt: now,
      finishedAt: null,
      status: 'running',
      breaks: [],
      triggeredBy: ctx?.admin.id ?? 'system',
      error: null,
    };
    await this.d.repos.reconciliations.create(run);
    try {
      run.breaks = await this.findBreaks();
      run.status = run.breaks.length ? 'breaks' : 'ok';
    } catch (err) {
      run.status = 'error';
      run.error = (err as Error).message;
    }
    run.finishedAt = this.d.clock.now();
    await this.d.repos.reconciliations.update(run);
    if (ctx) {
      await this.audit.record(ctx, {
        action: 'treasury.reconcile',
        targetType: 'reconciliation',
        targetId: run.id,
        reason,
        after: { status: run.status, breaks: run.breaks.length },
      });
    }
    const snapshot = await this.snapshot();
    await this.d.events.publish({ type: 'treasury.updated', snapshot });
    return presentRecon(run);
  }

  private async findBreaks(): Promise<ReconBreak[]> {
    const breaks: ReconBreak[] = [];
    const now = this.d.clock.now();
    const totals = await this.ledgerTotals();

    // 1) Saldos: proveedor vs. lo que el ledger espera que haya en el proveedor.
    for (const def of ACCOUNTS) {
      const pb = await this.providerBalance(def);
      if (pb.balance === null) continue;
      const expected = -totals.get(def.ledgerKind, def.currency);
      if (pb.balance !== expected) {
        breaks.push({
          kind: 'amount_mismatch',
          reference: `balance:${def.id}`,
          amountMinor: pb.balance - expected,
          currency: def.currency,
          detail: `Saldo en proveedor ${pb.balance} vs. ledger ${expected}`,
        });
      }
    }

    // 2) Depósitos Coinsenda (ventana de los 200 más recientes).
    const deposits = (await this.d.coinsenda.listDeposits()).filter((x) => x.state === 'accepted' && x.currency === 'COP');
    const providerIds = new Set(deposits.map((x) => x.id));
    for (const dep of deposits) {
      const p = await this.d.repos.processedDeposits.get(dep.id);
      if (!p || !p.transactionId) {
        breaks.push({
          kind: 'missing_in_ledger',
          reference: dep.id,
          amountMinor: dep.amountMinor,
          currency: 'COP',
          detail: p?.note ? `Depósito sin acreditar (${p.note})` : 'Depósito del proveedor sin registrar en el ledger',
        });
        continue;
      }
      const t = await this.d.repos.transactions.byId(p.transactionId);
      if (t && t.status !== 'reversed' && t.amountMinor !== dep.amountMinor) {
        breaks.push({ kind: 'amount_mismatch', reference: dep.id, amountMinor: dep.amountMinor - t.amountMinor, currency: 'COP', detail: `Transacción ${t.id}` });
      }
    }
    const oldest = deposits.reduce<Date | null>((m, x) => (!m || x.createdAt < m ? x.createdAt : m), null);
    const windowFull = deposits.length >= 200;
    const all = await this.d.repos.transactions.listAll();
    const isInternalRef = (ref: string | null) => Boolean(ref && (ref.startsWith('sbk_') || ref.startsWith('loan_')));
    for (const t of all) {
      if (t.type !== 'deposit' || t.status === 'reversed' || !t.providerRef || isInternalRef(t.providerRef)) continue;
      if (windowFull && oldest && t.createdAt < oldest) continue; // fuera de la ventana del proveedor
      if (!providerIds.has(t.providerRef)) {
        breaks.push({ kind: 'missing_in_provider', reference: t.providerRef, amountMinor: t.amountMinor, currency: t.currency, detail: `Transacción ${t.id}` });
      }
    }

    // 3) Retiros Coinsenda de los últimos 30 días.
    for (const t of all) {
      if (t.type !== 'transfer' || isInternalRef(t.providerRef) || now.getTime() - t.createdAt.getTime() > RECON_LOOKBACK_MS) continue;
      if (t.status !== 'completed' && t.status !== 'pending') continue;
      if (!t.providerRef) {
        if (t.status === 'completed') {
          breaks.push({ kind: 'missing_in_provider', reference: t.id, amountMinor: t.amountMinor, currency: t.currency, detail: 'Envío completado sin id de retiro' });
        }
        continue;
      }
      const w = await this.d.coinsenda.getWithdraw(t.providerRef);
      if (!w) {
        breaks.push({ kind: 'missing_in_provider', reference: t.providerRef, amountMinor: t.amountMinor, currency: t.currency, detail: `Transacción ${t.id}` });
      } else if (t.status === 'completed' && w.state !== 'accepted') {
        breaks.push({ kind: 'status_mismatch', reference: t.providerRef, amountMinor: t.amountMinor, currency: t.currency, detail: `Ledger completed vs. proveedor ${w.state}` });
      } else if (t.status === 'pending' && ['accepted', 'rejected', 'canceled', 'failed'].includes(w.state)) {
        breaks.push({ kind: 'status_mismatch', reference: t.providerRef, amountMinor: t.amountMinor, currency: t.currency, detail: `Ledger pending vs. proveedor ${w.state}` });
      }
    }
    return breaks;
  }

  // ── FX ──

  async getFx() {
    const s = await getFxSettings(this.d);
    let midRate: number | null = null;
    let customerRate: number | null = null;
    let rateError: string | null = null;
    try {
      const mid = await this.d.brl.getMidRate('COP', 'BRL');
      midRate = rateToNumber(mid.rateScaled);
      customerRate = rateToNumber(applySpread(mid.rateScaled, s.value.spreadBps));
    } catch (err) {
      rateError = (err as Error).message;
    }
    return {
      pair: 'COP/BRL' as const,
      midRate,
      customerRate,
      ...s.value,
      quoteTtlSeconds: this.d.config.QUOTE_TTL_SECONDS,
      updatedAt: s.updatedAt?.toISOString() ?? null,
      updatedBy: s.updatedBy,
      rateError,
    };
  }

  async updateFx(ctx: AdminContext, patch: Partial<FxSettings>, reason: string) {
    const current = (await getFxSettings(this.d)).value;
    const next: FxSettings = { ...current, ...patch };
    if (next.maxAmountMinor !== null && next.maxAmountMinor < next.minAmountMinor) {
      throw new AppError('VALIDATION_ERROR', 'maxAmountMinor debe ser ≥ minAmountMinor', { field: 'maxAmountMinor' });
    }
    await setFxSettings(this.d, next, ctx.admin.email);
    await this.audit.record(ctx, { action: 'treasury.fx_update', targetType: 'fx', targetId: 'COP/BRL', reason, before: current, after: next });
    return this.getFx();
  }
}

/** Configuración de límites por nivel (editable en caliente). */
export class LimitsConfigService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
  ) {}

  async get() {
    const cfg = await getLimitsConfig(this.d);
    return {
      currency: 'COP' as const,
      tiers: (['basic', 'full'] as const).map((tier) => ({ tier, items: cfg.value[tier] })),
      updatedAt: cfg.updatedAt?.toISOString() ?? null,
      updatedBy: cfg.updatedBy,
    };
  }

  async update(ctx: AdminContext, tier: Tier, items: LimitRule[], reason: string) {
    const seen = new Set<string>();
    for (const i of items) {
      const k = `${i.operation}:${i.period}`;
      if (seen.has(k)) throw new AppError('VALIDATION_ERROR', `Regla duplicada: ${k}`, { field: 'items' });
      seen.add(k);
    }
    const current = (await getLimitsConfig(this.d)).value;
    const next: LimitsConfig = { ...current, [tier]: items };
    await setLimitsConfig(this.d, next, ctx.admin.email);
    await this.audit.record(ctx, { action: 'limits.update', targetType: 'limits_tier', targetId: tier, reason, before: current[tier], after: items });
    return this.get();
  }
}
