import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, registerUser, type TestEnv } from './helpers.js';

describe('Card & Bre-B lifecycle endpoints', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('allows user to manage Bre-B keys and cards with proper authorization', async () => {
    // 1. Registro con KYC aprobado
    const c = await registerUser(env, { firstName: 'Carlos', lastName: 'Pérez' });
    const user = (await env.container.deps.repos.users.byId(c.session.userId))!;
    user.kycStatus = 'approved';
    await env.container.deps.repos.users.update(user);

    // 2. Bre-B Key: crear llave preferida
    const createKeyRes = await c.signed('POST', '/v1/breb/key', { preferredAlias: 'carlos123' });
    expect(createKeyRes.status).toBe(200);
    expect(createKeyRes.body.alias).toBe('@carlos123');

    // Cambiar llave
    const changeKeyRes = await c.signed('PUT', '/v1/breb/key', { preferredAlias: 'carlosperez' });
    expect(changeKeyRes.status).toBe(200);
    expect(changeKeyRes.body.alias).toBe('@carlosperez');

    // 3. Tarjetas: listar (inicialmente vacío)
    const listCardsRes = await c.call('GET', '/v1/cards');
    expect(listCardsRes.status).toBe(200);
    expect(listCardsRes.body.items).toEqual([]);

    // 4. Emitir tarjeta virtual
    const issueRes = await c.signed('POST', '/v1/cards/virtual', { label: 'Mi Tarjeta CuyPay' });
    expect(issueRes.status).toBe(201);
    const card = issueRes.body;
    expect(card.id).toBeDefined();
    expect(card.status).toBe('active');
    expect(card.label).toBe('Mi Tarjeta CuyPay');
    expect(card.lastFour).toBe('4242');

    // 5. Look-URL
    const lookRes = await c.call('GET', `/v1/cards/${card.id}/look-url`);
    expect(lookRes.status).toBe(200);
    expect(lookRes.body.url).toContain('look');

    // 6. Congelar tarjeta
    const freezeRes = await c.signed('PUT', `/v1/cards/${card.id}/status`, { state: 'frozen' });
    expect(freezeRes.status).toBe(200);
    expect(freezeRes.body.status).toBe('frozen');

    // 7. Renombrar
    const renameRes = await c.call('PUT', `/v1/cards/${card.id}/label`, { label: 'Tarjeta Viajes' });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.label).toBe('Tarjeta Viajes');

    // 8. Apple Pay tokenize
    // Reactivar primero
    await c.signed('PUT', `/v1/cards/${card.id}/status`, { state: 'active' });

    const applePayRes = await c.signed('POST', `/v1/cards/${card.id}/apple-pay/tokenize`, {
      certificates: ['cert1', 'cert2'],
      nonce: 'nonce123',
      nonceSignature: 'sig123',
    });
    expect(applePayRes.status).toBe(200);
    expect(applePayRes.body.activationData).toBeDefined();

    // 9. /me/security endpoint
    const secRes = await c.call('GET', '/v1/me/security');
    expect(secRes.status).toBe(200);
    expect(secRes.body.autoLockSeconds).toBe(60);

    // 10. Eliminar llave Bre-B
    const delKeyRes = await c.signed('DELETE', '/v1/breb/key', {});
    expect(delKeyRes.status).toBe(204);
  });

  it('syncs card lastFour and brand automatically when initially stored as 0000', async () => {
    const c = await registerUser(env, { firstName: 'Bryan', lastName: 'Ortiz' });
    const user = (await env.container.deps.repos.users.byId(c.session.userId))!;
    user.kycStatus = 'approved';
    await env.container.deps.repos.users.update(user);

    const issueRes = await c.signed('POST', '/v1/cards/virtual', { label: 'CuyPay Virtual' });
    expect(issueRes.status).toBe(201);
    const created = (await env.container.deps.repos.cards.byId(issueRes.body.id))!;
    created.lastFour = '0000';
    created.brand = 'Mastercard';
    await env.container.deps.repos.cards.update(created);

    env.container.deps.coinsenda.getProviderCards = async () => [
      {
        providerCardId: created.providerCardId,
        lastFour: '6187',
        brand: 'Visa',
        status: 'active',
        label: 'CuyPay Virtual',
      },
    ];

    const listRes = await c.call('GET', '/v1/cards');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items[0].lastFour).toBe('6187');
    expect(listRes.body.items[0].brand).toBe('Visa');
  });
});
