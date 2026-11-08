import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, registerUser, sumsubWebhook, type TestEnv } from './helpers.js';

describe('flujo completo (happy path)', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('register → login → KYC → llave Bre-B → depósito → beneficiario + AML → envío → conversión', async () => {
    // 1) Registro (OTP 123456)
    const c = await registerUser(env, { firstName: 'Ana', lastName: 'Gómez' });
    const me = await c.call('GET', '/v1/me');
    expect(me.body).toMatchObject({ firstName: 'Ana', kycStatus: 'not_started', tier: 'basic', country: 'CO' });

    // 2) Login por desafío firmado
    const ch = (await env.app.inject({ method: 'POST', url: '/v1/auth/challenge', payload: { deviceId: c.session.deviceId } })).json();
    const login = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { challengeId: ch.challengeId, deviceId: c.session.deviceId, signature: c.session.device.signDer(ch.nonce) },
    });
    expect(login.statusCode).toBe(200);
    c.session.accessToken = login.json().accessToken;

    // Sin KYC no se puede crear llave
    expect((await c.signed('POST', '/v1/breb/key', {})).body.error.code).toBe('KYC_REQUIRED');

    // 3) KYC Sumsub: token SDK + webhook aprobado
    const tok = await c.call('POST', '/v1/kyc/sumsub/token');
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ levelName: 'basic-kyc-level' });
    expect(typeof tok.body.token).toBe('string');
    const pend = await sumsubWebhook(env, { type: 'applicantPending', externalUserId: c.session.userId, applicantId: 'a1' });
    expect(pend.statusCode).toBe(200);
    expect((await c.call('GET', '/v1/kyc/status')).body.status).toBe('pending');
    expect((await c.signed('POST', '/v1/breb/key', {})).body.error.code).toBe('KYC_PENDING');
    await sumsubWebhook(env, {
      type: 'applicantReviewed',
      externalUserId: c.session.userId,
      applicantId: 'a1',
      reviewResult: { reviewAnswer: 'GREEN' },
    });
    expect((await c.call('GET', '/v1/kyc/status')).body).toMatchObject({ status: 'approved', tier: 'full', reviewAnswer: 'GREEN' });

    // 4) Llave Bre-B propia
    expect((await c.call('GET', '/v1/breb/key')).status).toBe(404);
    const key = await c.signed('POST', '/v1/breb/key', {});
    expect(key.status).toBe(200);
    expect(key.body.alias).toMatch(/^@cuypayana\d{3}$/);
    expect(key.body).toMatchObject({ status: 'active', holderName: 'Ana Gómez' });
    expect((await c.signed('POST', '/v1/breb/key', {})).body.error.code).toBe('BREB_KEY_EXISTS');
    expect((await c.call('GET', '/v1/breb/key')).body.id).toBe(key.body.id);

    // 5) Depósito entrante por la llave (poller), deduplicado
    const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
    const dep = env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 200_000_000n, payerName: 'Carlos Ramírez' });
    expect((await env.container.services.deposits.poll()).credited).toBe(1);
    expect((await env.container.services.deposits.poll()).credited).toBe(0);
    expect(dep.id).toBeTruthy();
    let wallets = (await c.call('GET', '/v1/wallets')).body.items;
    expect(wallets).toEqual([
      { currency: 'COP', balanceMinor: 200_000_000, availableMinor: 200_000_000, heldMinor: 0 },
      { currency: 'BRL', balanceMinor: 0, availableMinor: 0, heldMinor: 0 },
    ]);

    // 6) Resolver beneficiario (Bre-B) → confirmar → AML clear → active
    expect((await c.call('POST', '/v1/beneficiaries/resolve', { alias: '3009999999' })).body.error.code).toBe('BREB_ALIAS_NOT_FOUND');
    const res = await c.call('POST', '/v1/beneficiaries/resolve', { alias: '300 123 4567' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      alias: '3001234567',
      holderName: 'JUAN P***Z',
      holderNameFull: 'Juan Pérez',
      documentType: 'CC',
      documentMasked: '****4321',
      bankName: 'Bancolombia',
    });
    const ben = await c.signed('POST', '/v1/beneficiaries', { resolutionId: res.body.resolutionId, nickname: 'Juan' });
    expect(ben.status).toBe(201);
    expect(ben.body).toMatchObject({ status: 'active', holderName: 'Juan Pérez', nickname: 'Juan', aml: { provider: 'sartblock', result: 'clear' } });
    expect((await c.call('GET', '/v1/beneficiaries')).body.items).toHaveLength(1);

    // 7) Envío
    const preview = await c.call('POST', '/v1/transfers/preview', { beneficiaryId: ben.body.id, amountMinor: 5_000_000 });
    expect(preview.body).toMatchObject({ amountMinor: 5_000_000, feeMinor: 0, totalMinor: 5_000_000, currency: 'COP' });
    expect(preview.body.limits.items.find((i: any) => i.operation === 'transfer_out' && i.period === 'daily')).toBeTruthy(); // eslint-disable-line @typescript-eslint/no-explicit-any
    const tr = await c.signed('POST', '/v1/transfers', {
      beneficiaryId: ben.body.id,
      amountMinor: 5_000_000,
      description: 'Arriendo',
      idempotencyKey: randomUUID(),
    });
    expect(tr.status).toBe(201);
    expect(tr.body).toMatchObject({
      type: 'transfer',
      direction: 'out',
      currency: 'COP',
      amountMinor: 5_000_000,
      status: 'completed',
      title: 'Juan',
      subtitle: 'Bre-B · 3001234567',
    });
    expect(tr.body.conversion).toBeUndefined();

    // 8) Conversión COP → BRL
    const rate = await c.call('GET', '/v1/fx/rate?from=COP&to=BRL');
    expect(rate.body).toMatchObject({ from: 'COP', to: 'BRL' });
    expect(rate.body.history).toHaveLength(30);
    expect(rate.body.rate).toBeGreaterThan(0.0012);
    expect(rate.body.rate).toBeLessThan(0.0014);
    const quote = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 100_000_000 });
    expect(quote.body).toMatchObject({ fromCurrency: 'COP', toCurrency: 'BRL', fromAmountMinor: 100_000_000, feeMinor: 1_000_000 });
    const expectedTo = Math.floor(Number((BigInt(99_000_000) * BigInt(Math.round(quote.body.rate * 1e10))) / 10n ** 10n));
    expect(quote.body.toAmountMinor).toBe(expectedTo);
    const conv = await c.signed('POST', '/v1/fx/conversions', { quoteId: quote.body.quoteId, idempotencyKey: randomUUID() });
    expect(conv.status).toBe(201);
    expect(conv.body).toMatchObject({
      type: 'conversion',
      currency: 'COP',
      amountMinor: 100_000_000,
      feeMinor: 1_000_000,
      status: 'completed',
      conversion: { fromCurrency: 'COP', fromAmountMinor: 100_000_000, toCurrency: 'BRL', toAmountMinor: quote.body.toAmountMinor, rate: quote.body.rate },
    });

    wallets = (await c.call('GET', '/v1/wallets')).body.items;
    expect(wallets[0]).toEqual({ currency: 'COP', balanceMinor: 95_000_000, availableMinor: 95_000_000, heldMinor: 0 });
    expect(wallets[1]).toEqual({ currency: 'BRL', balanceMinor: quote.body.toAmountMinor, availableMinor: quote.body.toAmountMinor, heldMinor: 0 });

    // 9) Feed: 3 movimientos, conversión una sola vez; filtros y cursor
    const feed = await c.call('GET', '/v1/transactions?limit=2');
    expect(feed.body.items.map((t: any) => t.type)).toEqual(['conversion', 'transfer']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(feed.body.nextCursor).toBeTruthy();
    const page2 = await c.call('GET', `/v1/transactions?limit=2&cursor=${feed.body.nextCursor}`);
    expect(page2.body.items.map((t: any) => t.type)).toEqual(['deposit']); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(page2.body.items[0]).toMatchObject({ direction: 'in', title: 'Carlos Ramírez', subtitle: `Bre-B · ${key.body.alias}` });
    expect(page2.body.nextCursor).toBeNull();
    const brlFeed = await c.call('GET', '/v1/transactions?currency=BRL');
    expect(brlFeed.body.items).toHaveLength(1);

    // 10) Límites reflejan el uso
    const limits = (await c.call('GET', '/v1/limits')).body;
    expect(limits).toMatchObject({ tier: 'full', currency: 'COP' });
    const used = (op: string, p: string) => limits.items.find((i: any) => i.operation === op && i.period === p)?.usedMinor; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(used('transfer_out', 'daily')).toBe(5_000_000);
    expect(used('conversion', 'daily')).toBe(100_000_000);
    expect(used('deposit_in', 'monthly')).toBe(200_000_000);

    // 11) Libro mayor balanceado por moneda
    const entries = await env.container.deps.repos.ledger.allEntries();
    for (const cur of ['COP', 'BRL']) {
      expect(entries.filter((e) => e.currency === cur).reduce((s, e) => s + e.amountMinor, 0n)).toBe(0n);
    }

    // 12) Eliminar beneficiario
    expect((await c.signed('DELETE', `/v1/beneficiaries/${ben.body.id}`)).status).toBe(204);
    expect((await c.call('GET', '/v1/beneficiaries')).body.items).toHaveLength(0);
  });

  it('errores con el formato del contrato y /health', async () => {
    const h = await env.app.inject({ method: 'GET', url: '/health' });
    expect(h.json()).toMatchObject({ ok: true });
    const r = await env.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '3001234567' } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: expect.any(String), details: expect.any(Object) } });
    const nf = await env.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(nf.json().error.code).toBe('NOT_FOUND');
    const unauth = await env.app.inject({ method: 'GET', url: '/v1/me' });
    expect(unauth.json().error.code).toBe('UNAUTHORIZED');
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect(h.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('re-registro con el mismo teléfono vincula un nuevo dispositivo a la misma cuenta', async () => {
    const a = await registerUser(env, { phone: '+573005550000' });
    const b = await registerUser(env, { phone: '+573005550000' });
    expect(b.session.userId).toBe(a.session.userId);
    expect(b.session.deviceId).not.toBe(a.session.deviceId);
    expect((await b.call('GET', '/v1/devices')).body.items).toHaveLength(2);
  });

  it('rate limit en rutas de auth', async () => {
    const limited = await makeEnv({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await limited.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone: '+573001112233' } })).statusCode);
      }
      expect(codes).toEqual([200, 200, 200, 429]);
    } finally {
      await limited.close();
    }
  });
});
