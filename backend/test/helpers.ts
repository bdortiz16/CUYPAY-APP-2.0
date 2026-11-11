import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createContainer, type Container } from '../src/container.js';
import { buildApp } from '../src/http/app.js';
import { FakeClock } from '../src/lib/clock.js';
import { canonicalRequestString } from '../src/lib/crypto.js';
import { computeSumsubDigest } from '../src/adapters/sumsub/webhook.js';
import { MockCoinsendaGateway } from '../src/adapters/coinsenda/mock.js';
import { MockBrlLiquidityProvider } from '../src/adapters/brl/provider.js';

/** Par de claves P-256 que imita el Secure Enclave. */
export class TestDevice {
  readonly privateKey: KeyObject;
  readonly publicKeyX963: string;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicKeyX963 = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x, 'base64url'),
      Buffer.from(jwk.y, 'base64url'),
    ]).toString('base64');
  }
  signDer(data: string | Buffer): string {
    return sign('sha256', typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { key: this.privateKey, dsaEncoding: 'der' }).toString('base64');
  }
}

export interface TestEnv {
  app: FastifyInstance;
  container: Container;
  clock: FakeClock;
  coinsenda: MockCoinsendaGateway;
  brl: MockBrlLiquidityProvider;
  close: () => Promise<void>;
}

export async function makeEnv(env: Record<string, string> = {}): Promise<TestEnv> {
  const config = loadConfig({
    NODE_ENV: 'test',
    PROVIDERS_MODE: 'mock',
    AUTH_RATE_LIMIT_MAX: '10000',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    ...env,
  });
  const clock = new FakeClock('2026-11-07T15:00:00.000Z'); // 10:00 en Bogotá
  const coinsenda = new MockCoinsendaGateway(clock);
  const brl = new MockBrlLiquidityProvider(clock);
  const container = createContainer(config, { clock, coinsenda, brl });
  const app = await buildApp(container);
  await app.ready();
  return { app, container, clock, coinsenda, brl, close: () => app.close() };
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  userId: string;
  device: TestDevice;
}

/** Cliente de pruebas que firma las peticiones 🔐 como lo hará la app iOS. */
export class TestClient {
  constructor(
    readonly env: TestEnv,
    public session: Session,
  ) {}

  async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await this.env.app.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${this.session.accessToken}`,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...extraHeaders,
      },
    });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  signHeaders(method: string, url: string, payload: string | undefined, opts: { ts?: number; nonce?: string; device?: TestDevice; deviceId?: string } = {}) {
    const ts = String(opts.ts ?? Math.floor(this.env.clock.now().getTime() / 1000));
    const nonce = opts.nonce ?? randomUUID();
    const canonical = canonicalRequestString({ method, path: url.split('?')[0]!, rawBody: payload ?? '', timestamp: ts, nonce });
    return {
      'x-cuypay-device': opts.deviceId ?? this.session.deviceId,
      'x-cuypay-timestamp': ts,
      'x-cuypay-nonce': nonce,
      'x-cuypay-signature': (opts.device ?? this.session.device).signDer(canonical),
    };
  }

  async signed(method: 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, opts: Parameters<TestClient['signHeaders']>[3] = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = this.signHeaders(method, url, payload, opts);
    return this.call(method, url, body, headers);
  }
}

let phoneSeq = 0;
export async function registerUser(
  env: TestEnv,
  overrides: { firstName?: string; lastName?: string; phone?: string; email?: string } = {},
): Promise<TestClient> {
  const phone = overrides.phone ?? `+5730012${String(10000 + ++phoneSeq).slice(-5)}`;
  const otp = await env.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
  if (otp.statusCode !== 200) throw new Error(`otp ${otp.statusCode} ${otp.body}`);
  const device = new TestDevice();
  const res = await env.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      otpId: otp.json().otpId,
      otpCode: '123456',
      phone,
      email: overrides.email ?? `user${phoneSeq}_${Date.now()}@test.cuypay.com`,
      firstName: overrides.firstName ?? 'Ana',
      lastName: overrides.lastName ?? 'Gómez',
      country: 'CO',
      deviceName: 'iPhone de prueba',
      devicePublicKey: device.publicKeyX963,
    },
  });
  if (res.statusCode !== 200) throw new Error(`register ${res.statusCode} ${res.body}`);
  const s = res.json();
  return new TestClient(env, { accessToken: s.accessToken, refreshToken: s.refreshToken, deviceId: s.deviceId, userId: s.user.id, device });
}

export function sumsubWebhook(env: TestEnv, payload: object, alg = 'HMAC_SHA256_HEX', secretOverride?: string) {
  const raw = JSON.stringify(payload);
  const digest = computeSumsubDigest(secretOverride ?? env.container.services.kyc.webhookSecret, Buffer.from(raw), alg);
  return env.app.inject({
    method: 'POST',
    url: '/v1/webhooks/sumsub',
    payload: raw,
    headers: { 'content-type': 'application/json', 'x-payload-digest': digest, 'x-payload-digest-alg': alg },
  });
}

export async function approveKyc(env: TestEnv, client: TestClient) {
  const res = await sumsubWebhook(env, {
    type: 'applicantReviewed',
    applicantId: 'app_1',
    externalUserId: client.session.userId,
    reviewResult: { reviewAnswer: 'GREEN' },
  });
  if (res.statusCode !== 200) throw new Error(`webhook ${res.statusCode} ${res.body}`);
}

/** Usuario con KYC aprobado, llave Bre-B y saldo COP acreditado vía depósito simulado. */
export async function fundedUser(env: TestEnv, copMinor: bigint, overrides: Parameters<typeof registerUser>[1] = {}) {
  const c = await registerUser(env, overrides);
  await approveKyc(env, c);
  const key = await c.signed('POST', '/v1/breb/key', {});
  if (key.status !== 200) throw new Error(`breb ${key.status} ${JSON.stringify(key.body)}`);
  if (copMinor > 0n) {
    const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
    env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: copMinor, payerName: 'Pagador' });
    await env.container.services.deposits.poll();
  }
  return c;
}

export async function addBeneficiary(c: TestClient, alias = '3001234567') {
  const r = await c.call('POST', '/v1/beneficiaries/resolve', { alias });
  if (r.status !== 200) throw new Error(`resolve ${r.status} ${JSON.stringify(r.body)}`);
  return c.signed('POST', '/v1/beneficiaries', { resolutionId: r.body.resolutionId, nickname: 'Juan' });
}
