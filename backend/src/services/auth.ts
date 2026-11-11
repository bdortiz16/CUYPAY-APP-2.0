import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Device, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { p256PublicKeyFromX963, sha256Hex, verifyP256Der } from '../lib/crypto.js';
import { assertDeliverableEmail, isPlaceholderEmail } from '../lib/email-validator.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';
import { assertNotFrozen } from './runtime-config.js';

export interface AuthSessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
  user: User;
}

export interface AccessClaims {
  userId: string;
  deviceId: string;
  sessionFamilyId: string;
}

const DEV_OTP_CODE = '123456';

export class AuthService {
  private readonly jwtKey: Uint8Array;

  constructor(private readonly d: ServiceDeps) {
    this.jwtKey = new TextEncoder().encode(d.config.JWT_SECRET);
  }

  private hashOtp(otpId: string, code: string): string {
    return createHmac('sha256', this.d.config.JWT_SECRET).update(`${otpId}:${code}`).digest('hex');
  }

  private hashPassword(userId: string, password: string): string {
    return createHmac('sha256', this.d.config.JWT_SECRET).update(`${userId}:${password}`).digest('hex');
  }

  // ───────────── OTP ─────────────

  async requestOtp(phone: string) {
    const now = this.d.clock.now();
    const id = newId('otp', now);
    const isMockOtp = this.d.config.OTP_PROVIDER_MODE === 'mock';
    const code = isMockOtp ? DEV_OTP_CODE : String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + this.d.config.OTP_TTL_SECONDS * 1000);
    await this.d.repos.otps.create({ id, phone, codeHash: this.hashOtp(id, code), attempts: 0, expiresAt, consumedAt: null, createdAt: now });
    await this.d.otp.send(phone, code);
    return { otpId: id, expiresAt };
  }

  private async verifyOtp(otpId: string, phone: string, code: string) {
    const now = this.d.clock.now();
    const otp = await this.d.repos.otps.byId(otpId);
    if (!otp || otp.phone !== phone || otp.consumedAt || otp.expiresAt <= now || otp.attempts >= this.d.config.OTP_MAX_ATTEMPTS) {
      throw new AppError('OTP_INVALID', 'Código OTP inválido o vencido');
    }
    const a = Buffer.from(otp.codeHash, 'hex');
    const b = Buffer.from(this.hashOtp(otpId, code), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      otp.attempts += 1;
      await this.d.repos.otps.update(otp);
      throw new AppError('OTP_INVALID', 'Código OTP inválido o vencido', { attemptsLeft: Math.max(0, this.d.config.OTP_MAX_ATTEMPTS - otp.attempts) });
    }
    return otp;
  }

  // ───────────── Registro y perfil ─────────────

  static isPlaceholderEmail(raw?: string | null): boolean {
    return isPlaceholderEmail(raw);
  }

  async register(input: {
    otpId: string;
    otpCode: string;
    phone: string;
    email: string;
    firstName: string;
    lastName: string;
    country: 'CO';
    deviceName: string;
    devicePublicKey: string;
    password?: string;
  }): Promise<AuthSessionResult> {
    // 1) Validar la clave y verificar el OTP primero (sin marcarlo consumido aún).
    p256PublicKeyFromX963(input.devicePublicKey);
    const otp = await this.verifyOtp(input.otpId, input.phone, input.otpCode);

    // 2) Validar que el correo exista antes de consumir el OTP (así un typo en el correo permite corregir y reintentar).
    const rawEmail = input.email.trim().toLowerCase();
    const isLive = this.d.config.PROVIDERS_MODE === 'live';
    const normalizedEmail = AuthService.isPlaceholderEmail(rawEmail)
      ? `pendiente+${input.phone.replace(/\D/g, '')}@pendiente.cuypay.com`
      : await assertDeliverableEmail(rawEmail, { isLive });

    // 3) Marcar el OTP como consumido una vez validados los datos de entrada.
    const now = this.d.clock.now();
    otp.consumedAt = now;
    await this.d.repos.otps.update(otp);
    const cleanFirst = input.firstName.trim();
    const cleanLast = input.lastName.trim();

    let user = await this.d.repos.users.byPhone(input.phone);
    let created = false;
    if (user) {
      await assertNotFrozen(this.d, user.id);
      let userChanged = false;
      if (input.password) {
        user.passwordHash = this.hashPassword(user.id, input.password);
        userChanged = true;
      }
      if (!AuthService.isPlaceholderEmail(rawEmail) && normalizedEmail !== user.email) {
        const other = await this.d.repos.users.byEmail(normalizedEmail);
        if (!other || other.id === user.id) {
          user.email = normalizedEmail;
          userChanged = true;
        }
      }
      if (cleanFirst && cleanFirst.toLowerCase() !== 'usuario' && cleanFirst !== user.firstName) {
        user.firstName = cleanFirst;
        userChanged = true;
      }
      if (cleanLast && cleanLast.toLowerCase() !== 'cuypay' && cleanLast !== user.lastName) {
        user.lastName = cleanLast;
        userChanged = true;
      }
      if (userChanged) {
        user.updatedAt = now;
        await this.d.repos.users.update(user);
      }
      this.d.logger.warn({ userId: user.id }, 'device re-enrollment via OTP');
    } else {
      const byEmail = await this.d.repos.users.byEmail(normalizedEmail);
      if (byEmail) throw new AppError('VALIDATION_ERROR', 'El correo ya está registrado', { field: 'email' });
      const userId = newId('usr', now);
      user = {
        id: userId,
        phone: input.phone,
        email: normalizedEmail,
        firstName: cleanFirst,
        lastName: cleanLast,
        country: 'CO',
        kycStatus: process.env.AUTO_APPROVE_KYC === 'true' ? 'approved' : 'not_started',
        tier: process.env.AUTO_APPROVE_KYC === 'true' ? 'full' : 'basic',
        passwordHash: input.password ? this.hashPassword(userId, input.password) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.repos.users.create(user);
      created = true;
    }
    const device: Device = {
      id: newId('dev', now),
      userId: user.id,
      name: input.deviceName.trim(),
      publicKey: input.devicePublicKey.trim(),
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null,
    };
    await this.d.repos.devices.create(device);
    if (created) await this.d.events.publish({ type: 'customer.created', user });
    await this.d.events.publish({ type: 'device.created', device });
    return this.issueSession(user, device, newId('sfm', now));
  }

  async updateProfile(
    userId: string,
    input: { firstName?: string; lastName?: string; email?: string; phone?: string },
  ): Promise<User> {
    const user = await this.d.repos.users.byId(userId);
    if (!user) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
    await assertNotFrozen(this.d, user.id);

    const now = this.d.clock.now();
    const isLive = this.d.config.PROVIDERS_MODE === 'live';
    let contactChanged = false;

    if (input.email !== undefined) {
      const cleanEmail = await assertDeliverableEmail(input.email, { isLive });
      if (cleanEmail !== user.email) {
        const existingByEmail = await this.d.repos.users.byEmail(cleanEmail);
        if (existingByEmail && existingByEmail.id !== user.id) {
          throw new AppError('VALIDATION_ERROR', 'Este correo electrónico ya está asociado a otra cuenta', { field: 'email' });
        }
        user.email = cleanEmail;
        contactChanged = true;
      }
    }

    if (input.phone !== undefined) {
      const cleanPhone = input.phone.trim();
      if (cleanPhone !== user.phone) {
        const existingByPhone = await this.d.repos.users.byPhone(cleanPhone);
        if (existingByPhone && existingByPhone.id !== user.id) {
          throw new AppError('VALIDATION_ERROR', 'Este número de celular ya está asociado a otra cuenta', { field: 'phone' });
        }
        user.phone = cleanPhone;
        contactChanged = true;
      }
    }

    if (input.firstName !== undefined) {
      const cleanFirst = input.firstName.trim();
      if (cleanFirst.toLowerCase() === 'usuario') {
        throw new AppError('VALIDATION_ERROR', 'Ingresa tu nombre real', { field: 'firstName' });
      }
      if (cleanFirst !== user.firstName) {
        user.firstName = cleanFirst;
        contactChanged = true;
      }
    }

    if (input.lastName !== undefined) {
      const cleanLast = input.lastName.trim();
      if (cleanLast.toLowerCase() === 'cuypay') {
        throw new AppError('VALIDATION_ERROR', 'Ingresa tu apellido real', { field: 'lastName' });
      }
      if (cleanLast !== user.lastName) {
        user.lastName = cleanLast;
        contactChanged = true;
      }
    }

    user.updatedAt = now;
    await this.d.repos.users.update(user);

    if (contactChanged) {
      const kycRec = await this.d.repos.kyc.byUser(user.id);
      if (kycRec?.providerCardHolderId) {
        await this.d.repos.kyc.upsert({
          ...kycRec,
          providerCardHolderId: null,
          updatedAt: now,
        });
      }
    }

    return user;
  }

  // ───────────── Login con contraseña ─────────────

  async loginWithPassword(input: {
    phone: string;
    password: string;
    deviceName?: string;
    devicePublicKey?: string;
  }): Promise<AuthSessionResult> {
    const user = await this.d.repos.users.byPhone(input.phone);
    if (!user) {
      throw new AppError('UNAUTHORIZED', 'Celular o contraseña incorrectos');
    }
    if (!user.passwordHash) {
      // Migración suave: si el usuario se registró antes del soporte de contraseña,
      // la establecemos en este primer intento de login
      user.passwordHash = this.hashPassword(user.id, input.password);
      await this.d.repos.users.update(user);
    } else {
      const expectedHash = Buffer.from(user.passwordHash, 'hex');
      const actualHash = Buffer.from(this.hashPassword(user.id, input.password), 'hex');
      if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
        throw new AppError('UNAUTHORIZED', 'Celular o contraseña incorrectos');
      }
    }

    const now = this.d.clock.now();
    let device: Device | null = null;
    if (input.devicePublicKey) {
      p256PublicKeyFromX963(input.devicePublicKey);
      device = {
        id: newId('dev', now),
        userId: user.id,
        name: (input.deviceName || 'iPhone').trim(),
        publicKey: input.devicePublicKey.trim(),
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      };
      await this.d.repos.devices.create(device);
      await this.d.events.publish({ type: 'device.created', device });
    } else {
      const devices = await this.d.repos.devices.listByUser(user.id);
      device = devices.find((d: Device) => !d.revokedAt) || null;
      if (!device) {
        device = {
          id: newId('dev', now),
          userId: user.id,
          name: (input.deviceName || 'iPhone').trim(),
          publicKey: '',
          createdAt: now,
          lastUsedAt: now,
          revokedAt: null,
        };
        await this.d.repos.devices.create(device);
      }
    }

    device.lastUsedAt = now;
    await this.d.repos.devices.update(device);
    return this.issueSession(user, device, newId('sfm', now));
  }

  // ───────────── Login por desafío ─────────────

  async createChallenge(deviceId: string) {
    const device = await this.d.repos.devices.byId(deviceId);
    if (!device || device.revokedAt) throw new AppError('UNAUTHORIZED', 'Dispositivo no reconocido');
    const now = this.d.clock.now();
    const challenge = {
      id: newId('chl', now),
      deviceId,
      nonce: randomBytes(32).toString('base64url'),
      expiresAt: new Date(now.getTime() + this.d.config.CHALLENGE_TTL_SECONDS * 1000),
      consumedAt: null,
    };
    await this.d.repos.challenges.create(challenge);
    return { challengeId: challenge.id, nonce: challenge.nonce, expiresAt: challenge.expiresAt };
  }

  async login(input: { challengeId: string; deviceId: string; signature: string }): Promise<AuthSessionResult> {
    const now = this.d.clock.now();
    const challenge = await this.d.repos.challenges.consume(input.challengeId, now);
    if (!challenge || challenge.deviceId !== input.deviceId || challenge.expiresAt <= now) {
      throw new AppError('UNAUTHORIZED', 'Desafío inválido o vencido');
    }
    const device = await this.d.repos.devices.byId(input.deviceId);
    if (!device || device.revokedAt) throw new AppError('UNAUTHORIZED', 'Dispositivo no reconocido');
    if (!verifyP256Der(device.publicKey, Buffer.from(challenge.nonce, 'utf8'), input.signature)) {
      throw new AppError('INVALID_SIGNATURE', 'Firma del desafío inválida');
    }
    const user = await this.d.repos.users.byId(device.userId);
    if (!user) throw new AppError('UNAUTHORIZED', 'Usuario inexistente');
    await assertNotFrozen(this.d, user.id);
    device.lastUsedAt = now;
    await this.d.repos.devices.update(device);
    return this.issueSession(user, device, newId('sfm', now));
  }

  // ───────────── Refresh rotativo ─────────────

  async refresh(refreshToken: string): Promise<AuthSessionResult> {
    const now = this.d.clock.now();
    const rec = await this.d.repos.refreshTokens.byHash(sha256Hex(refreshToken));
    if (!rec || rec.revokedAt || rec.expiresAt <= now) throw new AppError('UNAUTHORIZED', 'Refresh token inválido');
    if (rec.usedAt || !(await this.d.repos.refreshTokens.markUsed(rec.id, now))) {
      // Reuso de un token ya rotado → posible robo: se revoca toda la familia.
      await this.d.repos.refreshTokens.revokeFamily(rec.familyId, now);
      this.d.logger.warn({ userId: rec.userId, deviceId: rec.deviceId }, 'refresh token reuse detected');
      throw new AppError('UNAUTHORIZED', 'Refresh token inválido');
    }
    const device = await this.d.repos.devices.byId(rec.deviceId);
    const user = await this.d.repos.users.byId(rec.userId);
    if (!device || device.revokedAt || !user) throw new AppError('UNAUTHORIZED', 'Sesión revocada');
    await assertNotFrozen(this.d, user.id);
    device.lastUsedAt = now;
    await this.d.repos.devices.update(device);
    return this.issueSession(user, device, rec.familyId);
  }

  async logout(claims: AccessClaims): Promise<void> {
    await this.d.repos.refreshTokens.revokeFamily(claims.sessionFamilyId, this.d.clock.now());
  }

  // ───────────── Tokens ─────────────

  private async issueSession(user: User, device: Device, familyId: string): Promise<AuthSessionResult> {
    const now = this.d.clock.now();
    const ttl = this.d.config.ACCESS_TOKEN_TTL_SECONDS;
    const iat = Math.floor(now.getTime() / 1000);
    const accessToken = await new SignJWT({ did: device.id, sfm: familyId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(this.d.config.JWT_ISSUER)
      .setAudience(this.d.config.JWT_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .setJti(newId('jti', now))
      .sign(this.jwtKey);
    const refreshToken = randomBytes(32).toString('base64url');
    await this.d.repos.refreshTokens.create({
      id: newId('rtk', now),
      tokenHash: sha256Hex(refreshToken),
      familyId,
      userId: user.id,
      deviceId: device.id,
      expiresAt: new Date(now.getTime() + this.d.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      usedAt: null,
      revokedAt: null,
      createdAt: now,
    });
    return { accessToken, refreshToken, expiresIn: ttl, deviceId: device.id, user };
  }

  /** Verifica el Bearer token y que el dispositivo siga activo. */
  async authenticate(token: string): Promise<AccessClaims> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.jwtKey, {
        issuer: this.d.config.JWT_ISSUER,
        audience: this.d.config.JWT_AUDIENCE,
        algorithms: ['HS256'],
        currentDate: this.d.clock.now(),
      }));
    } catch {
      throw new AppError('UNAUTHORIZED', 'Token inválido o vencido');
    }
    const userId = payload.sub;
    const deviceId = payload.did;
    const sessionFamilyId = payload.sfm;
    if (typeof userId !== 'string' || typeof deviceId !== 'string' || typeof sessionFamilyId !== 'string') {
      throw new AppError('UNAUTHORIZED', 'Token inválido');
    }
    const device = await this.d.repos.devices.byId(deviceId);
    if (!device || device.revokedAt || device.userId !== userId) throw new AppError('UNAUTHORIZED', 'Sesión revocada');
    return { userId, deviceId, sessionFamilyId };
  }
}
