import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalRequestString, p256PublicKeyFromX963, sha256Hex, verifyP256Der } from '../src/lib/crypto.js';
import { AppError } from '../src/lib/errors.js';
import { TestDevice, makeEnv, registerUser, type TestClient, type TestEnv } from './helpers.js';

describe('crypto P-256 (Secure Enclave)', () => {
  it('importa X9.63 sin comprimir (65 bytes) y verifica firmas DER', () => {
    const d = new TestDevice();
    expect(Buffer.from(d.publicKeyX963, 'base64')).toHaveLength(65);
    expect(() => p256PublicKeyFromX963(d.publicKeyX963)).not.toThrow();
    const sig = d.signDer('hola');
    expect(verifyP256Der(d.publicKeyX963, 'hola', sig)).toBe(true);
    expect(verifyP256Der(d.publicKeyX963, 'hola!', sig)).toBe(false);
    expect(verifyP256Der(new TestDevice().publicKeyX963, 'hola', sig)).toBe(false);
    expect(verifyP256Der(d.publicKeyX963, 'hola', 'no-base64!!')).toBe(false);
  });

  it('rechaza claves mal formadas', () => {
    expect(() => p256PublicKeyFromX963(Buffer.alloc(65, 1).toString('base64'))).toThrow(AppError);
    expect(() => p256PublicKeyFromX963(Buffer.alloc(33, 4).toString('base64'))).toThrow(AppError);
    const notOnCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64');
    expect(() => p256PublicKeyFromX963(notOnCurve)).toThrow(AppError);
  });

  it('cadena canónica según contrato', () => {
    const s = canonicalRequestString({ method: 'post', path: '/v1/transfers', rawBody: '', timestamp: '1700000000', nonce: 'n' });
    expect(s).toBe(`POST\n/v1/transfers\n${sha256Hex('')}\n1700000000\nn`);
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(s.endsWith('\n')).toBe(false);
  });
});

