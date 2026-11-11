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

  it('permite actualizar correo, celular y nombre con PUT /v1/me y regenera el CardHolder al reemplazar la tarjeta', async () => {
    // Dos usuarios legacy registrados con el correo placeholder 'usuario@cuypay.com' no colisionan
    const legacy1 = await registerUser(env, {
      firstName: 'Usuario',
      lastName: 'CuyPay',
      email: 'usuario@cuypay.com',
      phone: '+573005182067',
    });
    const legacy2 = await registerUser(env, {
      firstName: 'Usuario',
      lastName: 'CuyPay',
      email: 'usuario@cuypay.com',
      phone: '+573005182068',
    });
    const me1 = (await legacy1.call('GET', '/v1/me')).body;
    const me2 = (await legacy2.call('GET', '/v1/me')).body;
    expect(me1.email).toMatch(/@pendiente\.cuypay\.com$/);
    expect(me2.email).toMatch(/@pendiente\.cuypay\.com$/);
    expect(me1.email).not.toBe(me2.email);

    const u1 = (await env.container.deps.repos.users.byId(legacy1.session.userId))!;
    u1.kycStatus = 'approved';
    await env.container.deps.repos.users.update(u1);

    // Emitir tarjeta inicial (antes de actualizar perfil)
    const oldCardRes = await legacy1.signed('POST', '/v1/cards/virtual', { label: 'CuyPay Virtual' });
    expect(oldCardRes.status).toBe(201);
    const oldStoredCard = (await env.container.deps.repos.cards.byId(oldCardRes.body.id))!;

    // Rechaza guardar usuario@cuypay.com como correo real
    const badEmailRes = await legacy1.call('PUT', '/v1/me', { email: 'usuario@cuypay.com' });
    expect(badEmailRes.status).toBe(400);

    // Actualiza datos reales del cliente (nombre, correo y celular donde llegan códigos de Apple Pay)
    const updateRes = await legacy1.call('PUT', '/v1/me', {
      firstName: 'Andrés',
      lastName: 'Martínez',
      email: 'andres.martinez@gmail.com',
      phone: '+573154103799',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body).toMatchObject({
      firstName: 'Andrés',
      lastName: 'Martínez',
      email: 'andres.martinez@gmail.com',
      phone: '+573154103799',
    });

    // Cancela tarjeta anterior y emite una nueva tarjeta vinculada al correo y celular reales
    const cancelRes = await legacy1.signed('PUT', `/v1/cards/${oldCardRes.body.id}/status`, { state: 'canceled' });
    expect(cancelRes.status).toBe(200);

    const newCardRes = await legacy1.signed('POST', '/v1/cards/virtual', { label: 'CuyPay Virtual' });
    expect(newCardRes.status).toBe(201);
    expect(newCardRes.body.holderName).toBe('Andrés Martínez');

    const newStoredCard = (await env.container.deps.repos.cards.byId(newCardRes.body.id))!;
    expect(newStoredCard.providerCardHolderId).toBeTruthy();
    expect(newStoredCard.providerCardHolderId).not.toBe(oldStoredCard.providerCardHolderId);
  });

  it('gestiona el bolsillo de tarjeta (recarga desde Bre-B, retiro a principal, compras, reemplazo y devolución)', async () => {
    const { fundedUser } = await import('./helpers.js');
    // Usuario con $100.000 COP ($100.000 * 100 = 10_000_000 minor) en su cuenta principal Bre-B
    const c = await fundedUser(env, 10_000_000n, {
      firstName: 'Bryan',
      lastName: 'Ortiz',
      email: 'bryan.pocket@gmail.com',
      phone: '+573154103795',
    });

    // 1. Emitir tarjeta virtual -> bolsillo inicia en $0 COP
    const issueRes = await c.signed('POST', '/v1/cards/virtual', { label: 'CuyPay Virtual' });
    expect(issueRes.status).toBe(201);
    const card1 = issueRes.body;
    expect(card1.balanceMinor).toBe(0);
    expect(card1.availableMinor).toBe(0);

    const pocketInit = await c.call('GET', '/v1/cards/pocket');
    expect(pocketInit.status).toBe(200);
    expect(pocketInit.body).toEqual({
      currency: 'COP',
      balanceMinor: 0,
      availableMinor: 0,
      mainAvailableMinor: 10_000_000,
    });

    // 2. Rechaza recarga superior al saldo principal Bre-B
    const overFund = await c.signed('POST', `/v1/cards/${card1.id}/fund`, {
      amountMinor: 15_000_000,
      idempotencyKey: 'idem_over_fund_1234',
    });
    expect(overFund.status).toBe(422);
    expect(overFund.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // 3. Recarga $45.000 COP (4_500_000 minor) sin costo y verifica idempotencia
    const fundRes = await c.signed('POST', `/v1/cards/${card1.id}/fund`, {
      amountMinor: 4_500_000,
      idempotencyKey: 'idem_fund_45k_0001',
    });
    expect(fundRes.status).toBe(200);
    expect(fundRes.body.pocketBalanceMinor).toBe(4_500_000);
    expect(fundRes.body.mainAvailableMinor).toBe(5_500_000);
    expect(fundRes.body.card.availableMinor).toBe(4_500_000);
    expect(fundRes.body.transaction).toMatchObject({
      type: 'card_pocket',
      direction: 'out',
      amountMinor: 4_500_000,
      feeMinor: 0,
      status: 'completed',
    });

    // Replay idempotente no duplica el cargo
    const fundReplay = await c.signed('POST', `/v1/cards/${card1.id}/fund`, {
      amountMinor: 4_500_000,
      idempotencyKey: 'idem_fund_45k_0001',
    });
    expect(fundReplay.status).toBe(200);
    expect(fundReplay.body.transaction.id).toBe(fundRes.body.transaction.id);
    expect(fundReplay.body.mainAvailableMinor).toBe(5_500_000);

    // Verifica que el gateway mock registró la transferencia interna y actualizó el tope de gasto
    const storedCard1 = (await env.container.deps.repos.cards.byId(card1.id))!;
    expect(env.coinsenda.cardPocketTransfers).toHaveLength(1);
    expect(env.coinsenda.cardPocketTransfers[0]).toMatchObject({
      direction: 'to_card',
      amountMinor: 4_500_000n,
    });
    expect(env.coinsenda.cardSpendingLimits.get(storedCard1.providerCardId)).toBe(4_500_000n);

    // 4. Retirar $15.000 COP (1_500_000 minor) de vuelta al saldo principal Bre-B
    const withdrawRes = await c.signed('POST', `/v1/cards/${card1.id}/withdraw`, {
      amountMinor: 1_500_000,
      idempotencyKey: 'idem_withdraw_15k_1',
    });
    expect(withdrawRes.status).toBe(200);
    expect(withdrawRes.body.pocketBalanceMinor).toBe(3_000_000);
    expect(withdrawRes.body.mainAvailableMinor).toBe(7_000_000);
    expect(withdrawRes.body.transaction).toMatchObject({
      type: 'card_pocket',
      direction: 'in',
      amountMinor: 1_500_000,
      feeMinor: 0,
      status: 'completed',
    });

    // 5. Simular una compra con tarjeta de $12.000 COP (1_200_000 minor) y sincronizar poller
    env.coinsenda.simulateCardPurchase({
      providerCardId: storedCard1.providerCardId,
      amountMinor: 1_200_000n,
      merchantName: 'Spotify Colombia',
    });
    const synced = await env.container.services.cards.syncPurchases();
    expect(synced).toBe(1);

    const afterPurchaseCards = await c.call('GET', '/v1/cards');
    expect(afterPurchaseCards.body.items[0].availableMinor).toBe(1_800_000);

    const txPage = await c.call('GET', '/v1/transactions?limit=10');
    expect(txPage.body.items.some((t: any) => t.type === 'card_purchase' && t.title === 'Spotify Colombia' && t.amountMinor === 1_200_000)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any

    // La conciliación de tesorería permanece 100% cuadrada sin quiebres
    const recon = await env.container.services.admin.treasury.reconcile(null, 'card_pocket_test');
    expect(recon.status).toBe('ok');
    expect(recon.breaks).toEqual([]);

    // 6. Reemplazar tarjeta preservando el bolsillo (`preservePocket: true`) mantiene los $18.000 COP
    const cancelKeepRes = await c.signed('PUT', `/v1/cards/${card1.id}/status`, {
      state: 'canceled',
      preservePocket: true,
    });
    expect(cancelKeepRes.status).toBe(200);
    expect(cancelKeepRes.body.availableMinor).toBe(0);
    expect((await c.call('GET', '/v1/cards/pocket')).body.availableMinor).toBe(1_800_000);

    const card2Res = await c.signed('POST', '/v1/cards/virtual', { label: 'CuyPay Nueva' });
    expect(card2Res.status).toBe(201);
    expect(card2Res.body.availableMinor).toBe(1_800_000);

    // 7. Eliminar definitivamente la última tarjeta (`preservePocket` omitido/false) devuelve los $18.000 COP al saldo principal Bre-B
    const cancelRefundRes = await c.signed('PUT', `/v1/cards/${card2Res.body.id}/status`, {
      state: 'canceled',
    });
    expect(cancelRefundRes.status).toBe(200);
    expect(cancelRefundRes.body.availableMinor).toBe(0);

    const finalWallets = await c.call('GET', '/v1/wallets');
    const copWallet = finalWallets.body.items.find((w: any) => w.currency === 'COP'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(copWallet.availableMinor).toBe(8_800_000); // $70.000 + $18.000 devueltos = $88.000 COP
  });

  it('permite eliminar llave Bre-B anterior, crear llave personalizada (@bryan), registrar push-token y sincronizar depósitos con GET /wallets?sync=1', async () => {
    const c = await registerUser(env, { firstName: 'Bryan', lastName: 'Ortiz', phone: '+573154103792' });
    const user = (await env.container.deps.repos.users.byId(c.session.userId))!;
    user.kycStatus = 'approved';
    await env.container.deps.repos.users.update(user);

    // 1. Crea llave genérica, la elimina y verifica que GET /v1/breb/key devuelva 404 (no llave fantasma bloqueada)
    const genericKey = await c.signed('POST', '/v1/breb/key', {});
    expect(genericKey.status).toBe(200);
    const delRes = await c.signed('DELETE', '/v1/breb/key', {});
    expect(delRes.status).toBe(204);
    const afterDel = await c.call('GET', '/v1/breb/key');
    expect(afterDel.status).toBe(404);

    // 2. Crea llave personalizada limpia (incluso si el cliente envía prefijo legado @xatechsericbryan)
    const customKey = await c.signed('POST', '/v1/breb/key', { preferredAlias: '@xatechsericbryan' });
    expect(customKey.status).toBe(200);
    expect(customKey.body.alias).toBe('@bryan');
    expect(customKey.body.status).toBe('active');

    // 3. Registra token APNs del dispositivo
    const pushRes = await c.call('POST', '/v1/me/push-token', {
      token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      environment: 'production',
    });
    expect(pushRes.status).toBe(200);
    expect(pushRes.body).toEqual({ registered: true });

    // 4. Simula depósito entrante con remitente y verifica que GET /v1/wallets?sync=1 lo acredite automáticamente
    const storedKey = (await env.container.deps.repos.brebKeys.byUser(c.session.userId))!;
    env.coinsenda.simulateDeposit({
      providerKeyId: storedKey.providerKeyId,
      amountMinor: 5_000_000n,
      payerName: 'Laura Valentina Ruiz',
    });

    const syncedWallets = await c.call('GET', '/v1/wallets?sync=1');
    expect(syncedWallets.status).toBe(200);
    const cop = syncedWallets.body.items.find((w: any) => w.currency === 'COP'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(cop.availableMinor).toBe(5_000_000);

    const txRes = await c.call('GET', '/v1/transactions?limit=5');
    expect(txRes.status).toBe(200);
    expect(txRes.body.items[0]).toMatchObject({
      type: 'deposit',
      direction: 'in',
      amountMinor: 5_000_000,
      title: 'Laura Valentina Ruiz',
    });
  });
});
