import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateTotp, hotp, verifyTotp, base32Encode } from '../src/lib/totp.js';
import { hashPassword, verifyPassword } from '../src/lib/password.js';
import { seedAdmin, DEV_ADMIN } from '../src/scripts/seed-admin.js';
import { makeEnv, type TestEnv } from './helpers.js';
import { adminCall, adminLogin, loginWith } from './admin-helpers.js';

describe('TOTP (RFC 6238) y contraseñas', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  it('vectores RFC 4226/6238 (SHA1, 6 dígitos)', () => {
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224');
    expect(hotp(Buffer.from('12345678901234567890'), 1)).toBe('287082');
    expect(generateTotp(secret, new Date(59_000))).toBe('287082');
    expect(generateTotp(secret, new Date(1_111_111_109_000))).toBe('081804');
  });

  it('ventana ±1 paso de 30 s', () => {
    const at = new Date('2026-11-07T15:00:00Z');
    const code = generateTotp(secret, at);
    expect(verifyTotp(secret, code, new Date(at.getTime() + 30_000))).not.toBeNull();
    expect(verifyTotp(secret, code, new Date(at.getTime() - 30_000))).not.toBeNull();
    expect(verifyTotp(secret, code, new Date(at.getTime() + 61_000))).toBeNull();
    expect(verifyTotp(secret, '000000x', at)).toBeNull();
  });

  it('scrypt hash/verify', async () => {
    const h = await hashPassword('una-clave-muy-segura');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('una-clave-muy-segura', h)).toBe(true);
    expect(await verifyPassword('otra', h)).toBe(false);
  });
});

describe('Admin auth', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('seed dev owner: login + TOTP → /admin/me con permisos', async () => {
    const seeded = await seedAdmin(env.container);
    expect(seeded?.admin.role).toBe('owner');
    expect(await seedAdmin(env.container)).toBeNull(); // idempotente
    const token = await loginWith(env, DEV_ADMIN.email, DEV_ADMIN.password, DEV_ADMIN.totpSecret);
    const me = await adminCall(env, token, 'GET', '/v1/admin/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: DEV_ADMIN.email, role: 'owner', status: 'active' });
    expect(me.body.permissions).toContain('admins:manage');
  });

  it('contraseña o código incorrecto → 401; código TOTP no se puede reutilizar', async () => {
    const a = await adminLogin(env, 'support');
    const bad = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email: a.email, password: 'incorrecta-123' } });
    expect(bad.statusCode).toBe(401);
    const unknown = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email: 'nadie@x.com', password: 'incorrecta-123' } });
    expect(unknown.statusCode).toBe(401);

    const l = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email: a.email, password: a.password } });
    const wrong = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/mfa', payload: { mfaToken: l.json().mfaToken, code: '000000' === generateTotp(a.totpSecret, env.clock.now()) ? '111111' : '000000' } });
    expect(wrong.statusCode).toBe(401);
    // Mismo código que ya se usó en adminLogin (mismo paso de 30 s) → rechazado (anti-replay).
    const replay = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/mfa', payload: { mfaToken: l.json().mfaToken, code: generateTotp(a.totpSecret, env.clock.now()) } });
    expect(replay.statusCode).toBe(401);
    // En el siguiente paso funciona.
    env.clock.advanceSeconds(30);
    expect(await loginWith(env, a.email, a.password, a.totpSecret)).toBeTruthy();
  });

  it('token de cliente no sirve en /admin y token admin no sirve en la API de clientes', async () => {
    const a = await adminLogin(env, 'owner');
    const r = await env.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a.token}` } });
    expect(r.statusCode).toBe(401);
    expect((await adminCall(env, 'garbage.token.value', 'GET', '/v1/admin/me')).status).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/v1/admin/dashboard' })).statusCode).toBe(401);
  });

  it('logout revoca la sesión', async () => {
    const a = await adminLogin(env, 'viewer');
    expect((await adminCall(env, a.token, 'POST', '/v1/admin/auth/logout')).status).toBe(204);
    expect((await adminCall(env, a.token, 'GET', '/v1/admin/me')).status).toBe(401);
  });

  it('5 intentos fallidos bloquean la cuenta', async () => {
    const a = await adminLogin(env, 'viewer');
    for (let i = 0; i < 5; i++) {
      await env.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email: a.email, password: 'incorrecta-123' } });
    }
    const ok = await env.app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload: { email: a.email, password: a.password } });
    expect(ok.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('usuarios admin: solo owner; crear devuelve credenciales de enrolamiento; deshabilitar revoca sesiones', async () => {
    const owner = await adminLogin(env, 'owner');
    const compliance = await adminLogin(env, 'compliance');
    expect((await adminCall(env, compliance.token, 'GET', '/v1/admin/users')).status).toBe(403);

    const noReason = await adminCall(env, owner.token, 'POST', '/v1/admin/users', { email: 'nuevo@cuypay.com', name: 'Nuevo', role: 'support' });
    expect(noReason.status).toBe(400);
    const created = await adminCall(env, owner.token, 'POST', '/v1/admin/users', { email: 'nuevo@cuypay.com', name: 'Nuevo', role: 'support', reason: 'Alta de agente' });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toBeTruthy();
    expect(created.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const dup = await adminCall(env, owner.token, 'POST', '/v1/admin/users', { email: 'nuevo@cuypay.com', name: 'Nuevo', role: 'support', reason: 'Alta de agente' });
    expect(dup.status).toBe(409);

    const dis = await adminCall(env, owner.token, 'PATCH', `/v1/admin/users/${compliance.adminId}`, { status: 'disabled', reason: 'Salida' });
    expect(dis.status).toBe(200);
    expect((await adminCall(env, compliance.token, 'GET', '/v1/admin/me')).status).toBe(401);

    // No se puede quitar el último owner.
    const last = await adminCall(env, owner.token, 'PATCH', `/v1/admin/users/${owner.adminId}`, { role: 'viewer', reason: 'Prueba' });
    expect(last.status).toBe(409);
  });
});

describe('Cloudflare Access', () => {
  it('exige Cf-Access-Jwt-Assertion válido cuando está configurado', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keySet = createLocalJWKSet({ keys: [jwk] });
    const { loadConfig } = await import('../src/config.js');
    const { createContainer } = await import('../src/container.js');
    const { buildApp } = await import('../src/http/app.js');
    const { FakeClock } = await import('../src/lib/clock.js');
    const config = loadConfig({
      NODE_ENV: 'test',
      PROVIDERS_MODE: 'mock',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
      CF_ACCESS_TEAM_DOMAIN: 'cuypay',
      CF_ACCESS_AUD: 'aud-123',
    });
    const clock = new FakeClock(new Date().toISOString());
    const container = createContainer(config, { clock, cfAccessKeySet: keySet });
    const app = await buildApp(container);
    try {
      const payload = { email: 'x@cuypay.com', password: 'whatever-123' };
      const none = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload });
      expect(none.statusCode).toBe(403);
      const jwt = await new SignJWT({ email: 'x@cuypay.com' })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://cuypay.cloudflareaccess.com')
        .setAudience('aud-123')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const ok = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload, headers: { 'cf-access-jwt-assertion': jwt } });
      expect(ok.statusCode).toBe(401); // pasa Cloudflare; falla la contraseña
      const badAud = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://cuypay.cloudflareaccess.com').setAudience('otra').setExpirationTime('5m').sign(privateKey);
      const r = await app.inject({ method: 'POST', url: '/v1/admin/auth/login', payload, headers: { 'cf-access-jwt-assertion': badAud } });
      expect(r.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
