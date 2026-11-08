import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addBeneficiary, fundedUser, makeEnv, type TestEnv } from './helpers.js';
import { adminCall, adminLogin } from './admin-helpers.js';

describe('Admin: RBAC, auditoría y PII', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('viewer no puede mutar (403 FORBIDDEN) ni ver auditoría/usuarios', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const viewer = await adminLogin(env, 'viewer');
    const id = c.session.userId;
    const freeze = await adminCall(env, viewer.token, 'POST', `/v1/admin/customers/${id}/freeze`, { reason: 'Prueba RBAC' });
    expect(freeze.status).toBe(403);
    expect(freeze.body.error.code).toBe('FORBIDDEN');
    expect((await adminCall(env, viewer.token, 'PUT', '/v1/admin/treasury/fx', { spreadBps: 10, reason: 'Prueba' })).status).toBe(403);
    expect((await adminCall(env, viewer.token, 'GET', '/v1/admin/users')).status).toBe(403);
    expect((await adminCall(env, viewer.token, 'GET', '/v1/admin/audit-log')).status).toBe(403);
    expect((await adminCall(env, viewer.token, 'GET', '/v1/admin/compliance/alerts')).status).toBe(403);
    // Lectura permitida.
    expect((await adminCall(env, viewer.token, 'GET', '/v1/admin/dashboard')).status).toBe(200);
    expect((await adminCall(env, viewer.token, 'GET', '/v1/admin/treasury')).status).toBe(200);
    const support = await adminLogin(env, 'support');
    expect((await adminCall(env, support.token, 'POST', `/v1/admin/customers/${id}/freeze`, { reason: 'Prueba RBAC' })).status).toBe(403);
    expect((await adminCall(env, support.token, 'POST', '/v1/admin/transactions/x/reverse', { reason: 'Prueba RBAC' })).status).toBe(403);
  });

  it('PII enmascarada para roles sin pii:read', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const user = (await env.container.deps.repos.users.byId(c.session.userId))!;
    const treasury = await adminLogin(env, 'treasury');
    const support = await adminLogin(env, 'support');
    const masked = await adminCall(env, treasury.token, 'GET', `/v1/admin/customers/${user.id}`);
    expect(masked.status).toBe(200);
    expect(masked.body.phone).not.toBe(user.phone);
    expect(masked.body.phone).toContain('***');
    expect(masked.body.email).toContain('***');
    const clear = await adminCall(env, support.token, 'GET', `/v1/admin/customers/${user.id}`);
    expect(clear.body.phone).toBe(user.phone);
    expect(clear.body.email).toBe(user.email);
    const list = await adminCall(env, treasury.token, 'GET', '/v1/admin/customers?limit=10');
    expect(list.status).toBe(200);
    expect(list.body.items.every((x: { phone: string }) => x.phone.includes('***'))).toBe(true);
  });

  it('toda mutación exige reason (400) y queda en el audit log con before/after', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const owner = await adminLogin(env, 'owner');
    const id = c.session.userId;
    const r = await adminCall(env, owner.token, 'POST', `/v1/admin/customers/${id}/freeze`, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect((await adminCall(env, owner.token, 'POST', `/v1/admin/customers/${id}/tier`, { tier: 'basic' })).status).toBe(400);
    expect((await adminCall(env, owner.token, 'POST', '/v1/admin/treasury/reconcile', {})).status).toBe(400);
    expect((await adminCall(env, owner.token, 'PUT', '/v1/admin/treasury/fx', { spreadBps: 10 })).status).toBe(400);
    expect((await env.container.deps.repos.audit.list()).filter((e) => e.targetId === id)).toHaveLength(0);

    const ok = await adminCall(env, owner.token, 'POST', `/v1/admin/customers/${id}/tier`, { tier: 'basic', reason: 'Documentos vencidos' });
    expect(ok.status).toBe(200);
    const log = await adminCall(env, owner.token, 'GET', `/v1/admin/audit-log?targetId=${id}`);
    expect(log.status).toBe(200);
    expect(log.body.items).toHaveLength(1);
    expect(log.body.items[0]).toMatchObject({
      action: 'customer.tier',
      targetType: 'customer',
      targetId: id,
      reason: 'Documentos vencidos',
      actor: { id: owner.adminId, role: 'owner' },
    });
    expect(log.body.items[0].before).toBeTruthy();
    expect(log.body.items[0].after).toBeTruthy();
  });

  it('notas y revocar dispositivo (support) quedan auditados', async () => {
    const c = await fundedUser(env, 0n);
    const support = await adminLogin(env, 'support');
    const note = await adminCall(env, support.token, 'POST', `/v1/admin/customers/${c.session.userId}/notes`, { text: 'Cliente llamó por soporte' });
    expect(note.status).toBe(201);
    const rev = await adminCall(env, support.token, 'POST', `/v1/admin/customers/${c.session.userId}/devices/${c.session.deviceId}/revoke`, { reason: 'Teléfono robado' });
    expect(rev.status).toBe(204);
    // El dispositivo revocado ya no puede usar la API.
    expect((await c.call('GET', '/v1/me')).status).toBe(401);
    const actions = (await env.container.deps.repos.audit.list()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['customer.note', 'customer.device_revoke']));
  });
});

