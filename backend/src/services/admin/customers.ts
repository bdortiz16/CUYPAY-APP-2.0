import type { LimitRule } from '../../config.js';
import type { Tier, User } from '../../domain/types.js';
import { newId } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { presentLimits } from '../../domain/presenters.js';
import type { KeyedMutex, ServiceDeps } from '../deps.js';
import type { DeviceService } from '../feed.js';
import type { LedgerService } from '../ledger.js';
import type { LimitsService } from '../limits.js';
import { getCustomerControl } from '../runtime-config.js';
import type { AdminContext, AuditService } from './audit.js';
import { paginate } from './paginate.js';
import type { AdminPresenter } from './presenters.js';

export interface CustomerFilters {
  query?: string;
  kycStatus?: User['kycStatus'];
  tier?: Tier;
  status?: 'active' | 'frozen';
  limit: number;
  cursor?: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Clientes en el portal admin: búsqueda, ficha, congelar, nivel, overrides, dispositivos, notas. */
export class AdminCustomerService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly devices: DeviceService,
    private readonly mutex: KeyedMutex,
  ) {}

  private async getUser(id: string): Promise<User> {
    const u = await this.d.repos.users.byId(id);
    if (!u) throw new AppError('NOT_FOUND', 'Cliente no encontrado');
    return u;
  }

  async list(f: CustomerFilters, p: AdminPresenter) {
    const users = await this.d.repos.users.listAll();
    const q = f.query ? norm(f.query.trim()) : '';
    const qDigits = f.query?.replace(/\D/g, '') ?? '';
    const out: User[] = [];
    for (const u of users) {
      if (f.kycStatus && u.kycStatus !== f.kycStatus) continue;
      if (f.tier && u.tier !== f.tier) continue;
      if (f.status) {
        const st = (await this.d.repos.customerControls.get(u.id))?.status ?? 'active';
        if (st !== f.status) continue;
      }
      if (q) {
        const key = await this.d.repos.brebKeys.byUser(u.id);
        const hay = [norm(`${u.firstName} ${u.lastName}`), u.email.toLowerCase(), u.id.toLowerCase(), key ? key.alias.toLowerCase() : ''];
        const phoneHit = qDigits.length >= 4 && u.phone.replace(/\D/g, '').includes(qDigits);
        if (!phoneHit && !hay.some((h) => h.includes(q))) continue;
      }
      out.push(u);
    }
    const { page, nextCursor } = paginate(out, (u) => ({ at: u.createdAt, id: u.id }), f.limit, f.cursor);
    return { items: await Promise.all(page.map((u) => p.customerSummary(u))), nextCursor };
  }

  async detail(id: string, p: AdminPresenter) {
    const u = await this.getUser(id);
    const control = await this.d.repos.customerControls.get(id);
    const summary = await p.customerSummary(u, control);
    const kyc = await this.d.repos.kyc.byUser(id);
    const key = await this.d.repos.brebKeys.byUser(id);
    const bens = (await this.d.repos.beneficiaries.listByUser(id)).filter((b) => !b.deletedAt);
    const txns = await this.d.repos.transactions.listByUser(id, { limit: 20 });
    const notes = await this.d.repos.notes.listByUser(id);
    const devices = (await this.d.repos.devices.listByUser(id)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      ...summary,
      // TODO(kyc): sincronizar tipo/número de documento desde Sumsub (applicant info) al aprobar el KYC.
      documentType: null as string | null,
      documentNumber: null as string | null,
      frozenAt: control?.frozenAt?.toISOString() ?? null,
      frozenReason: control?.frozenReason ?? null,
      kyc: kyc
        ? {
            provider: kyc.provider,
            applicantId: kyc.applicantId,
            levelName: kyc.levelName,
            status: kyc.status,
            reviewAnswer: kyc.reviewAnswer,
            rejectLabels: kyc.rejectLabels,
            rejectType: kyc.rejectType,
            updatedAt: kyc.updatedAt.toISOString(),
          }
        : null,
      wallets: (await this.ledger.wallets(id)).map((w) => ({
        currency: w.currency,
        balanceMinor: Number(w.balanceMinor),
        availableMinor: Number(w.availableMinor),
        heldMinor: Number(w.heldMinor),
      })),
      brebKey: key ? { alias: p.alias(key.alias), status: key.status, createdAt: key.createdAt.toISOString() } : null,
      limits: presentLimits(await this.limits.snapshot(u)),
      limitOverrides: control?.limitOverrides ?? [],
      devices: devices.map((x) => ({
        id: x.id,
        name: x.name,
        createdAt: x.createdAt.toISOString(),
        lastUsedAt: x.lastUsedAt?.toISOString() ?? null,
        revoked: Boolean(x.revokedAt),
        revokedAt: x.revokedAt?.toISOString() ?? null,
      })),
      beneficiaries: await Promise.all(bens.map((b) => p.beneficiaryJson(b))),
      recentTransactions: await Promise.all(txns.map((t) => p.transaction(t))),
      notes: notes.map((x) => ({ id: x.id, author: x.authorEmail, authorId: x.authorId, text: x.text, createdAt: x.createdAt.toISOString() })),
    };
  }

  async freeze(ctx: AdminContext, id: string, reason: string) {
    await this.getUser(id);
    return this.mutex.run(id, async () => {
      const c = await getCustomerControl(this.d, id);
      if (c.status === 'frozen') throw new AppError('CONFLICT', 'El cliente ya está congelado');
      const before = { status: c.status };
      const now = this.d.clock.now();
      c.status = 'frozen';
      c.frozenAt = now;
      c.frozenReason = reason;
      c.updatedAt = now;
      await this.d.repos.customerControls.upsert(c);
      await this.audit.record(ctx, { action: 'customer.freeze', targetType: 'customer', targetId: id, reason, before, after: { status: 'frozen' } });
      await this.d.events.publish({ type: 'customer.updated', userId: id });
      return { status: 'frozen' as const };
    });
  }

  async unfreeze(ctx: AdminContext, id: string, reason: string) {
    await this.getUser(id);
    return this.mutex.run(id, async () => {
      const c = await getCustomerControl(this.d, id);
      if (c.status !== 'frozen') throw new AppError('CONFLICT', 'El cliente no está congelado');
      // Libera los depósitos que entraron mientras estaba congelado.
      let releasedMinor = 0n;
      for (const txnId of c.heldDepositTxnIds) {
        const t = await this.d.repos.transactions.byId(txnId);
        if (!t || t.status !== 'completed') continue;
        await this.ledger.releaseHold(id, t.currency, t.amountMinor, t.id);
        releasedMinor += t.amountMinor;
      }
      const before = { status: c.status, frozenAt: c.frozenAt, frozenReason: c.frozenReason, heldDeposits: c.heldDepositTxnIds.length };
      c.status = 'active';
      c.frozenAt = null;
      c.frozenReason = null;
      c.heldDepositTxnIds = [];
      c.updatedAt = this.d.clock.now();
      await this.d.repos.customerControls.upsert(c);
      await this.audit.record(ctx, {
        action: 'customer.unfreeze',
        targetType: 'customer',
        targetId: id,
        reason,
        before,
        after: { status: 'active', releasedHeldMinor: Number(releasedMinor) },
      });
      await this.d.events.publish({ type: 'customer.updated', userId: id });
      return { status: 'active' as const, releasedHeldMinor: Number(releasedMinor) };
    });
  }

  async setTier(ctx: AdminContext, id: string, tier: Tier, reason: string) {
    const u = await this.getUser(id);
    const before = { tier: u.tier };
    u.tier = tier;
    u.updatedAt = this.d.clock.now();
    await this.d.repos.users.update(u);
    await this.audit.record(ctx, { action: 'customer.tier', targetType: 'customer', targetId: id, reason, before, after: { tier } });
    await this.d.events.publish({ type: 'customer.updated', userId: id });
    return { tier };
  }

  async setLimitOverrides(ctx: AdminContext, id: string, items: LimitRule[], reason: string) {
    await this.getUser(id);
    const seen = new Set<string>();
    for (const i of items) {
      const k = `${i.operation}:${i.period}`;
      if (seen.has(k)) throw new AppError('VALIDATION_ERROR', `Override duplicado: ${k}`, { field: 'items' });
      seen.add(k);
    }
    const c = await getCustomerControl(this.d, id);
    const before = { limitOverrides: c.limitOverrides };
    c.limitOverrides = items;
    c.updatedAt = this.d.clock.now();
    await this.d.repos.customerControls.upsert(c);
    await this.audit.record(ctx, { action: 'customer.limit_overrides', targetType: 'customer', targetId: id, reason, before, after: { limitOverrides: items } });
    return { limitOverrides: items };
  }

  async revokeDevice(ctx: AdminContext, userId: string, deviceId: string, reason: string) {
    const dev = await this.d.repos.devices.byId(deviceId);
    if (!dev || dev.userId !== userId) throw new AppError('NOT_FOUND', 'Dispositivo no encontrado');
    await this.devices.revoke(userId, deviceId);
    await this.audit.record(ctx, {
      action: 'customer.device_revoke',
      targetType: 'device',
      targetId: deviceId,
      reason,
      before: { revoked: false, userId },
      after: { revoked: true, userId },
    });
  }

  async addNote(ctx: AdminContext, userId: string, text: string) {
    await this.getUser(userId);
    const now = this.d.clock.now();
    const note = { id: newId('nte', now), userId, authorId: ctx.admin.id, authorEmail: ctx.admin.email, text: text.trim(), createdAt: now };
    await this.d.repos.notes.create(note);
    await this.audit.record(ctx, { action: 'customer.note', targetType: 'customer', targetId: userId, reason: note.text, after: { noteId: note.id } });
    return { id: note.id, author: note.authorEmail, authorId: note.authorId, text: note.text, createdAt: now.toISOString() };
  }
}
