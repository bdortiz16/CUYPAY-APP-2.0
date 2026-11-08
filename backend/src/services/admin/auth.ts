import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { AdminRole, AdminUser } from '../../domain/admin.js';
import { newId } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { generateTempPassword, hashPassword, verifyPassword } from '../../lib/password.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../lib/totp.js';
import type { ServiceDeps } from '../deps.js';
import type { AdminContext, AuditService } from './audit.js';
import { presentAdmin } from './presenters.js';

const MFA_TTL_MS = 5 * 60_000;
const MFA_MAX_ATTEMPTS = 5;
const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60_000;

interface MfaChallenge {
  adminId: string;
  expiresAt: number;
  attempts: number;
  ip: string | null;
  userAgent: string | null;
}

export interface AdminClaims {
  adminId: string;
  sessionId: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Autenticación del portal admin: contraseña (scrypt) + TOTP obligatorio → JWT corto
 * (aud=cuypay-admin, clave distinta de la de clientes), revocable por sesión (logout).
 */
export class AdminAuthService {
  private readonly key: Uint8Array;
  /** Desafíos MFA pendientes (por hash del mfaToken). En varias instancias: Redis con TTL. */
  private readonly mfa = new Map<string, MfaChallenge>();
  /** Hash scrypt de relleno para igualar tiempos cuando el correo no existe. */
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly d: ServiceDeps,
    private readonly audit: AuditService,
  ) {
    this.key = new TextEncoder().encode(d.config.ADMIN_JWT_SECRET);
  }

  private ctxFor(admin: AdminUser, ip: string | null, userAgent: string | null): AdminContext {
    return { admin, ip, userAgent };
  }

  // ───────────── Login ─────────────

  async login(email: string, password: string, ip: string | null, userAgent: string | null) {
    const now = this.d.clock.now();
    const admin = await this.d.repos.adminUsers.byEmail(email.trim().toLowerCase());
    if (!admin) {
      this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(password, await this.dummyHash);
      throw new AppError('UNAUTHORIZED', 'Credenciales inválidas');
    }
    if (admin.lockedUntil && admin.lockedUntil > now) {
      throw new AppError('UNAUTHORIZED', 'Cuenta bloqueada temporalmente por intentos fallidos', { lockedUntil: admin.lockedUntil.toISOString() });
    }
    const ok = await verifyPassword(password, admin.passwordHash);
    if (!ok || admin.status !== 'active') {
      if (!ok) {
        admin.failedLoginCount += 1;
        if (admin.failedLoginCount >= MAX_FAILED_LOGINS) {
          admin.lockedUntil = new Date(now.getTime() + LOCK_MS);
          admin.failedLoginCount = 0;
          await this.audit.record(this.ctxFor(admin, ip, userAgent), { action: 'admin.locked', targetType: 'admin', targetId: admin.id, reason: 'too_many_failed_logins' });
        }
        admin.updatedAt = now;
        await this.d.repos.adminUsers.update(admin);
      }
      throw new AppError('UNAUTHORIZED', 'Credenciales inválidas');
    }
    const token = randomBytes(32).toString('base64url');
    // Limpieza oportunista.
    for (const [k, v] of this.mfa) if (v.expiresAt <= now.getTime()) this.mfa.delete(k);
    this.mfa.set(sha(token), { adminId: admin.id, expiresAt: now.getTime() + MFA_TTL_MS, attempts: 0, ip, userAgent });
    return { mfaToken: token, mfaRequired: true as const, expiresIn: MFA_TTL_MS / 1000 };
  }

