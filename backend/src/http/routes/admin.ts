import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LimitItemSchema } from '../../config.js';
import type { Container } from '../../container.js';
import { ADMIN_ROLES, type AdminUser } from '../../domain/admin.js';
import { AppError } from '../../lib/errors.js';
import type { AdminContext } from '../../services/admin/audit.js';
import { AdminPresenter, presentAdmin } from '../../services/admin/presenters.js';
import { PROVIDER_IDS, type ProviderId } from '../../services/admin/providers.js';
import { can, permissionsOf, type Permission } from '../../services/admin/rbac.js';
import { FxSettingsSchema } from '../../services/runtime-config.js';
import { parse, type RouteHelpers } from '../app.js';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminUser;
    adminSessionId?: string;
  }
}

// ── Esquemas comunes ──
/** Toda acción que modifica algo exige `reason` (queda en el audit log). */
const Reason = z.string({ error: 'reason es obligatorio' }).trim().min(3, 'reason es obligatorio (mínimo 3 caracteres)').max(1000);
const Id = z.string().min(1).max(64);
const IdParam = z.object({ id: Id });
const Limit = z.coerce.number().int().min(1).max(200).default(50);
const Cursor = z.string().max(300).optional();
const DateQ = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(new Date(s).getTime()), 'Fecha ISO-8601 inválida')
  .transform((s) => new Date(s))
  .optional();
const BoolQ = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const Tier = z.enum(['basic', 'full']);
const Role = z.enum(ADMIN_ROLES as [string, ...string[]]).transform((r) => r as AdminUser['role']);

const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
const MfaBody = z.object({ mfaToken: z.string().min(16).max(200), code: z.string().trim().regex(/^\d{6}$/, 'Código de 6 dígitos') });
const PasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12, 'Mínimo 12 caracteres').max(200) });

const CustomersQuery = z.object({
  query: z.string().trim().max(120).optional(),
  kycStatus: z.enum(['not_started', 'pending', 'approved', 'rejected', 'retry']).optional(),
  tier: Tier.optional(),
  status: z.enum(['active', 'frozen']).optional(),
  limit: Limit,
  cursor: Cursor,
});
const TxnQuery = z.object({
  type: z.enum(['deposit', 'transfer', 'conversion']).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional(),
  currency: z.enum(['COP', 'BRL']).optional(),
  customerId: Id.optional(),
  from: DateQ,
  to: DateQ,
  minAmountMinor: z.coerce.number().int().min(0).optional(),
  flagged: BoolQ,
  limit: Limit,
  cursor: Cursor,
});
const ExportQuery = z.object({ from: DateQ, to: DateQ, type: z.enum(['deposit', 'transfer', 'conversion']).optional() });
const AuditQuery = z.object({
  actorId: Id.optional(),
  action: z.string().max(80).optional(),
  targetType: z.string().max(40).optional(),
  targetId: z.string().max(64).optional(),
  limit: Limit,
  cursor: Cursor,
});

