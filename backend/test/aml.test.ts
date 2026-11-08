import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addBeneficiary, fundedUser, makeEnv, type TestEnv } from './helpers.js';

describe('AML (Sartblock) en inscripción de beneficiarios', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv({ ADMIN_API_KEY: 'admin-key-admin-key-admin-key-123' });
  });
  afterEach(() => env.close());

  it('hit → 422 AML_REJECTED con beneficiario rejected; no se registra en Coinsenda', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const before = env.coinsenda.withdrawAccounts.size;
    const r = await addBeneficiary(c, '@pedrobloqueado');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('AML_REJECTED');
    expect(r.body.error.details.beneficiary).toMatchObject({ status: 'rejected', aml: { provider: 'sartblock', result: 'hit' } });
    expect(env.coinsenda.withdrawAccounts.size).toBe(before);
    const tr = await c.signed('POST', '/v1/transfers', {
      beneficiaryId: r.body.error.details.beneficiary.id,
      amountMinor: 1_000_000,
      idempotencyKey: randomUUID(),
    });
    expect(tr.body.error.code).toBe('BENEFICIARY_NOT_ACTIVE');
  });

  it('review → 201 pending_review; no se puede enviar hasta aprobación de cumplimiento', async () => {
    const c = await fundedUser(env, 10_000_000n);
    const r = await addBeneficiary(c, '@mariarevision');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending_review', aml: { result: 'review' } });
    const pv = await c.call('POST', '/v1/transfers/preview', { beneficiaryId: r.body.id, amountMinor: 1_000_000 });
    expect(pv.body.error).toMatchObject({ code: 'BENEFICIARY_NOT_ACTIVE', details: { status: 'pending_review' } });

    const review = await env.app.inject({
      method: 'POST',
      url: `/v1/admin/beneficiaries/${r.body.id}/review`,
      payload: { decision: 'approve' },
      headers: { 'x-admin-key': 'admin-key-admin-key-admin-key-123' },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().status).toBe('active');
    const tr = await c.signed('POST', '/v1/transfers', { beneficiaryId: r.body.id, amountMinor: 1_000_000, idempotencyKey: randomUUID() });
    expect(tr.status).toBe(201);

    const noKey = await env.app.inject({ method: 'POST', url: `/v1/admin/beneficiaries/${r.body.id}/review`, payload: { decision: 'reject' } });
    expect(noKey.statusCode).toBe(401);
  });

  it('la resolución pertenece al usuario y vence', async () => {
    const a = await fundedUser(env, 0n);
    const b = await fundedUser(env, 0n);
    const res = await a.call('POST', '/v1/beneficiaries/resolve', { alias: '3001234567' });
    expect((await b.signed('POST', '/v1/beneficiaries', { resolutionId: res.body.resolutionId })).body.error.code).toBe('NOT_FOUND');
    env.clock.advanceSeconds(11 * 60);
    const r = await a.signed('POST', '/v1/beneficiaries', { resolutionId: res.body.resolutionId });
    // el access token (15 min) sigue vigente a los 11 min
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });
});
