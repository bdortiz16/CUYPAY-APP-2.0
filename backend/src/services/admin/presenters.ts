import type { AdminUser, ComplianceAlert, CustomerControl } from '../../domain/admin.js';
import type { AmlCheck, Beneficiary, Transaction, User } from '../../domain/types.js';
import { rateToNumber, toSafeNumber } from '../../lib/money.js';
import type { ServiceDeps } from '../deps.js';

/** Serialización de las entidades del portal admin (docs/ADMIN_API.md), con enmascaramiento de PII. */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const n = toSafeNumber;

// ── Enmascaramiento ──
export const maskPhone = (p: string): string => (p.length <= 8 ? '***' + p.slice(-2) : `${p.slice(0, 6)}***${p.slice(-4)}`);
export const maskEmail = (e: string): string => {
  const [user = '', domain = ''] = e.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
};
export const maskDoc = (d: string): string => `****${d.slice(-4)}`;
/** Llaves Bre-B numéricas (celular / documento) se enmascaran; los alias @ no son PII sensible. */
export const maskAlias = (a: string): string => (/^\+?\d{6,}$/.test(a) ? `${a.slice(0, 3)}***${a.slice(-4)}` : a);

export interface PresentOpts {
  pii: boolean;
}

export const presentAdmin = (a: AdminUser) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  role: a.role,
  status: a.status,
  lastLoginAt: iso(a.lastLoginAt),
  createdAt: iso(a.createdAt),
});

export function presentAlert(a: ComplianceAlert, customerName: string | null) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    customerId: a.customerId,
    customerName,
    transactionId: a.transactionId,
    description: a.description,
    uiafSuggested: a.uiafSuggested,
    reportToUiaf: a.reportToUiaf,
    status: a.status,
    resolution: a.resolution,
    resolutionNote: a.resolutionNote,
    createdAt: iso(a.createdAt),
    resolvedAt: iso(a.resolvedAt),
    resolvedBy: a.resolvedBy,
  };
}

export function presentAml(aml: AmlCheck | null) {
  if (!aml) return null;
  const raw = aml.raw as { matches?: unknown } | null;
  const matches = Array.isArray(raw?.matches)
    ? (raw!.matches as Record<string, unknown>[]).map((m) => ({
        list: String(m.list ?? m.source ?? 'unknown'),
        name: String(m.name ?? ''),
        score: typeof m.score === 'number' ? m.score : null,
      }))
    : [];
  return { provider: aml.provider, result: aml.result, referenceId: aml.referenceId, matches, checkedAt: iso(aml.checkedAt) };
}

export const fullName = (u: Pick<User, 'firstName' | 'lastName'>) => `${u.firstName} ${u.lastName}`.trim();

/**
 * Presentador con caché de búsquedas (nombres de clientes, beneficiarios) para listas grandes.
 * Se crea uno por petición.
 */
export class AdminPresenter {
  private readonly users = new Map<string, User | null>();
  private readonly bens = new Map<string, Beneficiary | null>();
  private alertTxnIds: Promise<Set<string>> | null = null;

  constructor(
    private readonly d: ServiceDeps,
    readonly opts: PresentOpts,
  ) {}

  async user(id: string): Promise<User | null> {
    if (!this.users.has(id)) this.users.set(id, await this.d.repos.users.byId(id));
    return this.users.get(id) ?? null;
  }

  private async beneficiary(id: string): Promise<Beneficiary | null> {
    if (!this.bens.has(id)) this.bens.set(id, await this.d.repos.beneficiaries.byId(id));
    return this.bens.get(id) ?? null;
  }

  async customerName(id: string): Promise<string | null> {
    const u = await this.user(id);
    return u ? fullName(u) : null;
  }

  phone(p: string) {
    return this.opts.pii ? p : maskPhone(p);
  }
  email(e: string) {
    return this.opts.pii ? e : maskEmail(e);
  }
  doc(d: string | null) {
    return d === null ? null : this.opts.pii ? d : maskDoc(d);
  }
  alias(a: string) {
    return this.opts.pii ? a : maskAlias(a);
  }

  private async alerted(txnId: string): Promise<boolean> {
    this.alertTxnIds ??= this.d.repos.alerts
      .list()
      .then((all) => new Set(all.map((a) => a.transactionId).filter((x): x is string => Boolean(x))));
    return (await this.alertTxnIds).has(txnId);
  }

