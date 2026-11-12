import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PHONE, seedDemo } from '../src/scripts/seed.js';
import { makeEnv, registerUser, type TestEnv } from './helpers.js';

describe('seed demo', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('crea la usuaria demo con saldos y la app iOS puede vincularse con el teléfono demo', async () => {
    await seedDemo(env.container);
    await seedDemo(env.container); // idempotente
    const c = await registerUser(env, { phone: DEMO_PHONE });
    const me = (await c.call('GET', '/v1/me')).body;
    expect(me).toMatchObject({ firstName: 'Ana', kycStatus: 'approved', tier: 'full' });
    const wallets = (await c.call('GET', '/v1/wallets')).body.items;
    expect(wallets).toEqual([
      { currency: 'COP', balanceMinor: 125_000_000, availableMinor: 120_000_000, heldMinor: 5_000_000 },
      { currency: 'BRL', balanceMinor: 180_221, availableMinor: 180_221, heldMinor: 0 },
    ]);
    expect((await c.call('GET', '/v1/breb/key')).body.alias).toBe('@cuypayana123');
    expect((await c.call('GET', '/v1/beneficiaries')).body.items[0]).toMatchObject({ holderName: 'Juan Pérez', status: 'active' });
    const feed = (await c.call('GET', '/v1/transactions')).body.items;
    expect(feed.map((t: { type: string; status: string }) => `${t.type}:${t.status}`)).toEqual([
      'transfer:pending',
      'conversion:completed',
      'transfer:completed',
      'deposit:completed',
      'deposit:completed',
      'deposit:completed',
    ]);
    const entries = await env.container.deps.repos.ledger.allEntries();
    expect(entries.reduce((s, e) => s + e.amountMinor, 0n)).toBe(0n);
  });

  it('rutas dev: aprobar KYC y simular depósito con llave genérica del sistema', async () => {
    const c = await registerUser(env);
    expect((await c.call('POST', '/v1/dev/kyc/approve')).body.status).toBe('approved');
    const created = await c.signed('POST', '/v1/breb/key', { preferredAlias: 'miLlave01' });
    expect(created.status).toBe(200);
    // Incluso si un cliente envía preferredAlias, el sistema siempre genera una llave genérica automática
    expect(created.body.alias).toMatch(/^@cuypay\d{6}$/);
    expect((await c.call('GET', '/v1/breb/key')).body.alias).toBe(created.body.alias);
    const dep = await c.call('POST', '/v1/dev/deposits/simulate', { amountMinor: 1_000_000, payerName: 'Tía Rosa' });
    expect(dep.status).toBe(201);
    expect(dep.body).toMatchObject({ type: 'deposit', direction: 'in', amountMinor: 1_000_000, title: 'Tía Rosa' });
    // un segundo usuario también recibe su propia llave genérica única sin colisión
    const other = await registerUser(env);
    await other.call('POST', '/v1/dev/kyc/approve');
    const otherKey = await other.signed('POST', '/v1/breb/key', {});
    expect(otherKey.status).toBe(200);
    expect(otherKey.body.alias).toMatch(/^@cuypay\d{6}$/);
    expect(otherKey.body.alias).not.toBe(created.body.alias);
  });
});
