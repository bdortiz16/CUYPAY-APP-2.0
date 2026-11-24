import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEMPORARY_CARD_TTL_MS } from '../src/services/cards.js';
import { adminCall, adminLogin } from './admin-helpers.js';
import { fundedUser, makeEnv, type TestClient, type TestEnv } from './helpers.js';

/** Avanza el reloj y renueva la sesión del cliente (el access token dura menos de 24 h). */
async function advanceAndRefresh(env: TestEnv, c: TestClient, ms: number) {
  env.clock.advance(ms);
  const r = await env.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: c.session.refreshToken } });
  if (r.statusCode !== 200) throw new Error(`refresh ${r.statusCode} ${r.body}`);
  const j = r.json();
  c.session.accessToken = j.accessToken;
  c.session.refreshToken = j.refreshToken;
}

describe('Tarjetas virtuales adicionales FIJAS y TEMPORALES', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
  });
  afterEach(() => env.close());

  it('emite tarjetas fijas y temporales sin límite de cantidad, con propósito y vencimiento de 24 h', async () => {
    const c = await fundedUser(env, 0n);

    const fixed = await c.signed('POST', '/v1/cards/virtual', { label: 'Mamá', kind: 'fixed', purpose: 'family' });
    expect(fixed.status).toBe(201);
    expect(fixed.body).toMatchObject({ kind: 'fixed', purpose: 'family', label: 'Mamá', expiresAt: null, status: 'active' });

    const temp = await c.signed('POST', '/v1/cards/virtual', { kind: 'temporary' });
    expect(temp.status).toBe(201);
    expect(temp.body).toMatchObject({ kind: 'temporary', purpose: 'online', label: 'Temporal', status: 'active' });
    expect(new Date(temp.body.expiresAt).getTime() - env.clock.now().getTime()).toBe(TEMPORARY_CARD_TTL_MS);

    // Sin límite: antes había un máximo de 3 tarjetas activas.
    for (let i = 0; i < 4; i++) {
      const r = await c.signed('POST', '/v1/cards/virtual', { purpose: 'friend', label: `Amigo ${i}` });
      expect(r.status).toBe(201);
    }
    const list = await c.call('GET', '/v1/cards');
    expect(list.body.items).toHaveLength(6);

    // Tarjetas existentes sin `kind` se presentan como FIJAS (compatibilidad hacia atrás).
    const legacy = (await env.container.deps.repos.cards.byId(fixed.body.id))!;
    delete legacy.kind;
    delete legacy.purpose;
    await env.container.deps.repos.cards.update(legacy);
    const legacyRes = await c.call('GET', `/v1/cards/${fixed.body.id}`);
    expect(legacyRes.body).toMatchObject({ kind: 'fixed', purpose: 'personal' });
  });

  it('rechaza tipos o propósitos inválidos', async () => {
    const c = await fundedUser(env, 0n);
    const r = await c.signed('POST', '/v1/cards/virtual', { kind: 'forever' });
    expect(r.status).toBe(400);
    const r2 = await c.signed('POST', '/v1/cards/virtual', { purpose: 'boss' });
    expect(r2.status).toBe(400);
  });

  it('la temporal vence a las 24 h: se cancela en Coinsenda y devuelve el bolsillo si era la última tarjeta', async () => {
    const c = await fundedUser(env, 500_000n);
    const temp = await c.signed('POST', '/v1/cards/virtual', { kind: 'temporary', label: 'Netflix' });
    const fund = await c.signed('POST', `/v1/cards/${temp.body.id}/fund`, { amountMinor: 200_000 });
    expect(fund.status).toBe(200);

    const spy = vi.spyOn(env.coinsenda, 'updateCardWorkingState');

    // Antes de vencer: el barrido no toca nada.
    await advanceAndRefresh(env, c, TEMPORARY_CARD_TTL_MS - 1000);
    expect(await env.container.services.cards.expireTemporaryCards()).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    env.clock.advance(1000);
    expect(await env.container.services.cards.expireTemporaryCards()).toBe(1);
    expect(spy).toHaveBeenCalledWith(temp.body.providerCardId ?? expect.any(String), 'canceled');

    const stored = (await env.container.deps.repos.cards.byId(temp.body.id))!;
    expect(stored.status).toBe('canceled');
    expect(stored.canceledReason).toBe('expired');

    const pocket = await c.call('GET', '/v1/cards/pocket');
    expect(pocket.body.balanceMinor).toBe(0);
    expect(pocket.body.mainAvailableMinor).toBe(500_000);

    // Idempotente: un segundo barrido no vuelve a cancelar.
    expect(await env.container.services.cards.expireTemporaryCards()).toBe(0);
  });

  it('con otras tarjetas activas, al vencer la temporal el bolsillo compartido se conserva', async () => {
    const c = await fundedUser(env, 500_000n);
    const fixed = await c.signed('POST', '/v1/cards/virtual', { kind: 'fixed' });
    await c.signed('POST', `/v1/cards/${fixed.body.id}/fund`, { amountMinor: 100_000 });
    await c.signed('POST', '/v1/cards/virtual', { kind: 'temporary' });

    await advanceAndRefresh(env, c, TEMPORARY_CARD_TTL_MS + 1);
    // Listar desde la app también aplica el vencimiento.
    const list = await c.call('GET', '/v1/cards');
    const temp = list.body.items.find((x: { kind: string }) => x.kind === 'temporary');
    expect(temp.status).toBe('canceled');
    expect(temp.canceledReason).toBe('expired');
    const pocket = await c.call('GET', '/v1/cards/pocket');
    expect(pocket.body.balanceMinor).toBe(100_000);
  });

  it('una temporal vencida no se puede usar ni reactivar aunque Coinsenda aún no haya confirmado la cancelación', async () => {
    const c = await fundedUser(env, 500_000n);
    const temp = await c.signed('POST', '/v1/cards/virtual', { kind: 'temporary' });
    await c.signed('PUT', `/v1/cards/${temp.body.id}/status`, { state: 'frozen' });

    const spy = vi.spyOn(env.coinsenda, 'updateCardWorkingState').mockRejectedValue(new Error('coinsenda down'));
    await advanceAndRefresh(env, c, TEMPORARY_CARD_TTL_MS + 1);
    expect(await env.container.services.cards.expireTemporaryCards()).toBe(0); // falla, se reintentará
    expect(spy).toHaveBeenCalled();

    const look = await c.call('GET', `/v1/cards/${temp.body.id}/look-url`);
    expect(look.status).toBe(400);
    expect(look.body.error.details?.reason ?? look.body.details?.reason).toBe('card_expired');

    const fund = await c.signed('POST', `/v1/cards/${temp.body.id}/fund`, { amountMinor: 10_000 });
    expect(fund.status).toBe(400);

    const reactivate = await c.signed('PUT', `/v1/cards/${temp.body.id}/status`, { state: 'active' });
    expect(reactivate.status).toBe(400);

    // Coinsenda vuelve: el siguiente barrido la cancela.
    spy.mockRestore();
    expect(await env.container.services.cards.expireTemporaryCards()).toBe(1);
  });

  it('portal admin: lista tarjetas con filtros y métricas, las muestra en la ficha del cliente y permite cancelarlas con auditoría', async () => {
    const c = await fundedUser(env, 0n, { firstName: 'Lucía', lastName: 'Gómez' });
    const fixed = await c.signed('POST', '/v1/cards/virtual', { kind: 'fixed', purpose: 'family', label: 'Hermano' });
    await c.signed('POST', '/v1/cards/virtual', { kind: 'temporary' });

    const owner = await adminLogin(env, 'owner');
    const all = await adminCall(env, owner.token, 'GET', '/v1/admin/cards');
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.summary).toMatchObject({ activeFixed: 1, activeTemporary: 1, issuedLast24h: 2, customersWithCards: 1 });
    expect(all.body.items[0].customerName).toBe('Lucía Gómez');

    const temps = await adminCall(env, owner.token, 'GET', '/v1/admin/cards?kind=temporary');
    expect(temps.body.items).toHaveLength(1);
    expect(temps.body.items[0].expiresAt).toBeTruthy();

    const detail = await adminCall(env, owner.token, 'GET', `/v1/admin/customers/${c.session.userId}`);
    expect(detail.body.cards).toHaveLength(2);

    // Un viewer no puede cancelar.
    const viewer = await adminLogin(env, 'viewer');
    const denied = await adminCall(env, viewer.token, 'POST', `/v1/admin/cards/${fixed.body.id}/cancel`, { reason: 'fraude reportado' });
    expect(denied.status).toBe(403);

    const noReason = await adminCall(env, owner.token, 'POST', `/v1/admin/cards/${fixed.body.id}/cancel`, {});
    expect(noReason.status).toBe(400);

    const cancel = await adminCall(env, owner.token, 'POST', `/v1/admin/cards/${fixed.body.id}/cancel`, { reason: 'fraude reportado' });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ status: 'canceled', canceledReason: 'admin' });

    const again = await adminCall(env, owner.token, 'POST', `/v1/admin/cards/${fixed.body.id}/cancel`, { reason: 'fraude reportado' });
    expect(again.status).toBe(409);

    const audit = await adminCall(env, owner.token, 'GET', `/v1/admin/audit-log?action=card.cancel`);
    expect(audit.body.items.some((a: { targetId: string }) => a.targetId === fixed.body.id)).toBe(true);

    // Vencimiento visible en el portal como 'expired'.
    env.clock.advance(TEMPORARY_CARD_TTL_MS + 1);
    const owner2 = await adminLogin(env, 'owner');
    const expired = await adminCall(env, owner2.token, 'GET', '/v1/admin/cards?status=expired');
    expect(expired.body.items).toHaveLength(1);
  });
});
