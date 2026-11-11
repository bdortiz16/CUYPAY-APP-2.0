import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { newId } from '../lib/clock.js';
import type {
  AmlCheck,
  Beneficiary,
  BrebKey,
  BrebResolution,
  Card,
  Challenge,
  Currency,
  Device,
  IdempotencyRecord,
  KycApplicant,
  LedgerAccount,
  LedgerAccountKind,
  LedgerEntry,
  LimitOperation,
  LimitUsage,
  Loan,
  LoanConfig,
  Otp,
  ProcessedDeposit,
  PromissoryNote,
  Quote,
  RefreshToken,
  SavingsBlock,
  SavingsConfig,
  Transaction,
  User,
} from '../domain/types.js';
import type {
  AdminSession,
  AdminUser,
  AuditEntry,
  ComplianceAlert,
  CustomerControl,
  CustomerNote,
  ReconciliationRun,
  SettingRecord,
} from '../domain/admin.js';
import type { Repositories } from './types.js';

/**
 * Implementación en memoria (fase 1 / dev / tests). Persiste en STORE_PATH cuando está activo.
 * Se devuelven copias superficiales/profundas para que los servicios no muten el estado
 * sin pasar por `update`.
 */
const clone = <T extends object>(v: T): T => ({ ...v });

export function createMemoryRepositories(): Repositories {
  const users = new Map<string, User>();
  const devices = new Map<string, Device>();
  const otps = new Map<string, Otp>();
  const challenges = new Map<string, Challenge>();
  const refresh = new Map<string, RefreshToken>();
  const nonces = new Map<string, Date>();
  const kyc = new Map<string, KycApplicant>();
  const brebKeys = new Map<string, BrebKey>();
  const cards = new Map<string, Card>();
  const resolutions = new Map<string, BrebResolution>();
  const beneficiaries = new Map<string, Beneficiary>();
  const aml = new Map<string, AmlCheck>();
  const ledgerAccounts = new Map<string, LedgerAccount>();
  const ledgerEntries: LedgerEntry[] = [];
  const balances = new Map<string, bigint>();
  const txns = new Map<string, Transaction>();
  const quotes = new Map<string, Quote>();
  const idem = new Map<string, IdempotencyRecord>();
  const usage: LimitUsage[] = [];
  const processed = new Map<string, ProcessedDeposit>();
  const adminUsers = new Map<string, AdminUser>();
  const adminSessions = new Map<string, AdminSession>();
  const audit: AuditEntry[] = [];
  const alerts = new Map<string, ComplianceAlert>();
  const notes: CustomerNote[] = [];
  const controls = new Map<string, CustomerControl>();
  const recons: ReconciliationRun[] = [];
  const settings = new Map<string, SettingRecord>();
  const savingsBlocks = new Map<string, SavingsBlock>();
  let savingsConfig: SavingsConfig = {
    rates: [
      { termDays: 30, ratePercent: 3.0, enabled: true },
      { termDays: 60, ratePercent: 4.5, enabled: true },
      { termDays: 90, ratePercent: 6.0, enabled: true },
      { termDays: 180, ratePercent: 8.5, enabled: true },
      { termDays: 360, ratePercent: 11.5, enabled: true },
    ],
    minAmountMinor: 50_000_00n, // $50,000 COP
    maxAmountMinor: 50_000_000_00n, // $50,000,000 COP
    contractTerms: `# Contrato Virtual de Bolsillo de Ahorro a Plazo Fijo\n\n**Entidad:** XATECH SERVICES S.A.S. (CuyPay) — NIT 901.799.579\n**Producto:** Bolsillo de Ahorro Programado con Rendimiento Fijo Garantizado (30, 60, 90, 180 o 360 días)\n\n1. **Constitución e Inmovilización:** El Cliente instruye y autoriza expresamente a CuyPay a debitar el capital seleccionado de su billetera COP disponible y trasladarlo al Bolsillo de Recaudo de Ahorros durante el plazo elegido (30, 60, 90, 180 o 360 días calendario).\n2. **Tasa Fija Garantizada:** La tasa de rendimiento Efectivo Anual (% E.A.) pactada al momento de constituir el bolsillo queda congelada e inalterable durante toda la vigencia del plazo.\n3. **Reserva Previa de 72 Horas y Reintegro en Hora Exacta:** Faltando setenta y dos (72) horas para el cumplimiento del plazo, la tesorería de CuyPay bloquea en reserva dedicada el 100% del capital más los intereses causados, acreditándolos de manera automática e inmediata en la billetera principal del Cliente en el día y la hora exacta de vencimiento.\n4. **Sin cobro de 4x1000 ni cuotas ocultas:** La constitución y la liquidación del Bolsillo de Ahorro dentro de CuyPay no causan comisiones administrativas.`,
    updatedAt: new Date(),
    updatedBy: 'system',
  };
  const loans = new Map<string, Loan>();
  const promissoryNotes = new Map<string, PromissoryNote>();
  let promissorySeq = 100;
  let loanConfig: LoanConfig = {
    enabled: true,
    rates: [
      { termDays: 30, rateEaPercent: 18.5, enabled: true },
      { termDays: 60, rateEaPercent: 19.5, enabled: true },
      { termDays: 90, rateEaPercent: 20.5, enabled: true },
      { termDays: 180, rateEaPercent: 22.0, enabled: true },
      { termDays: 360, rateEaPercent: 23.5, enabled: true },
    ],
    usuryCeilingEaPercent: 25.5,
    moratoryRateEaPercent: 25.5,
    minAmountMinor: 100_000_00n, // $100,000 COP
    maxAmountMinor: 20_000_000_00n, // $20,000,000 COP
    creditorLegalName: 'XATECH SERVICES S.A.S.',
    creditorNit: '901.799.579',
    creditorDomicile: 'Bogotá D.C., República de Colombia',
    updatedAt: new Date(),
    updatedBy: 'system',
  };

  const byCreatedDesc = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  // Copia profunda simple para objetos con arrays / JSON anidado (Date se preserva con structuredClone).
  const deep = <T,>(v: T): T => structuredClone(v);

  const find = <T>(m: Map<string, T>, pred: (v: T) => boolean): T | null => {
    for (const v of m.values()) if (pred(v)) return v;
    return null;
  };
  const opt = <T extends object>(v: T | null | undefined): T | null => (v ? clone(v) : null);

  const STORE_PATH = process.env.STORE_PATH || (process.env.NODE_ENV === 'test' ? null : '/tmp/cuypay_store.json');

  const save = () => {
    if (!STORE_PATH) return;
    try {
      const data = {
        users: Array.from(users.entries()),
        devices: Array.from(devices.entries()),
        otps: Array.from(otps.entries()),
        kyc: Array.from(kyc.entries()),
        brebKeys: Array.from(brebKeys.entries()),
        cards: Array.from(cards.entries()),
        beneficiaries: Array.from(beneficiaries.entries()),
        ledgerAccounts: Array.from(ledgerAccounts.entries()),
        ledgerEntries: ledgerEntries.map(clone),
        balances: Array.from(balances.entries()).map(([k, v]) => [k, v.toString() + 'n']),
        txns: Array.from(txns.entries()),
        processedDeposits: Array.from(processed.entries()),
        adminUsers: Array.from(adminUsers.entries()),
        refreshTokens: Array.from(refresh.entries()),
        audit: audit.slice(-1000),
        savingsBlocks: Array.from(savingsBlocks.entries()),
        savingsConfig,
        loans: Array.from(loans.entries()),
        promissoryNotes: Array.from(promissoryNotes.entries()),
        promissorySeq,
        loanConfig,
      };
      writeFileSync(
        STORE_PATH,
        JSON.stringify(data, (_key, val) => (typeof val === 'bigint' ? val.toString() + 'n' : val), 2)
      );
    } catch (err) {
      console.error('Failed to save store to STORE_PATH:', err);
    }
  };

  const load = () => {
    if (!STORE_PATH || !existsSync(STORE_PATH)) return;
    try {
      const text = readFileSync(STORE_PATH, 'utf8');
      const data = JSON.parse(text, (_k, v) => {
        if (typeof v === 'string') {
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return new Date(v);
          if (/^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
        }
        return v;
      });
      if (data.users) for (const [k, v] of data.users) users.set(k, v);
      if (data.devices) for (const [k, v] of data.devices) devices.set(k, v);
      if (data.otps) for (const [k, v] of data.otps) otps.set(k, v);
      if (data.kyc) for (const [k, v] of data.kyc) kyc.set(k, v);
      if (data.brebKeys) for (const [k, v] of data.brebKeys) brebKeys.set(k, v);
      if (data.cards) for (const [k, v] of data.cards) cards.set(k, v);
      if (data.beneficiaries) for (const [k, v] of data.beneficiaries) beneficiaries.set(k, v);
      if (data.ledgerAccounts) for (const [k, v] of data.ledgerAccounts) ledgerAccounts.set(k, v);
      if (data.ledgerEntries) for (const e of data.ledgerEntries) ledgerEntries.push(e);
      if (data.balances) for (const [k, v] of data.balances) balances.set(k, v);
      if (data.txns) for (const [k, v] of data.txns) txns.set(k, v);
      if (data.processedDeposits) for (const [k, v] of data.processedDeposits) processed.set(k, v);
      if (data.adminUsers) for (const [k, v] of data.adminUsers) adminUsers.set(k, v);
      if (data.refreshTokens) for (const [k, v] of data.refreshTokens) refresh.set(k, v);
      if (data.audit) for (const e of data.audit) audit.push(e);
      if (data.savingsBlocks) for (const [k, v] of data.savingsBlocks) savingsBlocks.set(k, v);
      if (data.savingsConfig) savingsConfig = { ...savingsConfig, ...data.savingsConfig };
      if (data.loans) for (const [k, v] of data.loans) loans.set(k, v);
      if (data.promissoryNotes) for (const [k, v] of data.promissoryNotes) promissoryNotes.set(k, v);
      if (typeof data.promissorySeq === 'number') promissorySeq = data.promissorySeq;
      if (data.loanConfig) loanConfig = { ...loanConfig, ...data.loanConfig };
    } catch {
      // ignore
    }
  };
  load();

  return {
    users: {
      async create(u) {
        users.set(u.id, clone(u));
        save();
      },
      async update(u) {
        users.set(u.id, clone(u));
        save();
      },
      async byId(id) {
        return opt(users.get(id));
      },
      async byPhone(phone) {
        return opt(find(users, (u) => u.phone === phone));
      },
      async byEmail(email) {
        return opt(find(users, (u) => u.email.toLowerCase() === email.toLowerCase()));
      },
      async listAll() {
        return [...users.values()].sort(byCreatedDesc).map(clone);
      },
    },
    devices: {
      async create(d) {
        devices.set(d.id, clone(d));
        save();
      },
      async update(d) {
        devices.set(d.id, clone(d));
        save();
      },
      async byId(id) {
        return opt(devices.get(id));
      },
      async listByUser(userId) {
        return [...devices.values()].filter((d) => d.userId === userId).map(clone);
      },
    },
    otps: {
      async create(o) {
        otps.set(o.id, clone(o));
        save();
      },
      async update(o) {
        otps.set(o.id, clone(o));
        save();
      },
      async byId(id) {
        return opt(otps.get(id));
      },
    },
    challenges: {
      async create(c) {
        challenges.set(c.id, clone(c));
      },
      async consume(id, at) {
        const c = challenges.get(id);
        if (!c || c.consumedAt) return null;
        c.consumedAt = at;
        return clone(c);
      },
    },
    refreshTokens: {
      async create(t) {
        refresh.set(t.id, clone(t));
        save();
      },
      async byHash(hash) {
        return opt(find(refresh, (t) => t.tokenHash === hash));
      },
      async markUsed(id, at) {
        const t = refresh.get(id);
        if (!t || t.usedAt) return false;
        t.usedAt = at;
        save();
        return true;
      },
      async revokeFamily(familyId, at) {
        for (const t of refresh.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = at;
        save();
      },
      async revokeByDevice(deviceId, at) {
        for (const t of refresh.values()) if (t.deviceId === deviceId && !t.revokedAt) t.revokedAt = at;
        save();
      },
    },
    nonces: {
      async register(deviceId, nonce, expiresAt, now) {
        // Limpieza oportunista de nonces vencidos.
        if (nonces.size > 10_000) for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k);
        const k = `${deviceId}:${nonce}`;
        const exp = nonces.get(k);
        if (exp && exp > now) return false;
        nonces.set(k, expiresAt);
        return true;
      },
    },
    kyc: {
      async upsert(k) {
        kyc.set(k.userId, { ...k, rejectLabels: [...k.rejectLabels] });
        save();
      },
      async byUser(userId) {
        return opt(kyc.get(userId));
      },
      async byApplicantId(applicantId) {
        return opt(find(kyc, (k) => k.applicantId === applicantId));
      },
    },
    brebKeys: {
      async create(k) {
        brebKeys.set(k.id, clone(k));
        save();
      },
      async update(k) {
        brebKeys.set(k.id, clone(k));
        save();
      },
      async delete(id) {
        brebKeys.delete(id);
        save();
      },
      async byUser(userId) {
        return (
          opt(find(brebKeys, (k) => k.userId === userId && k.status === 'active')) ??
          opt(find(brebKeys, (k) => k.userId === userId && k.status !== 'replaced'))
        );
      },
      async listByUser(userId) {
        return [...brebKeys.values()].filter((k) => k.userId === userId).map(clone);
      },
      async listActive() {
        return [...brebKeys.values()].filter((k) => k.status === 'active').map(clone);
      },
      async byProviderKeyId(pid) {
        return opt(find(brebKeys, (k) => k.providerKeyId === pid));
      },
      async byAlias(alias) {
        const target = alias.trim().toLowerCase();
        return opt(find(brebKeys, (k) => k.status !== 'replaced' && k.alias.toLowerCase() === target));
      },
      async byId(id) {
        return opt(brebKeys.get(id));
      },
    },
    cards: {
      async create(c) {
        cards.set(c.id, clone(c));
        save();
      },
      async update(c) {
        cards.set(c.id, clone(c));
        save();
      },
      async byId(id) {
        return opt(cards.get(id));
      },
      async listByUser(userId) {
        return [...cards.values()].filter((c) => c.userId === userId).map(clone);
      },
      async byProviderCardId(pid) {
        return opt(find(cards, (c) => c.providerCardId === pid));
      },
    },
    resolutions: {
      async create(r) {
        resolutions.set(r.id, clone(r));
      },
      async byId(id) {
        return opt(resolutions.get(id));
      },
    },
    beneficiaries: {
      async create(b) {
        beneficiaries.set(b.id, clone(b));
      },
      async update(b) {
        beneficiaries.set(b.id, clone(b));
      },
      async byId(id) {
        return opt(beneficiaries.get(id));
      },
      async listByUser(userId) {
        return [...beneficiaries.values()]
          .filter((b) => b.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(clone);
      },
      async listAll() {
        return [...beneficiaries.values()].sort(byCreatedDesc).map(clone);
      },
    },
    aml: {
      async create(c) {
        aml.set(c.id, clone(c));
      },
      async byId(id) {
        return opt(aml.get(id));
      },
    },
    ledger: {
      async getOrCreateAccount(kind: LedgerAccountKind, userId: string | null, currency: Currency, now: Date) {
        const existing = find(ledgerAccounts, (a) => a.kind === kind && a.userId === userId && a.currency === currency);
        if (existing) return clone(existing);
        const acc: LedgerAccount = { id: newId('lac', now), kind, userId, currency, createdAt: now };
        ledgerAccounts.set(acc.id, acc);
        save();
        return clone(acc);
      },
      async insertEntries(entries) {
        for (const e of entries) {
          ledgerEntries.push(clone(e));
          balances.set(e.accountId, (balances.get(e.accountId) ?? 0n) + e.amountMinor);
        }
        save();
      },
      async balance(accountId) {
        return balances.get(accountId) ?? 0n;
      },
      async allEntries() {
        return ledgerEntries.map(clone);
      },
      async entriesByTransaction(transactionId) {
        return ledgerEntries.filter((e) => e.transactionId === transactionId).map(clone);
      },
      async accounts() {
        return [...ledgerAccounts.values()].map(clone);
      },
    },
    transactions: {
      async create(t) {
        txns.set(t.id, { ...t, conversion: t.conversion ? { ...t.conversion } : null });
        save();
      },
      async update(t) {
        txns.set(t.id, { ...t, conversion: t.conversion ? { ...t.conversion } : null });
        save();
      },
      async byId(id) {
        return opt(txns.get(id));
      },
      async listByUser(userId, { currency, limit, after }) {
        return [...txns.values()]
          .filter((t) => t.userId === userId)
          .filter((t) => !currency || t.currency === currency || t.conversion?.toCurrency === currency)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .filter((t) => {
            if (!after) return true;
            const dt = t.createdAt.getTime() - after.createdAt.getTime();
            return dt < 0 || (dt === 0 && t.id < after.id);
          })
          .slice(0, limit)
          .map(clone);
      },
      async listPendingTransfers() {
        return [...txns.values()].filter((t) => t.type === 'transfer' && t.status === 'pending').map(clone);
      },
      async listAll() {
        return [...txns.values()].sort(byCreatedDesc).map(clone);
      },
    },
    quotes: {
      async create(q) {
        quotes.set(q.id, clone(q));
      },
      async update(q) {
        quotes.set(q.id, clone(q));
      },
      async byId(id) {
        return opt(quotes.get(id));
      },
    },
    idempotency: {
      async get(userId, scope, key) {
        return opt(idem.get(`${userId}|${scope}|${key}`));
      },
      async tryInsert(r) {
        const k = `${r.userId}|${r.scope}|${r.key}`;
        if (idem.has(k)) return false;
        idem.set(k, clone(r));
        return true;
      },
      async complete(userId, scope, key, status, body) {
        const r = idem.get(`${userId}|${scope}|${key}`);
        if (r) {
          r.status = 'completed';
          r.responseStatus = status;
          r.responseBody = body;
        }
      },
      async remove(userId, scope, key) {
        idem.delete(`${userId}|${scope}|${key}`);
      },
    },
    limitUsage: {
      async add(u) {
        usage.push(clone(u));
      },
      async voidByTransaction(transactionId, at) {
        for (const u of usage) if (u.transactionId === transactionId && !u.voidedAt) u.voidedAt = at;
      },
      async sum(userId: string, operation: LimitOperation, from: Date, to: Date) {
        let total = 0n;
        for (const u of usage) {
          if (u.userId !== userId || u.operation !== operation || u.voidedAt) continue;
          if (u.occurredAt >= from && u.occurredAt < to) total += u.amountMinor;
        }
        return total;
      },
    },
    processedDeposits: {
      async tryInsert(d) {
        if (processed.has(d.providerDepositId)) {
          const existing = processed.get(d.providerDepositId);
          if (existing && !existing.transactionId && d.transactionId) {
            processed.set(d.providerDepositId, clone(d));
            save();
            return true;
          }
          return false;
        }
        processed.set(d.providerDepositId, clone(d));
        save();
        return true;
      },
      async get(id) {
        return opt(processed.get(id));
      },
    },
    adminUsers: {
      async create(a) {
        adminUsers.set(a.id, clone(a));
      },
      async update(a) {
        adminUsers.set(a.id, clone(a));
      },
      async byId(id) {
        return opt(adminUsers.get(id));
      },
      async byEmail(email) {
        return opt(find(adminUsers, (a) => a.email === email.toLowerCase()));
      },
      async list() {
        return [...adminUsers.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
      },
    },
    adminSessions: {
      async create(s) {
        adminSessions.set(s.id, clone(s));
      },
      async byId(id) {
        return opt(adminSessions.get(id));
      },
      async revoke(id, at) {
        const s = adminSessions.get(id);
        if (s && !s.revokedAt) s.revokedAt = at;
      },
      async revokeByAdmin(adminId, at) {
        for (const s of adminSessions.values()) if (s.adminId === adminId && !s.revokedAt) s.revokedAt = at;
      },
    },
    audit: {
      async append(e) {
        audit.push(deep(e));
      },
      async list() {
        return audit
          .map(deep)
          .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      },
    },
    alerts: {
      async create(a) {
        alerts.set(a.id, clone(a));
      },
      async update(a) {
        alerts.set(a.id, clone(a));
      },
      async byId(id) {
        return opt(alerts.get(id));
      },
      async list() {
        return [...alerts.values()].sort(byCreatedDesc).map(clone);
      },
    },
    notes: {
      async create(n) {
        notes.push(clone(n));
      },
      async listByUser(userId) {
        return notes.filter((n) => n.userId === userId).sort(byCreatedDesc).map(clone);
      },
    },
    customerControls: {
      async get(userId) {
        const c = controls.get(userId);
        return c ? deep(c) : null;
      },
      async upsert(c) {
        controls.set(c.userId, deep(c));
      },
    },
    reconciliations: {
      async create(r) {
        recons.push(deep(r));
      },
      async update(r) {
        const i = recons.findIndex((x) => x.id === r.id);
        if (i >= 0) recons[i] = deep(r);
      },
      async latest() {
        const r = recons[recons.length - 1];
        return r ? deep(r) : null;
      },
    },
    settings: {
      async get<T>(key: string) {
        const r = settings.get(key);
        return r ? (deep(r) as SettingRecord<T>) : null;
      },
      async set(rec) {
        settings.set(rec.key, deep(rec));
      },
    },
    savingsBlocks: {
      async create(b) {
        savingsBlocks.set(b.id, deep(b));
        save();
      },
      async update(b) {
        savingsBlocks.set(b.id, deep(b));
        save();
      },
      async byId(id) {
        const b = savingsBlocks.get(id);
        return b ? deep(b) : null;
      },
      async listByUser(userId) {
        return [...savingsBlocks.values()]
          .filter((b) => b.userId === userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(deep);
      },
      async listAll() {
        return [...savingsBlocks.values()]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map(deep);
      },
      async findMaturing(withinMs, now) {
        return [...savingsBlocks.values()]
          .filter(
            (b) =>
              b.status === 'active' &&
              b.maturesAt.getTime() - now.getTime() <= withinMs,
          )
          .sort((a, b) => a.maturesAt.getTime() - b.maturesAt.getTime())
          .map(deep);
      },
    },
    savingsConfig: {
      async get() {
        return deep(savingsConfig);
      },
      async set(cfg) {
        savingsConfig = deep(cfg);
        save();
      },
    },
    loans: {
      async create(l) {
        loans.set(l.id, deep(l));
        save();
      },
      async update(l) {
        loans.set(l.id, deep(l));
        save();
      },
      async byId(id) {
        const l = loans.get(id);
        return l ? deep(l) : null;
      },
      async listByUser(userId) {
        return [...loans.values()]
          .filter((l) => l.userId === userId)
          .sort(byCreatedDesc)
          .map(deep);
      },
      async listAll() {
        return [...loans.values()].sort(byCreatedDesc).map(deep);
      },
    },
    loanConfig: {
      async get() {
        return deep(loanConfig);
      },
      async set(cfg) {
        loanConfig = deep(cfg);
        save();
      },
    },
    promissoryNotes: {
      async create(p) {
        promissoryNotes.set(p.id, deep(p));
        save();
      },
      async update(p) {
        promissoryNotes.set(p.id, deep(p));
        save();
      },
      async byId(id) {
        const p = promissoryNotes.get(id);
        return p ? deep(p) : null;
      },
      async byLoanId(loanId) {
        const p = find(promissoryNotes, (n) => n.loanId === loanId);
        return p ? deep(p) : null;
      },
      async listByUser(userId) {
        return [...promissoryNotes.values()]
          .filter((p) => p.userId === userId)
          .sort(byCreatedDesc)
          .map(deep);
      },
      async listAll() {
        return [...promissoryNotes.values()].sort(byCreatedDesc).map(deep);
      },
      async nextSequence() {
        promissorySeq += 1;
        save();
        return promissorySeq;
      },
    },
  };
}

