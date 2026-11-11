import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { computeSumsubDigest, mapSumsubEvent, verifySumsubWebhook } from '../src/adapters/sumsub/webhook.js';
import { LiveSumsubProvider, signSumsubRequest } from '../src/adapters/sumsub/provider.js';
import { assertDeliverableEmail } from '../src/lib/email-validator.js';
import { makeEnv, registerUser, sumsubWebhook, TestDevice, type TestEnv } from './helpers.js';

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

  it('getApplicantProfile extrae datos OCR reales y protege contra documentos sintéticos Mock-Doe en Sandbox', async () => {
    const fetchReal = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'app_real_1',
          email: 'laura@cuypay.com',
          phone: '+573001112233',
          fixedInfo: { firstName: 'Laura', lastName: 'Gómez', country: 'COL' },
          info: {
            firstName: 'LAURA CAMILA',
            lastName: 'GOMEZ PEREZ',
            dob: '1998-04-21',
            nationality: 'COL',
            country: 'COL',
            idDocs: [
              {
                idDocType: 'ID_CARD',
                country: 'COL',
                number: '1.020.456.789',
                firstName: 'LAURA CAMILA',
                lastName: 'GOMEZ PEREZ',
              },
            ],
            addresses: [
              {
                country: 'COL',
                state: 'Antioquia',
                town: 'Medellín',
                postCode: '050021',
                street: 'Calle 10',
                buildingNumber: '43A',
                flatNumber: '801',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const pReal = new LiveSumsubProvider({
      baseUrl: 'https://api.sumsub.com',
      appToken: 'prd:token',
      secretKey: 'sek',
      logger: pino({ level: 'silent' }),
      fetchImpl: fetchReal,
    });

    const realProfile = await pReal.getApplicantProfile({ applicantId: 'app_real_1', externalUserId: 'usr_laura' });
    expect(realProfile).toMatchObject({
      applicantId: 'app_real_1',
      firstName: 'LAURA CAMILA',
      lastName: 'GOMEZ PEREZ',
      birthdate: '1998-04-21',
      nationality: 'COL',
      documentCountry: 'COL',
      documentType: 'cedula_ciudadania',
      documentNumber: '1020456789',
      isSandboxMockDocument: false,
      address: {
        country: 'COL',
        province: 'Antioquia',
        city: 'Medellín',
        zipCode: '050021',
        streetName: 'Calle 10',
        streetNumber: '43A',
        additionalInfo: 'Apto 801',
      },
    });

    const fetchSandbox = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: '6af12e8c67d0626663e31c0f',
          email: 'bryandavidortiz51@gmail.com',
          phone: '+573154103795',
          fixedInfo: { firstName: 'bryan', lastName: 'Ortiz', country: 'COL' },
          info: {
            firstName: 'John',
            lastName: 'Mock-Doe',
            dob: '1986-07-02',
            nationality: 'BHR',
            country: 'COL',
            idDocs: [
              {
                idDocType: 'ID_CARD',
                country: 'BHR',
                number: 'Mock-WDXX2U2VBY',
                firstName: 'John',
                lastName: 'Mock-Doe',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const pSandbox = new LiveSumsubProvider({
      baseUrl: 'https://api.sumsub.com',
      appToken: 'sbx:token',
      secretKey: 'sek',
      logger: pino({ level: 'silent' }),
      fetchImpl: fetchSandbox,
    });

    const sandboxProfile = await pSandbox.getApplicantProfile({
      applicantId: '6af12e8c67d0626663e31c0f',
      externalUserId: 'usr_bryan',
    });
    expect(sandboxProfile).toMatchObject({
      applicantId: '6af12e8c67d0626663e31c0f',
      firstName: 'bryan',
      lastName: 'Ortiz',
      documentType: 'cedula_ciudadania',
      documentNumber: null,
      isSandboxMockDocument: true,
    });
  });

  it('detecta EMAIL_VERIFICATION y PHONE_VERIFICATION en GREEN desde requiredIdDocsStatus y descarta correos genéricos', async () => {
    const fetchVerified = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/requiredIdDocsStatus')) {
        return new Response(
          JSON.stringify({
            IDENTITY: { reviewResult: { reviewAnswer: 'GREEN' } },
            SELFIE: { reviewResult: { reviewAnswer: 'GREEN' } },
            EMAIL_VERIFICATION: { reviewResult: { reviewAnswer: 'GREEN' } },
            PHONE_VERIFICATION: { reviewResult: { reviewAnswer: 'GREEN' } },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'app_verified_1',
          email: 'camila.real@gmail.com',
          phone: '+573109998877',
          info: {
            firstName: 'CAMILA',
            lastName: 'RODRIGUEZ',
            dob: '1995-08-14',
            country: 'COL',
            idDocs: [{ idDocType: 'ID_CARD', country: 'COL', number: '1030555666' }],
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new LiveSumsubProvider({
      baseUrl: 'https://api.sumsub.com',
      appToken: 'prd:token',
      secretKey: 'sek',
      logger: pino({ level: 'silent' }),
      fetchImpl: fetchVerified,
    });

    const profile = await provider.getApplicantProfile({ applicantId: 'app_verified_1', externalUserId: 'usr_camila' });
    expect(profile?.verifiedEmailFromKyc).toBe('camila.real@gmail.com');
    expect(profile?.verifiedPhoneFromKyc).toBe('+573109998877');

    // Si en Sumsub pusieron un correo genérico/falso (ej. cliente@correo.com o typo @gmial.com), se descarta
    const fetchFakeEmail = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/requiredIdDocsStatus')) {
        return new Response(JSON.stringify({ EMAIL_VERIFICATION: { reviewResult: { reviewAnswer: 'GREEN' } } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: 'app_fake_email',
          email: 'cliente@correo.com',
          phone: '+573109998877',
          info: { firstName: 'JUAN', lastName: 'PEREZ' },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const pFake = new LiveSumsubProvider({
      baseUrl: 'https://api.sumsub.com',
      appToken: 'sbx:token',
      secretKey: 'sek',
      logger: pino({ level: 'silent' }),
      fetchImpl: fetchFakeEmail,
    });
    const fakeProfile = await pFake.getApplicantProfile({ applicantId: 'app_fake_email', externalUserId: 'usr_juan' });
    expect(fakeProfile?.verifiedEmailFromKyc).toBeNull();
    expect(fakeProfile?.email).toBeNull();
  });
});

describe('Validación de existencia de correo (typos, temporales y DNS MX)', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('assertDeliverableEmail bloquea typos comunes, dominios desechables y dominios sin registros MX en modo live', async () => {
    await expect(assertDeliverableEmail('juan@gmial.com', { isLive: true })).rejects.toThrow(/gmail\.com/i);
    await expect(assertDeliverableEmail('pepe@yopmail.com', { isLive: true })).rejects.toThrow(/temporales ni genéricos/i);
    await expect(assertDeliverableEmail('cliente@cuypay.com', { isLive: true })).rejects.toThrow(/genérico/i);

    const notFoundMx = async () => {
      const err = new Error('queryMx ENOTFOUND dominio-falso-inexistente.com') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    };
    await expect(
      assertDeliverableEmail('alguien@dominio-falso-inexistente.com', { isLive: true, resolveMxImpl: notFoundMx }),
    ).rejects.toThrow(/no existe/i);

    const nullMx = async () => [{ exchange: '.', priority: 0 }];
    await expect(
      assertDeliverableEmail('alguien@sin-buzon.co', { isLive: true, resolveMxImpl: nullMx }),
    ).rejects.toThrow(/no puede recibir mensajes/i);

    const validMx = async () => [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }];
    await expect(
      assertDeliverableEmail('Camila.Real@Gmail.com', { isLive: true, resolveMxImpl: validMx }),
    ).resolves.toBe('camila.real@gmail.com');
  });

  it('rechaza correo con typo en registro SIN quemar el código OTP para que el usuario corrija y continúe', async () => {
    const phone = '+573158887766';
    const otp = await env.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
    const otpId = otp.json().otpId as string;
    const device = new TestDevice();

    // 1) Intento con typo @gmial.com → 400 VALIDATION_ERROR
    const badReg = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        otpId,
        otpCode: '123456',
        phone,
        email: 'camila@gmial.com',
        firstName: 'Camila',
        lastName: 'Soto',
        country: 'CO',
        deviceName: 'iPhone',
        devicePublicKey: device.publicKeyX963,
      },
    });
    expect(badReg.statusCode).toBe(400);
    expect(badReg.json().error.message).toMatch(/gmail\.com/i);

    // 2) Corrige a camila@gmail.com reutilizando el mismo OTP → 200 OK
    const goodReg = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        otpId,
        otpCode: '123456',
        phone,
        email: 'camila@gmail.com',
        firstName: 'Camila',
        lastName: 'Soto',
        country: 'CO',
        deviceName: 'iPhone',
        devicePublicKey: device.publicKeyX963,
      },
    });
    expect(goodReg.statusCode).toBe(200);
    expect(goodReg.json().user.email).toBe('camila@gmail.com');

    // 3) PUT /v1/me también bloquea correos temporales/genéricos
    const c = await registerUser(env);
    const badUpdate = await c.signed('PUT', '/v1/me', { email: 'falso@yopmail.com' });
    expect(badUpdate.status).toBe(400);
  });
});

