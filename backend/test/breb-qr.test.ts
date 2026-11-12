import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeEmvCrc16, parseBrebQrPayload } from '../src/lib/breb-qr.js';
import { makeEnv, registerUser, sumsubWebhook, type TestEnv } from './helpers.js';

function tlv(tag: string, value: string): string {
  const len = Array.from(value).length.toString().padStart(2, '0');
  return `${tag}${len}${value}`;
}

function buildEmvQr(fields: Array<[string, string]>): string {
  const body = fields.map(([t, v]) => tlv(t, v)).join('') + '6304';
  return body + computeEmvCrc16(body);
}

describe('Decodificación QR Bre-B / EMVCo Colombia y pago directo a cliente o comercio', () => {
  it('decodifica un QR EMVCo P2P de Redeban con hash de seguridad en Tag 91 y CRC en Tag 63', () => {
    const qr = buildEmvQr([
      ['00', '01'],
      ['01', '11'],
      ['26', tlv('00', 'CO.COM.RBM.LLA') + tlv('02', '3001234567')],
      ['49', tlv('00', 'CO.COM.RBM.RED') + tlv('01', 'RBM')],
      ['52', '0000'],
      ['53', '170'],
      ['58', 'CO'],
      ['59', 'JUAN PEREZ'],
      ['60', 'BOGOTA'],
      ['91', tlv('00', 'CO.COM.RBM.SEC') + tlv('01', 'AbCdEfGhIjKlMnOpQrStUv/1/FmX8y2/8voR3Pqw4PwIs2')],
    ]);

    expect(qr).toContain('/1/FmX8y2/8voR3Pqw4PwIs26304');
    const parsed = parseBrebQrPayload(qr);
    expect(parsed.isEmvCo).toBe(true);
    expect(parsed.crcValid).toBe(true);
    expect(parsed.primaryKey).toBe('3001234567');
    expect(parsed.candidateKeys).toEqual(['3001234567']);
    expect(parsed.isMerchant).toBe(false);
    expect(parsed.merchantName).toBe('JUAN PEREZ');
    expect(parsed.unsupportedReason).toBeNull();
  });

  it('decodifica un QR EMVCo dinámico de comercio (Tag 50 Código Único + Tag 54 monto + Tag 62 factura)', () => {
    const qr = buildEmvQr([
      ['00', '01'],
      ['01', '12'],
      ['49', tlv('00', 'CO.COM.RBM.RED') + tlv('01', 'RBM')],
      ['50', tlv('00', 'CO.COM.RBM.CU') + tlv('01', '12345678')],
      ['52', '5814'],
      ['53', '170'],
      ['54', '25000.00'],
      ['58', 'CO'],
      ['59', 'CAFE SAN ALBERTO'],
      ['60', 'MEDELLIN'],
      ['62', tlv('01', 'FAC-102') + tlv('05', 'MESA-4')],
      ['91', tlv('00', 'CO.COM.RBM.SEC') + tlv('01', 'ZxYwVuTsRqPoNmLkJiHgFe/1/FmX8y2/8voR3Pqw4PwIs2')],
    ]);

    const parsed = parseBrebQrPayload(qr);
    expect(parsed.isEmvCo).toBe(true);
    expect(parsed.crcValid).toBe(true);
    expect(parsed.initiationMethod).toBe('dynamic');
    expect(parsed.isMerchant).toBe(true);
    // Incluye el código crudo y su respaldo de 10 dígitos con ceros a la izquierda ('0012345678')
    expect(parsed.candidateKeys).toEqual(['12345678', '0012345678']);
    expect(parsed.amountMinor).toBe(2_500_000);
    expect(parsed.merchantName).toBe('CAFE SAN ALBERTO');
    expect(parsed.merchantCity).toBe('MEDELLIN');
    expect(parsed.reference).toBe('FAC-102');
  });

  it('decodifica URLs de pago y rechaza QRs no financieros (Wi-Fi / enlaces sin llave)', () => {
    const payUrl = parseBrebQrPayload('https://cuypay.com/pay?key=@PanaderiaLaPaz&amount=15000&ref=PED-88&merchant=1');
    expect(payUrl.primaryKey).toBe('@panaderialapaz');
    expect(payUrl.amountMinor).toBe(1_500_000);
    expect(payUrl.reference).toBe('PED-88');
    expect(payUrl.isMerchant).toBe(true);

    const telQr = parseBrebQrPayload('tel:+573001234567');
    expect(telQr.primaryKey).toBe('3001234567');

    const wifiQr = parseBrebQrPayload('WIFI:S:Cafeteria;T:WPA;P:secreto123;;');
    expect(wifiQr.primaryKey).toBeNull();
    expect(wifiQr.unsupportedReason).toBeTruthy();

    const genericWeb = parseBrebQrPayload('https://www.banrep.gov.co/es/bre-b');
    expect(genericWeb.primaryKey).toBeNull();
    expect(genericWeb.unsupportedReason).toBeTruthy();
  });

  describe('Flujo HTTP completo de pago por QR a comercio y cliente sin inscripción previa manual', () => {
    let env: TestEnv;
    beforeEach(async () => {
      env = await makeEnv();
    });
    afterEach(() => env.close());

    it('resuelve QR EMVCo de comercio (con fallback 10 dígitos) y ejecuta preview + envío directo con resolutionId', async () => {
      const c = await registerUser(env, { firstName: 'Bryan', lastName: 'Ortiz' });
      await sumsubWebhook(env, {
        type: 'applicantReviewed',
        externalUserId: c.session.userId,
        applicantId: 'app-qr-1',
        reviewResult: { reviewAnswer: 'GREEN' },
      });

      const key = await c.signed('POST', '/v1/breb/key', {});
      expect(key.status).toBe(200);
      const k = await env.container.deps.repos.brebKeys.byUser(c.session.userId);
      env.coinsenda.simulateDeposit({ providerKeyId: k!.providerKeyId, amountMinor: 50_000_000n, payerName: 'Recarga Inicial' });
      await env.container.services.deposits.poll();

      // QR de comercio Redeban cuyo Tag 50 viene sin los dos ceros iniciales ('12345678' → directorio tiene '0012345678')
      const merchantQr = buildEmvQr([
        ['00', '01'],
        ['01', '12'],
        ['49', tlv('00', 'CO.COM.RBM.RED') + tlv('01', 'RBM')],
        ['50', tlv('00', 'CO.COM.RBM.CU') + tlv('01', '12345678')],
        ['52', '5814'],
        ['53', '170'],
        ['54', '18500'],
        ['58', 'CO'],
        ['59', 'CAFE SAN ALBERTO'],
        ['60', 'BOGOTA'],
        ['62', tlv('01', 'ORD-774')],
        ['91', tlv('00', 'CO.COM.RBM.SEC') + tlv('01', 'HashSeguridadRedeban123/1/FmX8y2/8voR3Pqw4PwIs2')],
      ]);

      const resolved = await c.call('POST', '/v1/beneficiaries/resolve', {
        alias: merchantQr,
        qrPayload: merchantQr,
      });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({
        alias: '0012345678',
        holderName: 'CAFÉ SAN ALBERTO',
        holderNameFull: 'Café San Alberto',
        documentType: 'NIT',
        bankName: 'Redeban Bre-B',
        isMerchant: true,
        suggestedAmountMinor: 1_850_000,
        suggestedReference: 'ORD-774',
      });

      // Preview directo con resolutionId (sin haber llamado antes a POST /v1/beneficiaries)
      const preview = await c.call('POST', '/v1/transfers/preview', {
        resolutionId: resolved.body.resolutionId,
        amountMinor: resolved.body.suggestedAmountMinor,
      });
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        amountMinor: 1_850_000,
        feeMinor: 0,
        totalMinor: 1_850_000,
        currency: 'COP',
      });

      // Envío directo en un solo paso firmado (inscribe + valida AML + transfiere) e idempotente
      const idemKey = randomUUID();
      const tx = await c.signed('POST', '/v1/transfers', {
        resolutionId: resolved.body.resolutionId,
        amountMinor: 1_850_000,
        description: resolved.body.suggestedReference,
        idempotencyKey: idemKey,
      });
      expect(tx.status).toBe(201);
      expect(tx.body).toMatchObject({
        type: 'transfer',
        direction: 'out',
        currency: 'COP',
        amountMinor: 1_850_000,
        status: 'completed',
        title: 'Café San Alberto',
        subtitle: 'Bre-B · 0012345678',
      });

      // Reintento con la misma idempotencyKey no duplica cobro
      const retry = await c.signed('POST', '/v1/transfers', {
        resolutionId: resolved.body.resolutionId,
        amountMinor: 1_850_000,
        description: resolved.body.suggestedReference,
        idempotencyKey: idemKey,
      });
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(tx.body.id);

      const wallets = (await c.call('GET', '/v1/wallets')).body.items;
      expect(wallets[0].availableMinor).toBe(50_000_000 - 1_850_000);
    });
  });
});
