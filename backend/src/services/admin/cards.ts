import type { Card, CardKind, CardPurpose, CardStatus } from '../../domain/types.js';
import { AppError } from '../../lib/errors.js';
import { cardKind, isCardExpired, type CardService } from '../cards.js';
import type { ServiceDeps } from '../deps.js';
import type { AdminContext, AuditService } from './audit.js';
import { paginate } from './paginate.js';
import type { AdminPresenter } from './presenters.js';

export interface AdminCardFilters {
  kind?: CardKind;
  status?: CardStatus | 'expired';
  purpose?: CardPurpose;
  customerId?: string;
  limit: number;
  cursor?: string;
}

/** Estado visible en el portal: una temporal vencida se muestra como 'expired' aunque el barrido aún no corra. */
const adminStatus = (c: Card, now: Date): CardStatus | 'expired' => {
  if (c.status === 'canceled') return c.canceledReason === 'expired' ? 'expired' : 'canceled';
  return isCardExpired(c, now) ? 'expired' : c.status;
};

/** Tarjetas virtuales (FIJAS y TEMPORALES) en el portal admin: listado, métricas y cancelación forzada. */
export class AdminCardService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
    private readonly cards: CardService,
  ) {}

  async present(c: Card, p: AdminPresenter) {
    const now = this.d.clock.now();
    return {
      id: c.id,
      customerId: c.userId,
      customerName: await p.customerName(c.userId),
      label: c.label,
      kind: cardKind(c),
      purpose: c.purpose ?? 'personal',
      status: adminStatus(c, now),
      lastFour: c.lastFour,
      brand: c.brand,
      currency: c.currency,
      providerCardId: c.providerCardId,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      canceledAt: c.canceledAt?.toISOString() ?? null,
      canceledReason: c.canceledReason ?? null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  async list(f: AdminCardFilters, p: AdminPresenter) {
    const now = this.d.clock.now();
    const all = (await this.d.repos.cards.listAll()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
    );
    const rows = all.filter((c) => {
      if (f.kind && cardKind(c) !== f.kind) return false;
      if (f.purpose && (c.purpose ?? 'personal') !== f.purpose) return false;
      if (f.customerId && c.userId !== f.customerId) return false;
      if (f.status && adminStatus(c, now) !== f.status) return false;
      return true;
    });
    const { page, nextCursor } = paginate(rows, (c) => ({ at: c.createdAt, id: c.id }), f.limit, f.cursor);

    const dayAgo = now.getTime() - 24 * 3_600_000;
    const live = all.filter((c) => c.status !== 'canceled' && !isCardExpired(c, now));
    const summary = {
      activeFixed: live.filter((c) => cardKind(c) === 'fixed').length,
      activeTemporary: live.filter((c) => cardKind(c) === 'temporary').length,
      expiredLast24h: all.filter((c) => c.canceledReason === 'expired' && (c.canceledAt?.getTime() ?? 0) >= dayAgo).length,
      issuedLast24h: all.filter((c) => c.createdAt.getTime() >= dayAgo).length,
      customersWithCards: new Set(live.map((c) => c.userId)).size,
    };
    return { items: await Promise.all(page.map((c) => this.present(c, p))), nextCursor, summary };
  }

  async listByCustomer(customerId: string, p: AdminPresenter) {
    const cards = (await this.d.repos.cards.listByUser(customerId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.all(cards.map((c) => this.present(c, p)));
  }

  async cancel(ctx: AdminContext, id: string, reason: string, p: AdminPresenter) {
    const existing = await this.d.repos.cards.byId(id);
    if (!existing) throw new AppError('NOT_FOUND', 'Tarjeta no encontrada');
    const { before, after } = await this.cards.adminCancel(id);
    await this.audit.record(ctx, {
      action: 'card.cancel',
      targetType: 'card',
      targetId: id,
      reason,
      before: { status: before.status, kind: cardKind(before), userId: before.userId },
      after: { status: after.status, canceledReason: after.canceledReason },
    });
    await this.d.events.publish({ type: 'customer.updated', userId: after.userId });
    return this.present(after, p);
  }
}
