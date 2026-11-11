import { describe, expect, it } from 'vitest';
import { adminCall, adminLogin } from './admin-helpers.js';
import { fundedUser, makeEnv, registerUser } from './helpers.js';

describe('Bolsillo de Ahorro (30-60-90-180-360 días + Bolsillo Recaudo + Reserva 72h + Reintegro Exacto)', () => {
  it('consulta configuración, constituye un bloque, bloquea tasa fija y liquida al vencimiento', async () => {
    const env = await makeEnv();

    // 1. Crear usuario registrado
    const c = await registerUser(env, { firstName: 'Ahorrador', lastName: 'Exitoso' });
    const userId = c.session.userId;

    // Aprobar KYC
    const u = await env.container.deps.repos.users.byId(userId);
    u!.kycStatus = 'approved';
    await env.container.deps.repos.users.update(u!);

    // Cargar saldo: 1,000,000 COP ($1,000,000.00 COP)
    await env.container.services.ledger.post(
      [
        { kind: 'breb_settlement', userId: null, currency: 'COP', amountMinor: -100_000_000n },
        { kind: 'user_available', userId, currency: 'COP', amountMinor: 100_000_000n },
      ],
      'init_funds',
    );

    // 2. Consultar configuración de tasas
    const cfgRes = await env.app.inject({ method: 'GET', url: '/v1/savings/config' });
    expect(cfgRes.statusCode).toBe(200);
    expect(cfgRes.json().rates).toHaveLength(5);
    const tier30 = cfgRes.json().rates.find((r: { termDays: number }) => r.termDays === 30);
    expect(tier30.ratePercent).toBe(3.0);

    // 3. Constituir un bloque de ahorro por $500,000 COP a 30 días
    const lockRes = await c.call('POST', '/v1/savings', { termDays: 30, amountMinor: '50000000' });
    expect(lockRes.status).toBe(201);
    const block = lockRes.body;
    expect(block.termDays).toBe(30);
    expect(block.lockedRate).toBe(3.0);
    expect(block.status).toBe('active');
    expect(block.escrowStatus).toBe('unfunded');

    // Verificar que el saldo disponible bajó a $500,000 COP
    const wallet = await env.container.services.ledger.wallet(userId, 'COP');
    expect(wallet.availableMinor).toBe(50_000_000n);

    // Consultar certificado del bolsillo de ahorro
    const certRes = await c.call('GET', `/v1/savings/${block.id}/certificate`);
    expect(certRes.status).toBe(200);
    expect(certRes.body.holderName).toBe('Ahorrador Exitoso');
    expect(certRes.body.principalMinor).toBe('50000000');

    // 4. Admin cambia la tasa de 30 días de 3.0% a 2.0%
    const newRates = cfgRes.json().rates.map((r: { termDays: number; ratePercent: number; enabled: boolean }) =>
      r.termDays === 30 ? { ...r, ratePercent: 2.0 } : r,
    );
    await env.container.services.savings.updateConfig(newRates, undefined, undefined, undefined, 'admin@cuypay.com');

    // El usuario consulta sus bloques: su tasa debe seguir siendo 3.0% (garantía de tasa fija)
    const myBlocks = await c.call('GET', '/v1/savings');
    expect(myBlocks.status).toBe(200);
    expect(myBlocks.body.blocks[0].lockedRate).toBe(3.0);

    // 5. Alerta de tesorería 72h: avanzar tiempo a faltando 24 horas del vencimiento
    env.clock.advanceSeconds(29 * 24 * 3600); // día 29 de 30
    const alert = await env.container.services.savings.getTreasuryAlerts();
    expect(alert.totalMaturingCount).toBe(1);
    expect(alert.maturingBlocks[0]!.hoursRemaining).toBeLessThanOrEqual(25);

    // 6. Al cumplirse el plazo (día 31), se ejecuta la liquidación automática
    env.clock.advanceSeconds(2 * 24 * 3600);
    const settled = await env.container.services.savings.processMaturities();
    expect(settled.completedCount).toBe(1);

    // El saldo del usuario debe tener su capital original + rendimiento
    const finalWallet = await env.container.services.ledger.wallet(userId, 'COP');
    expect(finalWallet.availableMinor).toBeGreaterThan(100_000_000n);

    await env.close();
  });

  it('opera el flujo completo Admin: Bolsillo Recaudo de Ahorros, retiro para inversión, bloqueo 72h y reintegro en hora exacta sin falsos quiebres de conciliación', async () => {
    const env = await makeEnv();
    const owner = await adminLogin(env, 'owner');
    const c = await fundedUser(env, 120_000_000n, { firstName: 'Valentina', lastName: 'Ríos', email: 'valentina.rios@correo.co' });

    // 1. Cliente bloquea $800,000 COP por 90 días (con firma ECDSA del dispositivo)
    const created = await c.signed('POST', '/v1/savings', { termDays: 90, amountMinor: '80000000' });
    expect(created.status).toBe(201);
    const blockId = created.body.id as string;
    const totalPayoutMinor = BigInt(created.body.totalPayoutMinor);
    expect(totalPayoutMinor).toBeGreaterThan(80_000_000n);

    // 2. Admin consulta el Bolsillo Recaudo de Ahorros y el listado enriquecido con el nombre real del cliente
    const poolInitial = await adminCall(env, owner.token, 'GET', '/v1/admin/savings/pool');
    expect(poolInitial.status).toBe(200);
    expect(poolInitial.body.collectionPoolBalanceMinor).toBe('80000000');
    expect(poolInitial.body.escrowLockedBalanceMinor).toBe('0');

    const adminBlocks = await adminCall(env, owner.token, 'GET', '/v1/admin/savings/blocks');
    expect(adminBlocks.status).toBe(200);
    expect(adminBlocks.body.items[0]).toMatchObject({
      id: blockId,
      customerName: 'Valentina Ríos',
      customerEmail: 'valentina.rios@correo.co',
      termDays: 90,
      escrowStatus: 'unfunded',
    });

    // 3. Admin retira $600,000 COP del Bolsillo Recaudo para movilizar y generar rendimiento
    const afterWithdraw = await adminCall(env, owner.token, 'POST', '/v1/admin/savings/pool/withdraw', {
      amountMinor: '60000000',
      reason: 'Inversión productiva de corto plazo',
    });
    expect(afterWithdraw.status).toBe(200);
    expect(afterWithdraw.body.collectionPoolBalanceMinor).toBe('20000000');
    expect(afterWithdraw.body.deployedExternallyMinor).toBe('60000000');

    // 4. Faltando menos de 72 horas (día 88 de 90), Admin reintegra capital + rendimientos y bloquea en Reserva 72h
    env.clock.advanceSeconds(88 * 24 * 3600);
    const ownerDay88 = await adminLogin(env, 'owner');
    const alert72 = await adminCall(env, ownerDay88.token, 'GET', '/v1/admin/savings/treasury-alerts');
    expect(alert72.status).toBe(200);
    expect(alert72.body.unfundedMaturingCount).toBe(1);

    const depositBack = await adminCall(env, ownerDay88.token, 'POST', '/v1/admin/savings/pool/deposit', {
      amountMinor: totalPayoutMinor.toString(),
      reason: 'Retorno de inversión + intereses para pago a cliente',
    });
    expect(depositBack.status).toBe(200);

    const locked72 = await adminCall(env, ownerDay88.token, 'POST', '/v1/admin/savings/fund-maturing-72h', {
      reason: 'Bloqueo 72h previo al vencimiento',
    });
    expect(locked72.status).toBe(200);
    expect(locked72.body.fundedCount).toBe(1);
    expect(locked72.body.pool.escrowLockedBalanceMinor).toBe(totalPayoutMinor.toString());
    expect(locked72.body.pool.maturing72hUnfundedCount).toBe(0);

    // 5. Un segundo antes de cumplirse las 90*24h exactas NO debe liquidar todavía
    env.clock.advanceSeconds(2 * 24 * 3600 - 1);
    const premature = await env.container.services.savings.processMaturities();
    expect(premature.completedCount).toBe(0);

    // 6. En el segundo exacto de vencimiento se acredita automáticamente desde Reserva 72h
    env.clock.advanceSeconds(1);
    const exact = await env.container.services.savings.processMaturities();
    expect(exact.completedCount).toBe(1);

    const walletAfter = await env.container.services.ledger.wallet(c.session.userId, 'COP');
    expect(walletAfter.availableMinor).toBe(40_000_000n + totalPayoutMinor);

    const ownerDay90 = await adminLogin(env, 'owner');
    const poolAfter = await adminCall(env, ownerDay90.token, 'GET', '/v1/admin/savings/pool');
    expect(poolAfter.body.escrowLockedBalanceMinor).toBe('0');
    expect(poolAfter.body.completedBlocksCount).toBe(1);

    // 7. Conciliación de tesorería con Coinsenda no debe arrojar falsos quiebres por movimientos internos de ahorro
    const recon = await adminCall(env, ownerDay90.token, 'POST', '/v1/admin/treasury/reconcile', {
      reason: 'Verificación contable pos-liquidación',
    });
    expect(recon.status).toBe(200);
    expect(recon.body.breaks).toHaveLength(0);

    await env.close();
  });
});
