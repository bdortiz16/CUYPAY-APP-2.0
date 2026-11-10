import { describe, expect, it } from 'vitest';
import { makeEnv, registerUser } from './helpers.js';

describe('Bloques de Ahorro (Pólizas / Vault a Plazo)', () => {
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
    const tier30 = cfgRes.json().rates.find((r: any) => r.termDays === 30);
    expect(tier30.ratePercent).toBe(3.0);

    // 3. Constituir un bloque de ahorro por $500,000 COP a 30 días
    const lockRes = await c.call('POST', '/v1/savings', { termDays: 30, amountMinor: '50000000' });
    expect(lockRes.status).toBe(201);
    const block = lockRes.body;
    expect(block.termDays).toBe(30);
    expect(block.lockedRate).toBe(3.0);
    expect(block.status).toBe('active');

    // Verificar que el saldo disponible bajó a $500,000 COP
    const wallet = await env.container.services.ledger.wallet(userId, 'COP');
    expect(wallet.availableMinor).toBe(50_000_000n);

    // 4. Admin cambia la tasa de 30 días de 3.0% a 2.0%
    const newRates = cfgRes.json().rates.map((r: any) => (r.termDays === 30 ? { ...r, ratePercent: 2.0 } : r));
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
});
