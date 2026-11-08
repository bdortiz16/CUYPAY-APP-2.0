import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Device, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { p256PublicKeyFromX963, sha256Hex, verifyP256Der } from '../lib/crypto.js';
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

  // ───────────── OTP ─────────────

  async requestOtp(phone: string) {
    const now = this.d.clock.now();
    const id = newId('otp', now);
    const isMockOtp = this.d.config.OTP_PROVIDER_MODE === 'mock' || this.d.config.NODE_ENV !== 'production';
    const code = isMockOtp ? DEV_OTP_CODE : String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + this.d.config.OTP_TTL_SECONDS * 1000);
    await this.d.repos.otps.create({ id, phone, codeHash: this.hashOtp(id, code), attempts: 0, expiresAt, consumedAt: null, createdAt: now });
    await this.d.otp.send(phone, code);
    return { otpId: id, expiresAt };
  }

  private async consumeOtp(otpId: string, phone: string, code: string): Promise<void> {
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
    otp.consumedAt = now;
    await this.d.repos.otps.update(otp);
  }

  // ───────────── Registro ─────────────

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
  }): Promise<AuthSessionResult> {
    // Validar la clave antes de consumir el OTP para no quemarlo por un error del cliente.
    p256PublicKeyFromX963(input.devicePublicKey);
    await this.consumeOtp(input.otpId, input.phone, input.otpCode);
    const now = this.d.clock.now();

    let user = await this.d.repos.users.byPhone(input.phone);
    let created = false;
    if (user) {
      await assertNotFrozen(this.d, user.id);
      // Re-enrolamiento: el teléfono ya existe (p. ej. cambió Face ID y la clave del Secure Enclave quedó inválida).
      // TODO(security): para usuarios con KYC aprobado, exigir re-verificación biométrica (Sumsub liveness) antes de vincular.
      this.d.logger.warn({ userId: user.id }, 'device re-enrollment via OTP');
    } else {
      const byEmail = await this.d.repos.users.byEmail(input.email);
      if (byEmail) throw new AppError('VALIDATION_ERROR', 'El correo ya está registrado', { field: 'email' });
      user = {
        id: newId('usr', now),
        phone: input.phone,
        email: input.email.toLowerCase(),
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        country: 'CO',
        kycStatus: process.env.AUTO_APPROVE_KYC === 'true' ? 'approved' : 'not_started',
        tier: process.env.AUTO_APPROVE_KYC === 'true' ? 'full' : 'basic',
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
