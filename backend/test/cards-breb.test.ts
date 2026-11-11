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

  it('permite cancelar una tarjeta y crear una nueva, asignando titulares individuales por usuario desde Sumsub', async () => {
    const userAClient = await registerUser(env, { firstName: 'Bryan', lastName: 'Ortiz', phone: '+573154103795' });
    const userBClient = await registerUser(env, { firstName: 'Camila', lastName: 'Rojas', phone: '+573009998877' });

    for (const cl of [userAClient, userBClient]) {
      // Inicia KYC para registrar el applicant en Sumsub y aprueba el usuario
      const kycTok = await cl.call('POST', '/v1/kyc/sumsub/token');
      expect(kycTok.status).toBe(200);
      const u = (await env.container.deps.repos.users.byId(cl.session.userId))!;
      u.kycStatus = 'approved';
      await env.container.deps.repos.users.update(u);
    }

    // Usuario A emite tarjeta 1
    const cardA1Res = await userAClient.signed('POST', '/v1/cards/virtual', { label: 'Tarjeta A1' });
    expect(cardA1Res.status).toBe(201);
    expect(cardA1Res.body.holderName).toBe('Bryan Ortiz');

    // Cancelar tarjeta A1 y crear inmediatamente una nueva tarjeta A2
    const cancelRes = await userAClient.signed('PUT', `/v1/cards/${cardA1Res.body.id}/status`, { state: 'canceled' });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('canceled');

    const cardA2Res = await userAClient.signed('POST', '/v1/cards/virtual', { label: 'Tarjeta A2 Nueva' });
    expect(cardA2Res.status).toBe(201);
    expect(cardA2Res.body.id).not.toBe(cardA1Res.body.id);
    expect(cardA2Res.body.status).toBe('active');
    expect(cardA2Res.body.holderName).toBe('Bryan Ortiz');

    // Usuario B emite su propia tarjeta y queda a nombre de Camila Rojas, nunca de Bryan Ortiz
    const cardBRes = await userBClient.signed('POST', '/v1/cards/virtual', { label: 'Tarjeta Camila' });
    expect(cardBRes.status).toBe(201);
    expect(cardBRes.body.holderName).toBe('Camila Rojas');

    const storedCardA2 = (await env.container.deps.repos.cards.byId(cardA2Res.body.id))!;
    const storedCardB = (await env.container.deps.repos.cards.byId(cardBRes.body.id))!;
    expect(storedCardA2.providerCardHolderId).toBeTruthy();
    expect(storedCardB.providerCardHolderId).toBeTruthy();
    expect(storedCardA2.providerCardHolderId).not.toBe(storedCardB.providerCardHolderId);
  });
});