  async verifyMfa(mfaToken: string, code: string, ip: string | null, userAgent: string | null) {
    const now = this.d.clock.now();
    const h = sha(mfaToken);
    const ch = this.mfa.get(h);
    if (!ch || ch.expiresAt <= now.getTime()) {
      this.mfa.delete(h);
      throw new AppError('UNAUTHORIZED', 'Sesión de verificación inválida o vencida; inicia sesión de nuevo');
    }
    const admin = await this.d.repos.adminUsers.byId(ch.adminId);
    if (!admin || admin.status !== 'active') {
      this.mfa.delete(h);
      throw new AppError('UNAUTHORIZED', 'Credenciales inválidas');
    }
    const step = verifyTotp(admin.totpSecret, code.trim(), now);
    if (step === null || (admin.lastTotpStep !== null && step <= admin.lastTotpStep)) {
      ch.attempts += 1;
      if (ch.attempts >= MFA_MAX_ATTEMPTS) this.mfa.delete(h);
      throw new AppError('UNAUTHORIZED', 'Código de verificación inválido', { attemptsLeft: Math.max(0, MFA_MAX_ATTEMPTS - ch.attempts) });
    }
    this.mfa.delete(h);
    admin.lastTotpStep = step;
    admin.failedLoginCount = 0;
    admin.lockedUntil = null;
    admin.lastLoginAt = now;
    admin.updatedAt = now;
    await this.d.repos.adminUsers.update(admin);

    const ttl = this.d.config.ADMIN_TOKEN_TTL_SECONDS;
    const sessionId = newId('ads', now);
    await this.d.repos.adminSessions.create({
      id: sessionId,
      adminId: admin.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl * 1000),
      revokedAt: null,
      ip,
      userAgent,
    });
    const iat = Math.floor(now.getTime() / 1000);
    const accessToken = await new SignJWT({ sid: sessionId, role: admin.role, typ: 'admin' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(admin.id)
      .setIssuer(this.d.config.JWT_ISSUER)
      .setAudience(this.d.config.ADMIN_JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .setJti(sessionId)
      .sign(this.key);
    await this.audit.record(this.ctxFor(admin, ip, userAgent), { action: 'admin.login', targetType: 'admin', targetId: admin.id, reason: null });
    return { accessToken, expiresIn: ttl, admin: presentAdmin(admin) };
  }

  /** Verifica el Bearer admin; la sesión debe seguir vigente y el usuario activo (rol leído de la BD). */
  async authenticate(token: string): Promise<{ claims: AdminClaims; admin: AdminUser }> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        issuer: this.d.config.JWT_ISSUER,
        audience: this.d.config.ADMIN_JWT_AUDIENCE,
        algorithms: ['HS256'],
        currentDate: this.d.clock.now(),
      }));
    } catch {
      throw new AppError('UNAUTHORIZED', 'Token admin inválido o vencido');
    }
    const adminId = payload.sub;
    const sessionId = payload.sid;
    if (typeof adminId !== 'string' || typeof sessionId !== 'string' || payload.typ !== 'admin') throw new AppError('UNAUTHORIZED', 'Token admin inválido');
    const session = await this.d.repos.adminSessions.byId(sessionId);
    if (!session || session.revokedAt || session.adminId !== adminId) throw new AppError('UNAUTHORIZED', 'Sesión admin revocada');
    const admin = await this.d.repos.adminUsers.byId(adminId);
    if (!admin || admin.status !== 'active') throw new AppError('UNAUTHORIZED', 'Usuario admin deshabilitado');
    return { claims: { adminId, sessionId }, admin };
  }

  async logout(ctx: AdminContext, sessionId: string): Promise<void> {
    await this.d.repos.adminSessions.revoke(sessionId, this.d.clock.now());
    await this.audit.record(ctx, { action: 'admin.logout', targetType: 'admin', targetId: ctx.admin.id, reason: null });
  }

  async changePassword(ctx: AdminContext, currentPassword: string, newPassword: string): Promise<void> {
    const admin = await this.d.repos.adminUsers.byId(ctx.admin.id);
    if (!admin || !(await verifyPassword(currentPassword, admin.passwordHash))) throw new AppError('UNAUTHORIZED', 'Contraseña actual incorrecta');
    admin.passwordHash = await hashPassword(newPassword);
    admin.updatedAt = this.d.clock.now();
    await this.d.repos.adminUsers.update(admin);
    await this.audit.record(ctx, { action: 'admin.password_changed', targetType: 'admin', targetId: admin.id, reason: 'self-service' });
  }

  // ───────────── Gestión de usuarios admin (solo owner) ─────────────

  private enrollment(admin: AdminUser, tempPassword: string) {
    return {
      admin: presentAdmin(admin),
      temporaryPassword: tempPassword,
      totpSecret: admin.totpSecret,
      otpauthUrl: otpauthUrl(this.d.config.ADMIN_TOTP_ISSUER, admin.email, admin.totpSecret),
    };
  }

  /** Crea un admin sin auditar (seed / bootstrap). */
  async createRaw(input: { email: string; name: string; role: AdminRole; password: string; totpSecret?: string }): Promise<AdminUser> {
    const now = this.d.clock.now();
    const admin: AdminUser = {
      id: newId('adm', now),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim(),
      role: input.role,
      status: 'active',
      passwordHash: await hashPassword(input.password),
      totpSecret: input.totpSecret ?? generateTotpSecret(),
      lastTotpStep: null,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repos.adminUsers.create(admin);
    return admin;
  }

  async list() {
    return { items: (await this.d.repos.adminUsers.list()).map(presentAdmin) };
  }

  async create(ctx: AdminContext, input: { email: string; name: string; role: AdminRole; reason: string }) {
    if (await this.d.repos.adminUsers.byEmail(input.email)) throw new AppError('CONFLICT', 'Ya existe un usuario admin con ese correo', { field: 'email' });
    const temp = generateTempPassword();
    const admin = await this.createRaw({ email: input.email, name: input.name, role: input.role, password: temp });
    await this.audit.record(ctx, { action: 'admin_user.create', targetType: 'admin', targetId: admin.id, reason: input.reason, before: null, after: presentAdmin(admin) });
    return this.enrollment(admin, temp);
  }

  private async assertNotLastOwner(target: AdminUser, next: { role?: AdminRole; status?: string }) {
    const losesOwner = target.role === 'owner' && target.status === 'active' && ((next.role && next.role !== 'owner') || next.status === 'disabled');
    if (!losesOwner) return;
    const owners = (await this.d.repos.adminUsers.list()).filter((a) => a.role === 'owner' && a.status === 'active');
    if (owners.length <= 1) throw new AppError('CONFLICT', 'Debe quedar al menos un owner activo');
  }

  async update(ctx: AdminContext, id: string, input: { role?: AdminRole; status?: 'active' | 'disabled'; name?: string; reason: string }) {
    const admin = await this.d.repos.adminUsers.byId(id);
    if (!admin) throw new AppError('NOT_FOUND', 'Usuario admin no encontrado');
    await this.assertNotLastOwner(admin, input);
    const before = presentAdmin(admin);
    if (input.role) admin.role = input.role;
    if (input.status) admin.status = input.status;
    if (input.name) admin.name = input.name.trim();
    admin.updatedAt = this.d.clock.now();
    await this.d.repos.adminUsers.update(admin);
    if (input.status === 'disabled') await this.d.repos.adminSessions.revokeByAdmin(admin.id, this.d.clock.now());
    await this.audit.record(ctx, { action: 'admin_user.update', targetType: 'admin', targetId: admin.id, reason: input.reason, before, after: presentAdmin(admin) });
    return presentAdmin(admin);
  }

  /** Nueva contraseña temporal + nuevo secreto TOTP (p. ej. teléfono perdido). Revoca sesiones. */
  async resetCredentials(ctx: AdminContext, id: string, reason: string) {
    const admin = await this.d.repos.adminUsers.byId(id);
    if (!admin) throw new AppError('NOT_FOUND', 'Usuario admin no encontrado');
    const temp = generateTempPassword();
    admin.passwordHash = await hashPassword(temp);
    admin.totpSecret = generateTotpSecret();
    admin.lastTotpStep = null;
    admin.failedLoginCount = 0;
    admin.lockedUntil = null;
    admin.updatedAt = this.d.clock.now();
    await this.d.repos.adminUsers.update(admin);
    await this.d.repos.adminSessions.revokeByAdmin(admin.id, this.d.clock.now());
    await this.audit.record(ctx, { action: 'admin_user.reset_credentials', targetType: 'admin', targetId: admin.id, reason });
    return this.enrollment(admin, temp);
  }
}