  async transaction(t: Transaction) {
    let counterparty: string | null = null;
    if (t.type === 'transfer') {
      const b = t.beneficiaryId ? await this.beneficiary(t.beneficiaryId) : null;
      counterparty = b ? `${b.holderName} · ${this.alias(b.alias)}` : t.title;
    } else if (t.type === 'deposit') {
      counterparty = t.title;
    } else if (t.type === 'conversion') {
      counterparty = 'Proveedor de liquidez BRL';
    } else {
      counterparty = t.subtitle ? `${t.title} · ${t.subtitle}` : t.title;
    }
    return {
      id: t.id,
      customerId: t.userId,
      customerName: await this.customerName(t.userId),
      type: t.type,
      direction: t.direction,
      currency: t.currency,
      amountMinor: n(t.amountMinor),
      feeMinor: n(t.feeMinor),
      status: t.status,
      counterparty,
      conversion: t.conversion
        ? {
            fromCurrency: t.conversion.fromCurrency,
            fromAmountMinor: n(t.conversion.fromAmountMinor),
            toCurrency: t.conversion.toCurrency,
            toAmountMinor: n(t.conversion.toAmountMinor),
            rate: rateToNumber(t.conversion.rateScaled),
          }
        : null,
      flagged: t.flagged || (await this.alerted(t.id)),
      failureReason: t.failureReason,
      createdAt: iso(t.createdAt),
      updatedAt: iso(t.updatedAt),
    };
  }

  async beneficiaryJson(b: Beneficiary, aml?: AmlCheck | null) {
    const check = aml === undefined ? await this.d.repos.aml.byId(b.amlCheckId) : aml;
    return {
      id: b.id,
      customerId: b.userId,
      customerName: await this.customerName(b.userId),
      alias: this.alias(b.alias),
      holderName: b.holderName,
      documentType: b.documentType,
      documentNumber: this.doc(b.documentNumber),
      nickname: b.nickname,
      bankName: b.bankName,
      status: b.status,
      aml: presentAml(check),
      deleted: Boolean(b.deletedAt),
      createdAt: iso(b.createdAt),
    };
  }

  async alert(a: ComplianceAlert) {
    return presentAlert(a, await this.customerName(a.customerId));
  }

  /** AdminCustomerSummary */
  async customerSummary(u: User, control?: CustomerControl | null) {
    const ctl = control === undefined ? await this.d.repos.customerControls.get(u.id) : control;
    const wallets = await Promise.all(
      (['COP', 'BRL'] as const).map(async (c) => {
        const now = this.d.clock.now();
        const a = await this.d.repos.ledger.getOrCreateAccount('user_available', u.id, c, now);
        const h = await this.d.repos.ledger.getOrCreateAccount('user_held', u.id, c, now);
        return [c, (await this.d.repos.ledger.balance(a.id)) + (await this.d.repos.ledger.balance(h.id))] as const;
      }),
    );
    const alerts = (await this.d.repos.alerts.list()).filter((a) => a.customerId === u.id && a.status === 'open');
    const status = ctl?.status ?? 'active';
    const riskLevel = status === 'frozen' || alerts.some((a) => a.severity === 'high') ? 'high' : alerts.length ? 'medium' : 'low';
    const devices = await this.d.repos.devices.listByUser(u.id);
    const lastDevice = devices.map((x) => x.lastUsedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const lastTxn = (await this.d.repos.transactions.listByUser(u.id, { limit: 1 }))[0]?.createdAt.getTime() ?? 0;
    const lastActive = Math.max(lastDevice, lastTxn);
    return {
      id: u.id,
      firstName: u.firstName,
      lastName: u.lastName,
      email: this.email(u.email),
      phone: this.phone(u.phone),
      country: u.country,
      kycStatus: u.kycStatus,
      tier: u.tier,
      status,
      riskLevel,
      balances: Object.fromEntries(wallets.map(([c, v]) => [c, n(v)])) as Record<'COP' | 'BRL', number>,
      createdAt: iso(u.createdAt),
      lastActiveAt: lastActive ? new Date(lastActive).toISOString() : null,
    };
  }
}
