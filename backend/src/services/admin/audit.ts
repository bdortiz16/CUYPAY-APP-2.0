import type { AdminUser, AuditEntry } from '../../domain/admin.js';
import { newId } from '../../lib/clock.js';
import type { ServiceDeps } from '../deps.js';

/** Contexto de la petición admin: quién, desde dónde. Se pasa a toda acción que modifica algo. */
export interface AdminContext {
  admin: AdminUser;
  ip: string | null;
  userAgent: string | null;
}

/** Convierte bigint/Date a JSON plano para before/after del audit log. */
export function toAuditJson(v: unknown): unknown {
  if (v === undefined) return null;
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}

/** Audit log inmutable (append-only). */
export class AuditService {
  constructor(private readonly d: ServiceDeps) {}

  async record(
    ctx: AdminContext,
    e: { action: string; targetType: string; targetId: string | null; reason: string | null; before?: unknown; after?: unknown },
  ): Promise<AuditEntry> {
    const now = this.d.clock.now();
    const entry: AuditEntry = {
      id: newId('aud', now),
      at: now,
      actor: { id: ctx.admin.id, email: ctx.admin.email, role: ctx.admin.role },
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      reason: e.reason,
      before: toAuditJson(e.before),
      after: toAuditJson(e.after),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };
    await this.d.repos.audit.append(entry);
    this.d.logger.info({ auditId: entry.id, action: e.action, actor: ctx.admin.id, targetType: e.targetType, targetId: e.targetId }, 'admin audit');
    return entry;
  }

  async query(f: { actorId?: string; action?: string; targetType?: string; targetId?: string }) {
    return (await this.d.repos.audit.list()).filter(
      (e) =>
        (!f.actorId || e.actor.id === f.actorId) &&
        (!f.action || e.action === f.action || (f.action.endsWith('*') && e.action.startsWith(f.action.slice(0, -1)))) &&
        (!f.targetType || e.targetType === f.targetType) &&
        (!f.targetId || e.targetId === f.targetId),
    );
  }
}
