import { createHash, randomBytes } from 'node:crypto';
import type { AdminUser } from '../../domain/admin.js';
import { AppError } from '../../lib/errors.js';
import type { ServiceDeps } from '../deps.js';
import type { DomainEvent } from '../events.js';
import { AdminPresenter } from './presenters.js';
import { can, type Permission } from './rbac.js';

export const STREAM_TOKEN_TTL_SECONDS = 60;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Permiso requerido para recibir cada tipo de evento por SSE. */
const EVENT_PERMISSION: Partial<Record<DomainEvent['type'], Permission>> = {
  'compliance.alert': 'compliance:read',
  'beneficiary.review_required': 'compliance:read',
  'treasury.updated': 'treasury:read',
};

/**
 * Tiempo real del portal: tokens de un solo uso (EventSource no envía headers) y
 * serialización de eventos del bus a SSE según el rol (PII enmascarada si aplica).
 */
export class StreamService {
  /** hash(token) → admin. En varias instancias: Redis con TTL. */
  private readonly tokens = new Map<string, { adminId: string; sessionId: string; expiresAt: number }>();

  constructor(private readonly d: ServiceDeps) {}

  issueToken(admin: AdminUser, sessionId: string) {
    const now = this.d.clock.now().getTime();
    for (const [k, v] of this.tokens) if (v.expiresAt <= now) this.tokens.delete(k);
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(sha(token), { adminId: admin.id, sessionId, expiresAt: now + STREAM_TOKEN_TTL_SECONDS * 1000 });
    return { token, expiresIn: STREAM_TOKEN_TTL_SECONDS };
  }

  /** Consume el token (un solo uso) y devuelve el admin activo dueño del token. */
  async consumeToken(token: string): Promise<{ admin: AdminUser; sessionId: string }> {
    const h = sha(token);
    const rec = this.tokens.get(h);
    this.tokens.delete(h);
    if (!rec || rec.expiresAt <= this.d.clock.now().getTime()) throw new AppError('UNAUTHORIZED', 'Token de stream inválido o vencido');
    const session = await this.d.repos.adminSessions.byId(rec.sessionId);
    const admin = await this.d.repos.adminUsers.byId(rec.adminId);
    if (!admin || admin.status !== 'active' || !session || session.revokedAt) throw new AppError('UNAUTHORIZED', 'Sesión admin revocada');
    return { admin, sessionId: rec.sessionId };
  }

  /** Evento del bus → `{ event, data }` para SSE, o null si no aplica a este admin. */
  async present(e: DomainEvent, admin: AdminUser): Promise<{ event: string; data: unknown } | null> {
    const perm = EVENT_PERMISSION[e.type];
    if (perm && !can(admin.role, perm)) return null;
    const p = new AdminPresenter(this.d, { pii: can(admin.role, 'pii:read') });
    switch (e.type) {
      case 'transaction.created':
      case 'transaction.updated':
        return { event: e.type, data: await p.transaction(e.txn) };
      case 'customer.created':
        return { event: e.type, data: await p.customerSummary(e.user) };
      case 'customer.updated': {
        const u = await this.d.repos.users.byId(e.userId);
        return u ? { event: e.type, data: await p.customerSummary(u) } : null;
      }
      case 'kyc.updated':
        return { event: e.type, data: { customerId: e.userId, status: e.status, tier: e.tier } };
      case 'compliance.alert':
        return { event: e.type, data: await p.alert(e.alert) };
      case 'beneficiary.review_required':
        return { event: e.type, data: await p.beneficiaryJson(e.beneficiary) };
      case 'provider.status':
        return { event: e.type, data: e.status };
      case 'treasury.updated':
        return { event: e.type, data: e.snapshot };
      default:
        return null; // eventos internos
    }
  }
}
