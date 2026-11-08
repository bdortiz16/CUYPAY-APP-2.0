import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addBeneficiary, fundedUser, makeEnv, type TestEnv } from './helpers.js';

describe('FX: cotizaciones y conversiones', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('cotización vencida (30 s) → QUOTE_EXPIRED; usada → QUOTE_EXPIRED', async () => {
    const c = await fundedUser(env, 200_000_000n);
    const q = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect(new Date(q.body.expiresAt).getTime() - env.clock.now().getTime()).toBe(30_000);
    env.clock.advanceSeconds(31);
    const r = await c.signed('POST', '/v1/fx/conversions', { quoteId: q.body.quoteId, idempotencyKey: randomUUID() });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'QUOTE_EXPIRED', details: { reason: 'expired' } });

    const q2 = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect((await c.signed('POST', '/v1/fx/conversions', { quoteId: q2.body.quoteId, idempotencyKey: randomUUID() })).status).toBe(201);
    const reuse = await c.signed('POST', '/v1/fx/conversions', { quoteId: q2.body.quoteId, idempotencyKey: randomUUID() });
    expect(reuse.body.error).toMatchObject({ code: 'QUOTE_EXPIRED', details: { reason: 'used' } });
  });

  it('solo COP→BRL en fase 1', async () => {
    const c = await fundedUser(env, 0n);
    const r = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'BRL', toCurrency: 'COP', amountMinor: 10_000 });
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect((await c.call('GET', '/v1/fx/rate?from=BRL&to=COP')).body.error.code).toBe('VALIDATION_ERROR');
  });

  it('proveedor BRL caído → PROVIDER_ERROR sin mover saldos', async () => {
    const c = await fundedUser(env, 50_000_000n);
    const q = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    env.brl.failNext = true;
    const r = await c.signed('POST', '/v1/fx/conversions', { quoteId: q.body.quoteId, idempotencyKey: randomUUID() });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('PROVIDER_ERROR');
    expect((await c.call('GET', '/v1/wallets')).body.items[0].availableMinor).toBe(50_000_000);
  });
});

describe('idempotencia', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('conversión: misma clave + mismo cuerpo → mismo resultado; otro cuerpo → IDEMPOTENCY_CONFLICT', async () => {
    const c = await fundedUser(env, 200_000_000n);
    const q = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    const key = randomUUID();
    const a = await c.signed('POST', '/v1/fx/conversions', { quoteId: q.body.quoteId, idempotencyKey: key });
    const b = await c.signed('POST', '/v1/fx/conversions', { quoteId: q.body.quoteId, idempotencyKey: key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect((await c.call('GET', '/v1/wallets')).body.items[0].balanceMinor).toBe(190_000_000);
    expect(env.brl.executions).toHaveLength(1);

    const q2 = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    const conflict = await c.signed('POST', '/v1/fx/conversions', { quoteId: q2.body.quoteId, idempotencyKey: key });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('envío: reintentos concurrentes con la misma clave no duplican el retiro', async () => {
    const c = await fundedUser(env, 100_000_000n);
    const ben = (await addBeneficiary(c)).body;
    const body = { beneficiaryId: ben.id, amountMinor: 2_000_000, idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([c.signed('POST', '/v1/transfers', body), c.signed('POST', '/v1/transfers', body)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect(env.coinsenda.withdraws.size).toBe(1);
    expect((await c.call('GET', '/v1/wallets')).body.items[0].balanceMinor).toBe(98_000_000);

    const other = await c.signed('POST', '/v1/transfers', { ...body, amountMinor: 3_000_000 });
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('error de negocio libera la clave (se puede reintentar)', async () => {
    const c = await fundedUser(env, 1_000_000n);
    const ben = (await addBeneficiary(c)).body;
    const body = { beneficiaryId: ben.id, amountMinor: 2_000_000, idempotencyKey: randomUUID() };
    expect((await c.signed('POST', '/v1/transfers', body)).body.error.code).toBe('INSUFFICIENT_FUNDS');
    const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
    env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 5_000_000n });
    await env.container.services.deposits.poll();
    expect((await c.signed('POST', '/v1/transfers', body)).status).toBe(201);
  });
});

describe('envíos: fallas del proveedor y estados', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('Coinsenda falla → se revierte la retención, tx failed, límites liberados; el reintento devuelve el mismo error', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const ben = (await addBeneficiary(c)).body;
    env.coinsenda.failNextWithdraw = true;
    const body = { beneficiaryId: ben.id, amountMinor: 4_000_000, idempotencyKey: randomUUID() };
    const r = await c.signed('POST', '/v1/transfers', body);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('PROVIDER_ERROR');
    const txnId = r.body.error.details.transactionId;
    expect(txnId).toMatch(/^txn_/);
    expect((await c.call('GET', '/v1/wallets')).body.items[0]).toMatchObject({ balanceMinor: 10_000_000, availableMinor: 10_000_000, heldMinor: 0 });
    const feed = (await c.call('GET', '/v1/transactions')).body.items;
    expect(feed[0]).toMatchObject({ id: txnId, status: 'failed' });
    const limits = (await c.call('GET', '/v1/limits')).body.items;
    expect(limits.find((i: any) => i.operation === 'transfer_out' && i.period === 'daily').usedMinor).toBe(0); // eslint-disable-line @typescript-eslint/no-explicit-any
    const retry = await c.signed('POST', '/v1/transfers', body);
    expect(retry.body.error).toMatchObject({ code: 'PROVIDER_ERROR', details: { transactionId: txnId } });
  });

  it('retiro pendiente queda retenido y el job lo liquida o revierte', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const ben = (await addBeneficiary(c)).body;
    env.coinsenda.confirmResultState = 'confirmed';
    const a = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.id, amountMinor: 3_000_000, idempotencyKey: randomUUID() });
    const b = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.id, amountMinor: 2_000_000, idempotencyKey: randomUUID() });
    expect(a.body.status).toBe('pending');
    expect((await c.call('GET', '/v1/wallets')).body.items[0]).toMatchObject({ balanceMinor: 10_000_000, availableMinor: 5_000_000, heldMinor: 5_000_000 });

    const txA = await env.container.deps.repos.transactions.byId(a.body.id);
    const txB = await env.container.deps.repos.transactions.byId(b.body.id);
    env.coinsenda.setWithdrawState(txA!.providerRef!, 'accepted');
    env.coinsenda.setWithdrawState(txB!.providerRef!, 'rejected');
    expect(await env.container.services.transfers.syncPending()).toBe(2);
    expect((await c.call('GET', '/v1/wallets')).body.items[0]).toMatchObject({ balanceMinor: 7_000_000, availableMinor: 7_000_000, heldMinor: 0 });
    const feed = (await c.call('GET', '/v1/transactions')).body.items;
    expect(feed.find((t: any) => t.id === a.body.id).status).toBe('completed'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(feed.find((t: any) => t.id === b.body.id).status).toBe('failed'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});
