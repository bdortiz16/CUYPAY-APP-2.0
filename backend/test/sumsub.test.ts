import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { computeSumsubDigest, mapSumsubEvent, verifySumsubWebhook } from '../src/adapters/sumsub/webhook.js';
import { LiveSumsubProvider, signSumsubRequest } from '../src/adapters/sumsub/provider.js';
import { makeEnv, registerUser, sumsubWebhook, type TestEnv } from './helpers.js';

describe('Sumsub: webhook X-Payload-Digest', () => {
  const secret = 'whsec';
  const raw = Buffer.from('{"type":"applicantReviewed"}');

  it.each(['HMAC_SHA1_HEX', 'HMAC_SHA256_HEX', 'HMAC_SHA512_HEX'])('verifica %s sobre el cuerpo crudo', (alg) => {
    const digest = computeSumsubDigest(secret, raw, alg);
    expect(verifySumsubWebhook(secret, raw, digest, alg)).toBe(true);
    expect(verifySumsubWebhook(secret, raw, digest.toUpperCase(), alg)).toBe(true);
    expect(verifySumsubWebhook('otro', raw, digest, alg)).toBe(false);
    expect(verifySumsubWebhook(secret, Buffer.from(raw.toString() + ' '), digest, alg)).toBe(false);
  });

  it('rechaza algoritmo desconocido, digest vacío o no-hex', () => {
    const digest = computeSumsubDigest(secret, raw);
    expect(verifySumsubWebhook(secret, raw, digest, 'MD5')).toBe(false);
    expect(verifySumsubWebhook(secret, raw, undefined, undefined)).toBe(false);
    expect(verifySumsubWebhook(secret, raw, 'zz', 'HMAC_SHA256_HEX')).toBe(false);
    expect(verifySumsubWebhook(secret, raw, digest, undefined)).toBe(true); // default SHA256
  });

  it('mapea applicantReviewed', () => {
    expect(mapSumsubEvent({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'GREEN' } })).toBe('approved');
    expect(mapSumsubEvent({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } })).toBe('rejected');
    expect(mapSumsubEvent({ type: 'applicantReviewed', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY' } })).toBe('retry');
    expect(mapSumsubEvent({ type: 'applicantPending' })).toBe('pending');
    expect(mapSumsubEvent({ type: 'applicantCreated' })).toBeNull();
  });
});

describe('Sumsub: endpoint /webhooks/sumsub', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv({ SUMSUB_WEBHOOK_SECRET: 'whsec_test' });
  });
  afterEach(() => env.close());

  it('firma inválida → 401 INVALID_SIGNATURE; válida actualiza el estado (RED/RETRY y RED/FINAL)', async () => {
    const c = await registerUser(env);
    const bad = await sumsubWebhook(env, { type: 'applicantReviewed', externalUserId: c.session.userId, reviewResult: { reviewAnswer: 'GREEN' } }, 'HMAC_SHA256_HEX', 'wrong');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('INVALID_SIGNATURE');
    expect((await c.call('GET', '/v1/me')).body.kycStatus).toBe('not_started');

    const retry = await sumsubWebhook(
      env,
      { type: 'applicantReviewed', externalUserId: c.session.userId, reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'RETRY', rejectLabels: ['BAD_PROOF_OF_IDENTITY'] } },
      'HMAC_SHA512_HEX',
    );
    expect(retry.statusCode).toBe(200);
    expect((await c.call('GET', '/v1/kyc/status')).body).toEqual({
      status: 'retry',
      tier: 'basic',
      reviewAnswer: 'RED',
      rejectLabels: ['BAD_PROOF_OF_IDENTITY'],
    });
    await sumsubWebhook(env, { type: 'applicantReviewed', externalUserId: c.session.userId, reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } });
    expect((await c.call('GET', '/v1/me')).body.kycStatus).toBe('rejected');
  });

  it('webhook sin firma → 401', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/v1/webhooks/sumsub', payload: { type: 'applicantReviewed' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('Sumsub live: firma de peticiones', () => {
  it('X-App-Access-Sig = HMAC-SHA256(secret, ts + METHOD + pathWithQuery + body)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const isToken = String(url).includes('accessTokens');
      return new Response(JSON.stringify(isToken ? { token: 'tok_123', userId: 'usr_1' } : { id: 'app_1' }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new LiveSumsubProvider({ baseUrl: 'https://api.sumsub.com', appToken: 'tkn', secretKey: 'sek', logger: pino({ level: 'silent' }), fetchImpl });

    const a = await p.createApplicant({ externalUserId: 'usr_1', levelName: 'basic kyc', email: 'a@b.co', phone: '+57300', firstName: 'Ana', lastName: 'G', country: 'CO' });
    expect(a.applicantId).toBe('app_1');
    const t = await p.createSdkAccessToken({ externalUserId: 'usr_1', levelName: 'basic kyc', ttlInSecs: 600 });
    expect(t.token).toBe('tok_123');

    expect(calls[0]!.url).toBe('https://api.sumsub.com/resources/applicants?levelName=basic%20kyc');
    for (const call of calls) {
      const h = call.init.headers as Record<string, string>;
      const path = call.url.replace('https://api.sumsub.com', '');
      const expected = createHmac('sha256', 'sek').update(`${h['X-App-Access-Ts']}${call.init.method}${path}${call.init.body ?? ''}`).digest('hex');
      expect(h['X-App-Token']).toBe('tkn');
      expect(h['X-App-Access-Sig']).toBe(expected);
    }
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ userId: 'usr_1', levelName: 'basic kyc', ttlInSecs: 600 });
    expect(signSumsubRequest('s', 1, 'get', '/x')).toBe(createHmac('sha256', 's').update('1GET/x').digest('hex'));
  });
});
