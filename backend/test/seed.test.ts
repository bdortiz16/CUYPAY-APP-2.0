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

  it('rutas dev: aprobar KYC y simular depósito', async () => {
    const c = await registerUser(env);
    expect((await c.call('POST', '/v1/dev/kyc/approve')).body.status).toBe('approved');
    await c.signed('POST', '/v1/breb/key', { preferredAlias: 'miLlave01' });
    expect((await c.call('GET', '/v1/breb/key')).body.alias).toBe('@millave01');
    const dep = await c.call('POST', '/v1/dev/deposits/simulate', { amountMinor: 1_000_000, payerName: 'Tía Rosa' });
    expect(dep.status).toBe(201);
    expect(dep.body).toMatchObject({ type: 'deposit', direction: 'in', amountMinor: 1_000_000, title: 'Tía Rosa' });
    // llave tomada
    const other = await registerUser(env);
    await other.call('POST', '/v1/dev/kyc/approve');
    expect((await other.signed('POST', '/v1/breb/key', { preferredAlias: '@millave01' })).body.error.code).toBe('BREB_ALIAS_TAKEN');
  });
});
