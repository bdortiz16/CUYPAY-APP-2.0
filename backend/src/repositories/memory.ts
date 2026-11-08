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
  Otp,
  ProcessedDeposit,
  Quote,
  RefreshToken,
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
 * Implementación en memoria (fase 1 / dev / tests). No persiste entre reinicios.
 * Se devuelven copias superficiales para que los servicios no muten el estado
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
  const byCreatedDesc = <T extends { createdAt: Date; id: string }>(a: T, b: T) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  // Copia profunda simple para objetos con arrays / JSON anidado (Date se preserva con structuredClone).
  const deep = <T,>(v: T): T => structuredClone(v);

  const find = <T>(m: Map<string, T>, pred: (v: T) => boolean): T | null => {
    for (const v of m.values()) if (pred(v)) return v;
    return null;
  };
  const opt = <T extends object>(v: T | null | undefined): T | null => (v ? clone(v) : null);

  return {
    users: {
      async create(u) {
        users.set(u.id, clone(u));
      },
      async update(u) {
        users.set(u.id, clone(u));
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
      },
      async update(d) {
        devices.set(d.id, clone(d));
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
      },
      async update(o) {
        otps.set(o.id, clone(o));
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
      },
      async byHash(hash) {
        return opt(find(refresh, (t) => t.tokenHash === hash));
      },
      async markUsed(id, at) {
        const t = refresh.get(id);
        if (!t || t.usedAt) return false;
        t.usedAt = at;
        return true;
      },
      async revokeFamily(familyId, at) {
        for (const t of refresh.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = at;
      },
      async revokeByDevice(deviceId, at) {
        for (const t of refresh.values()) if (t.deviceId === deviceId && !t.revokedAt) t.revokedAt = at;
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
      },
      async update(k) {
        brebKeys.set(k.id, clone(k));
      },
      async delete(id) {
        brebKeys.delete(id);
      },
      async byUser(userId) {
        return opt(find(brebKeys, (k) => k.userId === userId));
      },
      async listByUser(userId) {
        return [...brebKeys.values()].filter((k) => k.userId === userId).map(clone);
      },
      async byProviderKeyId(pid) {
        return opt(find(brebKeys, (k) => k.providerKeyId === pid));
      },
      async byAlias(alias) {
        return opt(find(brebKeys, (k) => k.alias === alias));
      },
      async byId(id) {
        return opt(brebKeys.get(id));
      },
    },
    cards: {
      async create(c) {
        cards.set(c.id, clone(c));
      },
      async update(c) {
        cards.set(c.id, clone(c));
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
        return clone(acc);
      },
      async insertEntries(entries) {
        for (const e of entries) {
          ledgerEntries.push(clone(e));
          balances.set(e.accountId, (balances.get(e.accountId) ?? 0n) + e.amountMinor);
        }
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
      },
      async update(t) {
        txns.set(t.id, { ...t, conversion: t.conversion ? { ...t.conversion } : null });
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
        if (processed.has(d.providerDepositId)) return false;
        processed.set(d.providerDepositId, clone(d));
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
  };
}
