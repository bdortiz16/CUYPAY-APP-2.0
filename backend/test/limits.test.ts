import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { addBeneficiary, fundedUser, makeEnv, type TestEnv } from './helpers.js';

/** Límites pequeños para probar cada periodo. */
const LIMITS = JSON.stringify({
  basic: [],
  full: [
    { operation: 'transfer_out', period: 'daily', limitMinor: 10_000_000 },
    { operation: 'transfer_out', period: 'monthly', limitMinor: 25_000_000 },
    { operation: 'transfer_out', period: 'annual', limitMinor: 40_000_000 },
    { operation: 'conversion', period: 'daily', limitMinor: 50_000_000 },
    { operation: 'deposit_in', period: 'monthly', limitMinor: 600_000_000 },
  ],
});

describe('límites diarios / mensuales / anuales (America/Bogota)', () => {
  let env: TestEnv;
  afterEach(() => env.close());

  const send = (c: Awaited<ReturnType<typeof fundedUser>>, benId: string, amount: number) =>
    c.signed('POST', '/v1/transfers', { beneficiaryId: benId, amountMinor: amount, idempotencyKey: randomUUID() });

  it('daily → monthly → annual con reloj simulado', async () => {
    env = await makeEnv({ LIMITS_CONFIG_JSON: LIMITS, ACCESS_TOKEN_TTL_SECONDS: '400000000' });
    // 2026-11-07 10:00 Bogotá
    const c = await fundedUser(env, 500_000_000n);
    const ben = (await addBeneficiary(c)).body;

    expect((await send(c, ben.id, 8_000_000)).status).toBe(201);
    const daily = await send(c, ben.id, 3_000_000);
    expect(daily.status).toBe(422);
    expect(daily.body.error).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: { operation: 'transfer_out', period: 'daily', limitMinor: 10_000_000, usedMinor: 8_000_000, remainingMinor: 2_000_000 },
    });
    // El preview también advierte
    expect((await c.call('POST', '/v1/transfers/preview', { beneficiaryId: ben.id, amountMinor: 3_000_000 })).body.error.code).toBe('LIMIT_EXCEEDED');

    // 23:59 Bogotá del mismo día (04:59Z del día siguiente) → sigue siendo "hoy"
    env.clock.set('2026-11-08T04:59:00Z');
    expect((await send(c, ben.id, 3_000_000)).body.error.details.period).toBe('daily');

    // 00:01 Bogotá del día siguiente → nuevo día
    env.clock.set('2026-11-08T05:01:00Z');
    expect((await send(c, ben.id, 10_000_000)).status).toBe(201);
    env.clock.set('2026-11-09T15:00:00Z');
    expect((await send(c, ben.id, 7_000_000)).status).toBe(201); // mes: 25M usados
    const monthly = await send(c, ben.id, 1_000_000);
    expect(monthly.body.error.details).toMatchObject({ period: 'monthly', usedMinor: 25_000_000, remainingMinor: 0 });

    // Nuevo mes → cuenta el anual (40M)
    env.clock.set('2026-12-01T15:00:00Z');
    expect((await send(c, ben.id, 10_000_000)).status).toBe(201); // anual: 35M
    env.clock.set('2026-12-02T15:00:00Z');
    const annual = await send(c, ben.id, 6_000_000);
    expect(annual.body.error.details).toMatchObject({ period: 'annual', usedMinor: 35_000_000, remainingMinor: 5_000_000 });

    // Nuevo año (en Bogotá) → se reinicia
    env.clock.set('2027-01-01T05:30:00Z');
    expect((await send(c, ben.id, 6_000_000)).status).toBe(201);

    const snap = (await c.call('GET', '/v1/limits')).body;
    const tDaily = snap.items.find((i: any) => i.operation === 'transfer_out' && i.period === 'daily'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(tDaily).toEqual({ operation: 'transfer_out', period: 'daily', limitMinor: 10_000_000, usedMinor: 6_000_000 });
  });

  it('límite de conversión y saldo insuficiente', async () => {
    env = await makeEnv({ LIMITS_CONFIG_JSON: LIMITS, ACCESS_TOKEN_TTL_SECONDS: '400000000' });
    const c = await fundedUser(env, 60_000_000n);
    const q = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 55_000_000 });
    const r = await c.signed('POST', '/v1/fx/conversions', { quoteId: q.body.quoteId, idempotencyKey: randomUUID() });
    expect(r.body.error).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { operation: 'conversion', period: 'daily' } });

    const ben = (await addBeneficiary(c)).body;
    const nsf = await c.call('POST', '/v1/transfers/preview', { beneficiaryId: ben.id, amountMinor: 9_000_000 });
    expect(nsf.status).toBe(200);
    const q2 = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 45_000_000 });
    expect((await c.signed('POST', '/v1/fx/conversions', { quoteId: q2.body.quoteId, idempotencyKey: randomUUID() })).status).toBe(201);
    // Quedan 15M COP; un envío de 9M pasa, otro de 9M no tiene fondos (antes que el límite diario de 10M... también)
    expect((await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.id, amountMinor: 9_000_000, idempotencyKey: randomUUID() })).status).toBe(201);
    env.clock.advance(86_400_000);
    const r2 = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.id, amountMinor: 9_000_000, idempotencyKey: randomUUID() });
    expect(r2.body.error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('depósito que supera deposit_in se acredita pero queda marcado', async () => {
    env = await makeEnv({ LIMITS_CONFIG_JSON: LIMITS, ACCESS_TOKEN_TTL_SECONDS: '400000000' });
    const c = await fundedUser(env, 500_000_000n);
    const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
    env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 200_000_000n });
    await env.container.services.deposits.poll();
    const wallets = (await c.call('GET', '/v1/wallets')).body.items;
    expect(wallets[0].balanceMinor).toBe(700_000_000);
    const txns = await env.container.deps.repos.transactions.listByUser(c.session.userId, { limit: 10 });
    expect(txns[0]!.flagged).toBe(true);
    expect(txns[1]!.flagged).toBe(false);
  });
});