describe('Admin: operaciones', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv({ ALERT_LARGE_TX_MINOR: '50000000' });
  });
  afterEach(() => env.close());

  it('congelar bloquea envíos y cotizaciones; depósitos quedan retenidos y se liberan al descongelar', async () => {
    const c = await fundedUser(env, 20_000_000n);
    const ben = await addBeneficiary(c);
    expect(ben.status).toBe(201);
    const compliance = await adminLogin(env, 'compliance');
    const id = c.session.userId;
    const f = await adminCall(env, compliance.token, 'POST', `/v1/admin/customers/${id}/freeze`, { reason: 'Investigación AML' });
    expect(f.status).toBe(200);
    expect(f.body.status).toBe('frozen');

    const tr = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.body.id, amountMinor: 1_000_000, idempotencyKey: randomUUID() });
    expect(tr.status).toBe(403);
    expect(tr.body.error.code).toBe('ACCOUNT_FROZEN');
    const q = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect(q.status).toBe(403);
    expect(q.body.error.code).toBe('ACCOUNT_FROZEN');

    // Depósito entrante: se acredita pero queda retenido.
    const k = await env.container.deps.repos.brebKeys.byUser(id);
    env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 5_000_000n });
    await env.container.services.deposits.poll();
    let w = (await c.call('GET', '/v1/wallets')).body.items.find((x: { currency: string }) => x.currency === 'COP');
    expect(w.availableMinor).toBe(20_000_000);
    expect(w.balanceMinor).toBe(25_000_000);

    const detail = await adminCall(env, compliance.token, 'GET', `/v1/admin/customers/${id}`);
    expect(detail.body.status).toBe('frozen');

    const u = await adminCall(env, compliance.token, 'POST', `/v1/admin/customers/${id}/unfreeze`, { reason: 'Caso cerrado' });
    expect(u.status).toBe(200);
    expect(u.body.releasedHeldMinor).toBe(5_000_000);
    w = (await c.call('GET', '/v1/wallets')).body.items.find((x: { currency: string }) => x.currency === 'COP');
    expect(w.availableMinor).toBe(25_000_000);
    const tr2 = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.body.id, amountMinor: 1_000_000, idempotencyKey: randomUUID() });
    expect([200, 201, 202]).toContain(tr2.status);
  });

  it('override de límites por cliente es respetado por el servicio de límites', async () => {
    const c = await fundedUser(env, 20_000_000n);
    const ben = await addBeneficiary(c);
    const owner = await adminLogin(env, 'owner');
    const r = await adminCall(env, owner.token, 'PUT', `/v1/admin/customers/${c.session.userId}/limit-overrides`, {
      items: [{ operation: 'transfer_out', period: 'daily', limitMinor: 500_000 }],
      reason: 'Límite temporal por riesgo',
    });
    expect(r.status).toBe(200);
    const tr = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.body.id, amountMinor: 1_000_000, idempotencyKey: randomUUID() });
    expect(tr.status).toBe(422);
    expect(tr.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('la config FX editada en runtime cambia las cotizaciones; enabled=false las bloquea', async () => {
    const c = await fundedUser(env, 20_000_000n);
    const treasury = await adminLogin(env, 'treasury');
    const before = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect(before.status).toBe(200);
    const fx0 = await adminCall(env, treasury.token, 'GET', '/v1/admin/treasury/fx');
    expect(fx0.status).toBe(200);

    const put = await adminCall(env, treasury.token, 'PUT', '/v1/admin/treasury/fx', { spreadBps: fx0.body.spreadBps + 500, reason: 'Volatilidad' });
    expect(put.status).toBe(200);
    const after = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect(after.status).toBe(200);
    expect(after.body.toAmountMinor).toBeLessThan(before.body.toAmountMinor);

    const fee = await adminCall(env, treasury.token, 'PUT', '/v1/admin/treasury/fx', { feeBps: 300, reason: 'Ajuste comercial' });
    expect(fee.status).toBe(200);
    const q3 = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect(q3.body.feeMinor).toBe(300_000);

    await adminCall(env, treasury.token, 'PUT', '/v1/admin/treasury/fx', { enabled: false, reason: 'Pausa de conversiones' });
    const blocked = await c.call('POST', '/v1/fx/quotes', { fromCurrency: 'COP', toCurrency: 'BRL', amountMinor: 10_000_000 });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.details.reason).toBe('fx_disabled');
  });

  it('límites por tier editables en runtime', async () => {
    const c = await fundedUser(env, 20_000_000n);
    const ben = await addBeneficiary(c);
    const owner = await adminLogin(env, 'owner');
    const cfg = await adminCall(env, owner.token, 'GET', '/v1/admin/limits-config');
    expect(cfg.status).toBe(200);
    const tier = (await env.container.deps.repos.users.byId(c.session.userId))!.tier;
    const put = await adminCall(env, owner.token, 'PUT', `/v1/admin/limits-config/${tier}`, {
      items: [{ operation: 'transfer_out', period: 'daily', limitMinor: 100_000 }],
      reason: 'Prueba',
    });
    expect(put.status).toBe(200);
    const tr = await c.signed('POST', '/v1/transfers', { beneficiaryId: ben.body.id, amountMinor: 1_000_000, idempotencyKey: randomUUID() });
    expect(tr.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  it('conciliación: ok cuando cuadra; break cuando el saldo del proveedor difiere', async () => {
    await fundedUser(env, 20_000_000n);
    const treasury = await adminLogin(env, 'treasury');
    const ok = await adminCall(env, treasury.token, 'POST', '/v1/admin/treasury/reconcile', { reason: 'Cierre diario' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ok');
    expect(ok.body.breaks).toHaveLength(0);

    env.coinsenda.balanceAdjustmentMinor = 123_456n;
    const bad = await adminCall(env, treasury.token, 'POST', '/v1/admin/treasury/reconcile', { reason: 'Cierre diario' });
    expect(bad.body.status).toBe('breaks');
    expect(bad.body.breaks[0]).toMatchObject({ kind: 'amount_mismatch', amountMinor: 123_456, currency: 'COP' });

    const snap = await adminCall(env, treasury.token, 'GET', '/v1/admin/treasury');
    expect(snap.body.reconciliation.status).toBe('breaks');
    const cop = snap.body.coverage.find((x: { currency: string }) => x.currency === 'COP');
    expect(cop.liabilitiesMinor).toBe(20_000_000);
    expect(cop.providerMinor).toBe(20_123_456);
  });

  it('los datos demo (seed) concilian sin breaks', async () => {
    const { seedDemo } = await import('../src/scripts/seed.js');
    await seedDemo(env.container);
    const owner = await adminLogin(env, 'owner');
    const r = await adminCall(env, owner.token, 'POST', '/v1/admin/treasury/reconcile', { reason: 'Revisión seed' });
    expect(r.body.breaks).toEqual([]);
    expect(r.body.status).toBe('ok');
  });

  it('conciliación detecta depósito del proveedor sin registrar en el ledger', async () => {
    await fundedUser(env, 1_000_000n);
    env.coinsenda.simulateDeposit({ providerKeyId: 'llave_desconocida', amountMinor: 700_000n });
    const owner = await adminLogin(env, 'owner');
    const r = await adminCall(env, owner.token, 'POST', '/v1/admin/treasury/reconcile', { reason: 'Revisión' });
    expect(r.body.status).toBe('breaks');
    expect(r.body.breaks.map((b: { kind: string }) => b.kind)).toContain('missing_in_ledger');
  });

  it('reverso con asientos compensatorios; detalle con ledger; CSV', async () => {
    const c = await fundedUser(env, 20_000_000n);
    const owner = await adminLogin(env, 'owner');
    const list = await adminCall(env, owner.token, 'GET', `/v1/admin/transactions?customerId=${c.session.userId}`);
    expect(list.status).toBe(200);
    const dep = list.body.items[0];
    expect(dep.type).toBe('deposit');
    const detail = await adminCall(env, owner.token, 'GET', `/v1/admin/transactions/${dep.id}`);
    expect(detail.body.ledgerEntries.length).toBeGreaterThanOrEqual(2);

    const noReason = await adminCall(env, owner.token, 'POST', `/v1/admin/transactions/${dep.id}/reverse`, {});
    expect(noReason.status).toBe(400);
    const rev = await adminCall(env, owner.token, 'POST', `/v1/admin/transactions/${dep.id}/reverse`, { reason: 'Depósito duplicado' });
    expect(rev.status).toBe(200);
    expect(rev.body.transaction.status).toBe('reversed');
    const entries = await env.container.deps.repos.ledger.entriesByTransaction(dep.id);
    expect(entries.reduce((s, e) => s + e.amountMinor, 0n)).toBe(0n);
    const w = (await c.call('GET', '/v1/wallets')).body.items.find((x: { currency: string }) => x.currency === 'COP');
    expect(w.balanceMinor).toBe(0);
    expect((await adminCall(env, owner.token, 'POST', `/v1/admin/transactions/${dep.id}/reverse`, { reason: 'Otra vez' })).status).toBe(409);

    const csv = await adminCall(env, owner.token, 'GET', '/v1/admin/transactions/export.csv');
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.raw).toContain(dep.id);
  });

  it('alertas: transacción grande y estructuración (con sugerencia UIAF); resolver exige nota', async () => {
    const c = await fundedUser(env, 60_000_000n); // ≥ ALERT_LARGE_TX_MINOR
    const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
    for (let i = 0; i < 3; i++) {
      env.clock.advanceSeconds(600);
      env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 47_000_000n });
      await env.container.services.deposits.poll();
    }
    const compliance = await adminLogin(env, 'compliance');
    const alerts = await adminCall(env, compliance.token, 'GET', `/v1/admin/compliance/alerts?customerId=${c.session.userId}`);
    expect(alerts.status).toBe(200);
    const types = alerts.body.items.map((a: { type: string }) => a.type);
    expect(types).toContain('large_transaction');
    expect(types).toContain('structuring');
    const s = alerts.body.items.find((a: { type: string }) => a.type === 'structuring');
    expect(s.uiafSuggested).toBe(true);

    expect((await adminCall(env, compliance.token, 'POST', `/v1/admin/compliance/alerts/${s.id}/resolve`, { resolution: 'reported' })).status).toBe(400);
    const res = await adminCall(env, compliance.token, 'POST', `/v1/admin/compliance/alerts/${s.id}/resolve`, { resolution: 'reported', note: 'ROS enviado a UIAF', reportToUiaf: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', resolution: 'reported', reportToUiaf: true });
    const flagged = await adminCall(env, compliance.token, 'GET', '/v1/admin/transactions?flagged=true');
    expect(flagged.body.items.length).toBeGreaterThan(0);
  });

  it('dashboard y proveedores', async () => {
    await fundedUser(env, 20_000_000n);
    const viewer = await adminLogin(env, 'viewer');
    const d = await adminCall(env, viewer.token, 'GET', '/v1/admin/dashboard');
    expect(d.status).toBe(200);
    expect(JSON.stringify(d.body)).toBeTruthy();
    const p = await adminCall(env, viewer.token, 'GET', '/v1/admin/providers');
    expect(p.status).toBe(200);
    expect(p.body.items.length).toBeGreaterThan(0);
    env.coinsenda.down = true;
    const owner = await adminLogin(env, 'owner');
    const chk = await adminCall(env, owner.token, 'POST', '/v1/admin/providers/coinsenda/check');
    expect(chk.status).toBe(200);
    expect(chk.body.status).toBe('down');
  });
});

describe('Admin: SSE', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('token de stream de un solo uso; el stream emite eventos de transacciones', async () => {
    const c = await fundedUser(env, 0n);
    const viewer = await adminLogin(env, 'viewer');
    const t1 = await adminCall(env, viewer.token, 'POST', '/v1/admin/stream/token');
    expect(t1.status).toBe(200);
    expect(t1.body.token).toBeTruthy();
    expect((await env.app.inject({ method: 'GET', url: '/v1/admin/stream?token=invalid-token-123456789' })).statusCode).toBe(401);

    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = env.app.server.address() as AddressInfo;
    let buf = '';
    const req = http.get(`http://127.0.0.1:${port}/v1/admin/stream?token=${t1.body.token}`);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const waitFor = (needle: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando ${needle}; buffer: ${buf}`)), 3000);
        const check = () => {
          if (buf.includes(needle)) {
            clearTimeout(timer);
            res.off('data', onData);
            resolve();
          }
        };
        const onData = (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          check();
        };
        res.on('data', onData);
        check();
      });
    await waitFor('event: ping');

    const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
    env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 1_234_500n });
    await env.container.services.deposits.poll();
    await waitFor('event: transaction.created');
    expect(buf).toContain('1234500');
    req.destroy();

    // Reutilizar el token → 401.
    const reuse = await env.app.inject({ method: 'GET', url: `/v1/admin/stream?token=${t1.body.token}` });
    expect(reuse.statusCode).toBe(401);
  });
});

describe('Compatibilidad', () => {
  it('ruta legacy /v1/admin/beneficiaries/:id/review con X-Admin-Key sigue funcionando', async () => {
    const env = await makeEnv({ ADMIN_API_KEY: 'legacy-admin-key-1234567890' });
    try {
      const c = await fundedUser(env, 0n);
      const r = await addBeneficiary(c, '@mariarevision');
      expect(r.status).toBe(201);
      const res = await env.app.inject({
        method: 'POST',
        url: `/v1/admin/beneficiaries/${r.body.id}/review`,
        payload: { decision: 'approve' },
        headers: { 'x-admin-key': 'legacy-admin-key-1234567890' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await env.close();
    }
  });
});
