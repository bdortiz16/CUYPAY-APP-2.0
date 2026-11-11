import { describe, expect, it } from 'vitest';
import { adminCall, adminLogin } from './admin-helpers.js';
import { fundedUser, makeEnv } from './helpers.js';

describe('Créditos Comerciales, Bolsillo de Préstamos y Pagaré Electrónico + Carta de Instrucciones', () => {
  it('valida tope legal de usura SFC, firma Pagaré con ECDSA, aprueba desembolso desde Bolsillo de Préstamos y emite Paz y Salvo al pagar', async () => {
    const env = await makeEnv();
    const owner = await adminLogin(env, 'owner');
    const c = await fundedUser(env, 20_000_000n, {
      firstName: 'Carlos Andrés',
      lastName: 'Mejía',
      email: 'carlos.mejia@empresa.co',
    });

    // 1. Configuración pública de créditos (30, 60, 90, 180, 360 días) y validación de tope de usura SFC
    const cfgRes = await env.app.inject({ method: 'GET', url: '/v1/loans/config' });
    expect(cfgRes.statusCode).toBe(200);
    const cfg = cfgRes.json();
    expect(cfg.rates.map((r: { termDays: number }) => r.termDays)).toEqual([30, 60, 90, 180, 360]);

    // Intentar configurar una tasa superior al tope de usura debe fallar (Art. 884 C.Co. / Art. 305 C.P.)
    const illegalUsury = await adminCall(env, owner.token, 'PUT', '/v1/admin/loans/config', {
      rates: cfg.rates.map((r: { termDays: number; rateEaPercent: number; enabled: boolean }) =>
        r.termDays === 30 ? { ...r, rateEaPercent: 45.0 } : r,
      ),
      usuryCeilingEaPercent: 26.5,
      reason: 'Intento de tasa sobre usura',
    });
    expect(illegalUsury.status).toBe(400);

    // 2. Usuario previsualiza crédito de $500,000 COP a 60 días y obtiene el Pagaré + Carta de Instrucciones + SHA-256
    const preview = await c.call('POST', '/v1/loans/preview', {
      principalMinor: '50000000',
      termDays: 60,
      documentType: 'CC',
      documentNumber: '1032456789',
      city: 'Medellín',
      purpose: 'Capital de trabajo',
    });
    expect(preview.status).toBe(200);
    expect(preview.body.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.body.documentMarkdown).toContain('PAGARÉ ELECTRÓNICO A LA ORDEN');
    expect(preview.body.documentMarkdown).toContain('CARTA DE INSTRUCCIONES');
    expect(preview.body.documentMarkdown).toContain('XATECH SERVICES S.A.S.');
    expect(preview.body.documentMarkdown).toContain('1032456789');

    // 3. Usuario firma electrónicamente el Pagaré + Carta de Instrucciones + Habeas Data con Secure Enclave (ECDSA P-256)
    const apply = await c.signed('POST', '/v1/loans/apply', {
      principalMinor: '50000000',
      termDays: 60,
      documentType: 'CC',
      documentNumber: '1032456789',
      city: 'Medellín',
      purpose: 'Capital de trabajo',
      documentSha256: preview.body.documentSha256,
      acceptedPagare: true,
      acceptedInstructionLetter: true,
      acceptedCreditBureauAuth: true,
    });
    expect(apply.status).toBe(201);
    const loanId = apply.body.id as string;
    expect(apply.body.status).toBe('pending_review');
    expect(apply.body.promissoryNoteNumber).toMatch(/^PAG-\d{4}-\d{6}$/);

    // 4. Admin inspecciona el Pagaré firmado y verifica evidencia criptográfica e HTML imprimible
    const adminNote = await adminCall(env, owner.token, 'GET', `/v1/admin/loans/${loanId}/promissory-note`);
    expect(adminNote.status).toBe(200);
    expect(adminNote.body.integrityVerified).toBe(true);
    expect(adminNote.body.status).toBe('signed_custody');
    expect(adminNote.body.signature.method).toBe('ECDSA_P256_SHA256_SECURE_ENCLAVE');
    expect(adminNote.body.printableHtml).toContain('CERTIFICADO PROBATORIO DE FIRMA ELECTRÓNICA');

    // 5. Intentar aprobar sin saldo en el Bolsillo de Préstamos falla limpiamente con INSUFFICIENT_FUNDS
    const unfundedApprove = await adminCall(env, owner.token, 'POST', `/v1/admin/loans/${loanId}/approve`, {
      reason: 'Aprobación comité de crédito',
    });
    expect(unfundedApprove.status).toBe(422);
    expect(unfundedApprove.body.error.code).toBe('INSUFFICIENT_FUNDS');

    // 6. Admin fondea el Bolsillo de Préstamos con $2,000,000 COP y aprueba la solicitud
    const fundedPool = await adminCall(env, owner.token, 'POST', '/v1/admin/loans/pool/fund', {
      amountMinor: '200000000',
      reason: 'Capital inicial para cartera de préstamos',
    });
    expect(fundedPool.status).toBe(200);
    expect(fundedPool.body.availablePoolMinor).toBe('200000000');

    const approved = await adminCall(env, owner.token, 'POST', `/v1/admin/loans/${loanId}/approve`, {
      reason: 'Cliente con KYC aprobado y Pagaré verificado',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.loan.status).toBe('approved_active');
    expect(approved.body.pool.availablePoolMinor).toBe('150000000'); // $2,000,000 - $500,000 desembolsados

    // El cliente recibió automáticamente los $500,000 COP en su billetera ($200,000 previos + $500,000 = $700,000 COP)
    const walletAfterDisbursement = await env.container.services.ledger.wallet(c.session.userId, 'COP');
    expect(walletAfterDisbursement.availableMinor).toBe(70_000_000n);

    // El Pagaré pasa a estado vigente con mérito ejecutivo
    const activeNote = await c.call('GET', `/v1/loans/${loanId}/promissory-note`);
    expect(activeNote.status).toBe(200);
    expect(activeNote.body.status).toBe('active_enforceable');

    // 7. Abono parcial ($100,000 COP): imputa primero a intereses (Art. 1653 C.C.) y el excedente regresa al Bolsillo de Préstamos
    const totalDueMinor = BigInt(approved.body.loan.totalDueMinor);
    const interestMinor = BigInt(approved.body.loan.interestMinor);
    const partialPay = await c.signed('POST', `/v1/loans/${loanId}/pay`, {
      amountMinor: '10000000',
    });
    expect(partialPay.status).toBe(200);
    expect(partialPay.body.pazYSalvoIssued).toBe(false);
    expect(partialPay.body.loan.interestPaidMinor).toBe(interestMinor.toString());
    const expectedPrincipalReturned = 10_000_000n - interestMinor;
    expect(partialPay.body.loan.principalPaidMinor).toBe(expectedPrincipalReturned.toString());

    const poolAfterPartial = await adminCall(env, owner.token, 'GET', '/v1/admin/loans/pool');
    expect(BigInt(poolAfterPartial.body.availablePoolMinor)).toBe(150_000_000n + expectedPrincipalReturned);
    expect(BigInt(poolAfterPartial.body.collectedInterestMinor)).toBe(interestMinor);

    // 8. Pago total anticipado sin penalidad: liquida saldo insoluto y emite Paz y Salvo cancelando el Pagaré
    const remainingMinor = totalDueMinor - 10_000_000n;
    const finalPay = await c.signed('POST', `/v1/loans/${loanId}/pay`, {
      amountMinor: remainingMinor.toString(),
    });
    expect(finalPay.status).toBe(200);
    expect(finalPay.body.pazYSalvoIssued).toBe(true);
    expect(finalPay.body.loan.status).toBe('paid');
    expect(finalPay.body.loan.remainingMinor).toBe('0');

    const paidNote = await c.call('GET', `/v1/loans/${loanId}/promissory-note`);
    expect(paidNote.body.status).toBe('cancelled_paid');
    expect(paidNote.body.printableHtml).toContain('CANCELADO POR PAGO TOTAL — PAZ Y SALVO');

    // Todo el capital ($500,000 COP) regresó al Bolsillo de Préstamos ($2,000,000 COP completos de nuevo)
    const poolFinal = await adminCall(env, owner.token, 'GET', '/v1/admin/loans/pool');
    expect(poolFinal.body.availablePoolMinor).toBe('200000000');
    expect(poolFinal.body.paidLoansCount).toBe(1);

    // Conciliación limpia
    const recon = await adminCall(env, owner.token, 'POST', '/v1/admin/treasury/reconcile', {
      reason: 'Verificación contable pos-crédito',
    });
    expect(recon.status).toBe(200);
    expect(recon.body.breaks).toHaveLength(0);

    await env.close();
  });

  it('permite rechazar solicitud en revisión anulando el Pagaré en custodia sin mover fondos', async () => {
    const env = await makeEnv();
    const owner = await adminLogin(env, 'owner');
    const c = await fundedUser(env, 5_000_000n, {
      firstName: 'Laura',
      lastName: 'Quintero',
      email: 'laura.quintero@correo.co',
    });

    const preview = await c.call('POST', '/v1/loans/preview', {
      principalMinor: '20000000',
      termDays: 30,
      documentType: 'CC',
      documentNumber: '52890123',
    });
    expect(preview.status).toBe(200);

    const apply = await c.signed('POST', '/v1/loans/apply', {
      principalMinor: '20000000',
      termDays: 30,
      documentType: 'CC',
      documentNumber: '52890123',
      documentSha256: preview.body.documentSha256,
      acceptedPagare: true,
      acceptedInstructionLetter: true,
      acceptedCreditBureauAuth: true,
    });
    expect(apply.status).toBe(201);

    const rejected = await adminCall(env, owner.token, 'POST', `/v1/admin/loans/${apply.body.id}/reject`, {
      reason: 'Capacidad de endeudamiento insuficiente en evaluación interna',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.loan.status).toBe('rejected');

    const note = await c.call('GET', `/v1/loans/${apply.body.id}/promissory-note`);
    expect(note.status).toBe(200);
    expect(note.body.status).toBe('voided_rejected');

    await env.close();
  });
});