describe('middleware de firma 🔐', () => {
  let env: TestEnv;
  let c: TestClient;
  beforeEach(async () => {
    env = await makeEnv();
    c = await registerUser(env);
  });
  afterEach(() => env.close());

  // POST /breb/key exige firma; sin KYC devuelve KYC_REQUIRED DESPUÉS de pasar la firma.
  const url = '/v1/breb/key';

  it('firma válida pasa el middleware', async () => {
    const r = await c.signed('POST', url, {});
    expect(r.body.error.code).toBe('KYC_REQUIRED');
  });

  it('sin headers → SIGNATURE_REQUIRED', async () => {
    const r = await c.call('POST', url, {});
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('SIGNATURE_REQUIRED');
  });

  it('body alterado → INVALID_SIGNATURE', async () => {
    const headers = c.signHeaders('POST', url, JSON.stringify({}));
    const r = await c.call('POST', url, { preferredAlias: '@hacker' }, headers);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('path distinto → INVALID_SIGNATURE', async () => {
    const headers = c.signHeaders('POST', '/v1/transfers', '{}');
    const r = await c.call('POST', url, {}, headers);
    expect(r.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('nonce repetido → REPLAYED_NONCE', async () => {
    const nonce = randomUUID();
    const first = await c.signed('POST', url, {}, { nonce });
    expect(first.body.error.code).toBe('KYC_REQUIRED');
    const replay = await c.signed('POST', url, {}, { nonce });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REPLAYED_NONCE');
  });

  it('desfase de reloj > 120 s → INVALID_SIGNATURE; ≤ 120 s se acepta', async () => {
    const now = Math.floor(env.clock.now().getTime() / 1000);
    const late = await c.signed('POST', url, {}, { ts: now - 121 });
    expect(late.body.error.code).toBe('INVALID_SIGNATURE');
    expect(late.body.error.details.reason).toBe('clock_skew');
    const future = await c.signed('POST', url, {}, { ts: now + 121 });
    expect(future.body.error.code).toBe('INVALID_SIGNATURE');
    const ok = await c.signed('POST', url, {}, { ts: now - 119 });
    expect(ok.body.error.code).toBe('KYC_REQUIRED');
  });

  it('firma con otra clave o con otro deviceId → INVALID_SIGNATURE', async () => {
    const other = await c.signed('POST', url, {}, { device: new TestDevice() });
    expect(other.body.error.code).toBe('INVALID_SIGNATURE');
    const otherUser = await registerUser(env);
    const mismatch = await c.signed('POST', url, {}, { deviceId: otherUser.session.deviceId, device: otherUser.session.device });
    expect(mismatch.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('nonce que no es UUID v4 → INVALID_SIGNATURE', async () => {
    const r = await c.signed('POST', url, {}, { nonce: 'abc' });
    expect(r.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('DELETE sin body firma sha256("")', async () => {
    const r = await c.signed('DELETE', '/v1/beneficiaries/ben_inexistente');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});

describe('login por desafío', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('challenge → firma del nonce → AuthSession; el challenge es de un solo uso', async () => {
    const c = await registerUser(env);
    const ch = await env.app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { deviceId: c.session.deviceId } });
    expect(ch.statusCode).toBe(200);
    const { challengeId, nonce } = ch.json();
    const signature = c.session.device.signDer(nonce);
    const login = await env.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { challengeId, deviceId: c.session.deviceId, signature } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ expiresIn: 900, deviceId: c.session.deviceId, user: { id: c.session.userId } });
    const again = await env.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { challengeId, deviceId: c.session.deviceId, signature } });
    expect(again.statusCode).toBe(401);
  });

  it('firma inválida → INVALID_SIGNATURE; challenge vencido → UNAUTHORIZED', async () => {
    const c = await registerUser(env);
    const ch = (await env.app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { deviceId: c.session.deviceId } })).json();
    const bad = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { challengeId: ch.challengeId, deviceId: c.session.deviceId, signature: new TestDevice().signDer(ch.nonce) },
    });
    expect(bad.json().error.code).toBe('INVALID_SIGNATURE');
    const ch2 = (await env.app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { deviceId: c.session.deviceId } })).json();
    env.clock.advanceSeconds(121);
    const expired = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { challengeId: ch2.challengeId, deviceId: c.session.deviceId, signature: c.session.device.signDer(ch2.nonce) },
    });
    expect(expired.json().error.code).toBe('UNAUTHORIZED');
  });

  it('OTP incorrecto → OTP_INVALID', async () => {
    const otp = (await env.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+573009999999' } })).json();
    const r = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        otpId: otp.otpId,
        otpCode: '000000',
        phone: '+573009999999',
        email: 'x@test.com',
        firstName: 'X',
        lastName: 'Y',
        country: 'CO',
        deviceName: 'iPhone',
        devicePublicKey: new TestDevice().publicKeyX963,
      },
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('OTP_INVALID');
  });

  it('refresh rota el token y detecta reuso (revoca la familia)', async () => {
    const c = await registerUser(env);
    const r1 = await env.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: c.session.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const newRefresh = r1.json().refreshToken;
    expect(newRefresh).not.toBe(c.session.refreshToken);
    const reuse = await env.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: c.session.refreshToken } });
    expect(reuse.statusCode).toBe(401);
    const afterTheft = await env.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: newRefresh } });
    expect(afterTheft.statusCode).toBe(401);
  });

  it('access token vence a los 15 min; logout revoca el refresh', async () => {
    const c = await registerUser(env);
    expect((await c.call('GET', '/v1/me')).status).toBe(200);
    const out = await c.call('POST', '/v1/auth/logout');
    expect(out.status).toBe(204);
    const r = await env.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: c.session.refreshToken } });
    expect(r.statusCode).toBe(401);
    env.clock.advanceSeconds(901);
    expect((await c.call('GET', '/v1/me')).body.error.code).toBe('UNAUTHORIZED');
  });

  it('revocar un dispositivo invalida su sesión', async () => {
    const c = await registerUser(env);
    const list = await c.call('GET', '/v1/devices');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: c.session.deviceId, current: true });
    const del = await c.signed('DELETE', `/v1/devices/${c.session.deviceId}`);
    expect(del.status).toBe(204);
    expect((await c.call('GET', '/v1/me')).status).toBe(401);
  });
});