export function registerAdminRoutes(app: FastifyInstance, container: Container, h: RouteHelpers) {
  const { deps, services, config } = container;
  const admin = services.admin;

  /** Cloudflare Access (si está configurado) para todo /admin/*. */
  const cfCheck = async (req: FastifyRequest) => {
    if (!admin.cfAccess) return;
    const v = req.headers['cf-access-jwt-assertion'];
    await admin.cfAccess(typeof v === 'string' ? v : undefined);
  };

  const authenticate = async (req: FastifyRequest) => {
    await cfCheck(req);
    const hdr = req.headers.authorization;
    if (!hdr || !hdr.startsWith('Bearer ')) throw new AppError('UNAUTHORIZED', 'Falta el token admin');
    const r = await admin.auth.authenticate(hdr.slice(7).trim());
    req.admin = r.admin;
    req.adminSessionId = r.claims.sessionId;
  };

  const requirePerm = (perm: Permission) => async (req: FastifyRequest) => {
    if (!req.admin || !can(req.admin.role, perm)) {
      throw new AppError('FORBIDDEN', 'Tu rol no tiene permiso para esta acción', { permission: perm, role: req.admin?.role ?? null });
    }
  };

  const guard = (perm: Permission) => ({ preHandler: [authenticate, requirePerm(perm)] });
  const ua = (req: FastifyRequest) => {
    const v = req.headers['user-agent'];
    return typeof v === 'string' ? v.slice(0, 300) : null;
  };
  const ctx = (req: FastifyRequest): AdminContext => ({ admin: req.admin!, ip: req.ip ?? null, userAgent: ua(req) });
  const presenter = (req: FastifyRequest) => new AdminPresenter(deps, { pii: can(req.admin!.role, 'pii:read') });
  const rl = { config: h.authRateLimit };

  // ───────────── Auth ─────────────
  app.post('/admin/auth/login', { ...rl, preHandler: [cfCheck] }, async (req) => {
    const b = parse(LoginBody, req.body);
    return admin.auth.login(b.email, b.password, req.ip ?? null, ua(req));
  });

  app.post('/admin/auth/mfa', { ...rl, preHandler: [cfCheck] }, async (req) => {
    const b = parse(MfaBody, req.body);
    return admin.auth.verifyMfa(b.mfaToken, b.code, req.ip ?? null, ua(req));
  });

  app.post('/admin/auth/logout', { preHandler: [authenticate] }, async (req, reply) => {
    await admin.auth.logout(ctx(req), req.adminSessionId!);
    return reply.status(204).send();
  });

  app.get('/admin/me', { preHandler: [authenticate] }, async (req) => ({ ...presentAdmin(req.admin!), permissions: permissionsOf(req.admin!.role) }));

  app.post('/admin/me/password', { ...rl, preHandler: [authenticate] }, async (req, reply) => {
    const b = parse(PasswordBody, req.body);
    await admin.auth.changePassword(ctx(req), b.currentPassword, b.newPassword);
    return reply.status(204).send();
  });

  // ───────────── Tiempo real (SSE) ─────────────
  app.post('/admin/stream/token', guard('dashboard:read'), async (req) => admin.stream.issueToken(req.admin!, req.adminSessionId!));

  app.get('/admin/stream', async (req: FastifyRequest, reply: FastifyReply) => {
    await cfCheck(req);
    const { token } = parse(z.object({ token: z.string().min(16).max(200) }), req.query);
    const { admin: who, sessionId } = await admin.stream.consumeToken(token);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const write = (event: string, data: unknown) => {
      if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    raw.write('retry: 5000\n\n');
    write('ping', { at: deps.clock.now().toISOString() });
    // Cola para conservar el orden de los eventos aunque la serialización sea asíncrona.
    let chain: Promise<void> = Promise.resolve();
    const unsubscribe = deps.events.subscribe((e) => {
      chain = chain
        .then(async () => {
          const m = await admin.stream.present(e, who);
          if (m) write(m.event, m.data);
        })
        .catch((err) => req.log.warn({ err: (err as Error).message }, 'sse present failed'));
    });
    const ping = setInterval(() => {
      void (async () => {
        const s = await deps.repos.adminSessions.byId(sessionId);
        const a = await deps.repos.adminUsers.byId(who.id);
        if (!s || s.revokedAt || !a || a.status !== 'active') return cleanup();
        write('ping', { at: deps.clock.now().toISOString() });
      })();
    }, 25_000);
    // La conexión no sobrevive a la sesión: el portal pide un token nuevo y reconecta.
    const lifetime = setTimeout(() => cleanup(), config.ADMIN_TOKEN_TTL_SECONDS * 1000);
    ping.unref();
    lifetime.unref();
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearTimeout(lifetime);
      unsubscribe();
      raw.end();
    }
    req.raw.on('close', cleanup);
  });

  // ───────────── Dashboard ─────────────
  app.get('/admin/dashboard', guard('dashboard:read'), async () => admin.dashboard.get());

  // ───────────── Clientes ─────────────
  app.get('/admin/customers', guard('dashboard:read'), async (req) => admin.customers.list(parse(CustomersQuery, req.query), presenter(req)));

  app.get('/admin/customers/:id', guard('dashboard:read'), async (req) => {
    const { id } = parse(IdParam, req.params);
    return admin.customers.detail(id, presenter(req));
  });

  app.post('/admin/customers/:id/freeze', guard('customers:freeze'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: Reason }), req.body);
    return admin.customers.freeze(ctx(req), id, reason);
  });

  app.post('/admin/customers/:id/unfreeze', guard('customers:freeze'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: Reason }), req.body);
    return admin.customers.unfreeze(ctx(req), id, reason);
  });

  app.post('/admin/customers/:id/tier', guard('customers:limits'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(z.object({ tier: Tier, reason: Reason }), req.body);
    return admin.customers.setTier(ctx(req), id, b.tier, b.reason);
  });

  app.put('/admin/customers/:id/limit-overrides', guard('customers:limits'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(z.object({ items: z.array(LimitItemSchema).max(20), reason: Reason }), req.body);
    return admin.customers.setLimitOverrides(ctx(req), id, b.items, b.reason);
  });

  app.post('/admin/customers/:id/devices/:deviceId/revoke', guard('customers:support'), async (req, reply) => {
    const { id, deviceId } = parse(z.object({ id: Id, deviceId: Id }), req.params);
    const { reason } = parse(z.object({ reason: Reason }), req.body);
    await admin.customers.revokeDevice(ctx(req), id, deviceId, reason);
    return reply.status(204).send();
  });

  app.post('/admin/customers/:id/notes', guard('customers:support'), async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(z.object({ text: z.string().trim().min(3).max(4000) }), req.body);
    return reply.status(201).send(await admin.customers.addNote(ctx(req), id, b.text));
  });

  // ───────────── Transacciones ─────────────
  app.get('/admin/transactions', guard('dashboard:read'), async (req) => admin.transactions.list(parse(TxnQuery, req.query), presenter(req)));

  app.get('/admin/transactions/export.csv', guard('treasury:read'), async (req, reply) => {
    const q = parse(ExportQuery, req.query);
    const csv = await admin.transactions.exportCsv(q, presenter(req));
    const stamp = deps.clock.now().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="cuypay-transacciones-${stamp}.csv"`)
      .send('\uFEFF' + csv);
  });

  app.get('/admin/transactions/:id', guard('dashboard:read'), async (req) => {
    const { id } = parse(IdParam, req.params);
    return admin.transactions.detail(id, presenter(req));
  });

  app.post('/admin/transactions/:id/reverse', guard('treasury:write'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: Reason }), req.body);
    return admin.transactions.reverse(ctx(req), id, reason, presenter(req));
  });

  // ───────────── Cumplimiento ─────────────
  app.get('/admin/compliance/beneficiaries', guard('compliance:read'), async (req) => {
    const q = parse(z.object({ status: z.enum(['active', 'pending_review', 'rejected']).optional().default('pending_review') }), req.query);
    return admin.compliance.listBeneficiaries(q.status, presenter(req));
  });

  app.post('/admin/compliance/beneficiaries/:id/decision', guard('compliance:decide'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: Reason }), req.body);
    return admin.compliance.decideBeneficiary(ctx(req), id, b.decision, b.reason, presenter(req));
  });

  app.get('/admin/compliance/alerts', guard('compliance:read'), async (req) => {
    const q = parse(
      z.object({
        status: z.enum(['open', 'resolved']).optional(),
        type: z.enum(['deposit_over_limit', 'aml_hit', 'velocity', 'large_transaction', 'multiple_devices', 'structuring']).optional(),
        customerId: Id.optional(),
      }),
      req.query,
    );
    return admin.compliance.listAlerts(q, presenter(req));
  });

  app.post('/admin/compliance/alerts/:id/resolve', guard('compliance:decide'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(
      z
        .object({
          resolution: z.enum(['false_positive', 'customer_contacted', 'frozen', 'reported']),
          note: z.string().trim().max(2000).optional(),
          reason: z.string().trim().max(1000).optional(),
          reportToUiaf: z.boolean().optional().default(false),
        })
        .transform((v) => ({ ...v, note: v.note || v.reason || '' }))
        .refine((v) => v.note.length >= 3, { message: 'reason (o note) es obligatorio', path: ['reason'] }),
      req.body,
    );
    return admin.compliance.resolveAlert(ctx(req), id, { resolution: b.resolution, note: b.note, reportToUiaf: b.reportToUiaf }, presenter(req));
  });

  // ───────────── Tesorería ─────────────
  app.get('/admin/treasury', guard('treasury:read'), async () => admin.treasury.snapshot());

  app.post('/admin/treasury/reconcile', guard('treasury:write'), async (req) => {
    const { reason } = parse(z.object({ reason: Reason }), req.body);
    return admin.treasury.reconcile(ctx(req), reason);
  });

  app.get('/admin/treasury/fx', guard('treasury:read'), async () => admin.treasury.getFx());

  app.put('/admin/treasury/fx', guard('treasury:write'), async (req) => {
    const b = parse(FxSettingsSchema.partial().extend({ reason: Reason }), req.body);
    const { reason, ...patch } = b;
    return admin.treasury.updateFx(ctx(req), patch, reason);
  });

  // ───────────── Límites ─────────────
  app.get('/admin/limits-config', guard('dashboard:read'), async () => admin.limitsConfig.get());

  app.put('/admin/limits-config/:tier', guard('limits:write'), async (req) => {
    const { tier } = parse(z.object({ tier: Tier }), req.params);
    const b = parse(z.object({ items: z.array(LimitItemSchema).max(20), reason: Reason }), req.body);
    return admin.limitsConfig.update(ctx(req), tier, b.items, b.reason);
  });

  // ───────────── Proveedores ─────────────
  app.get('/admin/providers', guard('dashboard:read'), async () => ({ items: await admin.providers.list() }));

  app.post('/admin/providers/:id/check', guard('providers:check'), async (req) => {
    const { id } = parse(z.object({ id: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]) }), req.params);
    return admin.providers.check(id);
  });

  // ───────────── Audit log ─────────────
  app.get('/admin/audit-log', guard('audit:read'), async (req) => {
    const q = parse(AuditQuery, req.query);
    const rows = await admin.audit.query(q);
    const start = q.cursor ? rows.findIndex((r) => r.id === Buffer.from(q.cursor!, 'base64url').toString('utf8')) + 1 : 0;
    const page = rows.slice(Math.max(0, start), Math.max(0, start) + q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((e) => ({ ...e, at: e.at.toISOString() })),
      nextCursor: last && start + q.limit < rows.length ? Buffer.from(last.id).toString('base64url') : null,
    };
  });

  // ───────────── Usuarios admin (solo owner) ─────────────
  app.get('/admin/users', guard('admins:manage'), async () => admin.auth.list());

  app.post('/admin/users', guard('admins:manage'), async (req, reply) => {
    const b = parse(z.object({ email: z.string().email().max(254), name: z.string().trim().min(1).max(120), role: Role, reason: Reason }), req.body);
    return reply.status(201).send(await admin.auth.create(ctx(req), b));
  });

  app.patch('/admin/users/:id', guard('admins:manage'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const b = parse(
      z.object({
        role: Role.optional(),
        status: z.enum(['active', 'disabled']).optional(),
        name: z.string().trim().min(1).max(120).optional(),
        reason: Reason,
      }),
      req.body,
    );
    return admin.auth.update(ctx(req), id, b);
  });

  app.post('/admin/users/:id/reset-credentials', guard('admins:manage'), async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: Reason }), req.body);
    return admin.auth.resetCredentials(ctx(req), id, reason);
  });
}
