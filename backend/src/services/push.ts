import { createPrivateKey, sign } from 'node:crypto';
import http2 from 'node:http2';
import type { Transaction } from '../domain/types.js';
import type { ServiceDeps } from './deps.js';

function formatCopAmount(amountMinor: bigint): string {
  const major = Number(amountMinor / 100n);
  const cents = Number(amountMinor % 100n);
  const formattedMajor = new Intl.NumberFormat('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(major);
  if (cents > 0) {
    return `$ ${formattedMajor},${String(cents).padStart(2, '0')}`;
  }
  return `$ ${formattedMajor}`;
}

/**
 * Envío de notificaciones push nativas iOS (APNs HTTP/2 con JWT ES256)
 * cuando ingresa un depósito a la cuenta del cliente.
 */
export class PushNotificationService {
  private cachedJwt: { token: string; issuedAtSec: number } | null = null;

  constructor(private readonly d: ServiceDeps) {}

  start(): () => void {
    return this.d.events.subscribe(async (e) => {
      if (e.type === 'transaction.created' && e.txn.type === 'deposit' && e.txn.direction === 'in') {
        await this.notifyIncomingDeposit(e.txn);
      }
    });
  }

  private get isApnsConfigured(): boolean {
    return Boolean(this.d.config.APNS_KEY_ID && this.d.config.APNS_TEAM_ID && this.d.config.APNS_PRIVATE_KEY);
  }

  private buildApnsJwt(): string {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.cachedJwt && nowSec - this.cachedJwt.issuedAtSec < 2400) {
      return this.cachedJwt.token;
    }
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES256', kid: this.d.config.APNS_KEY_ID }),
    ).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iss: this.d.config.APNS_TEAM_ID, iat: nowSec }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const pem = this.d.config.APNS_PRIVATE_KEY!.replace(/\\n/g, '\n');
    const key = createPrivateKey(pem);
    const sig = sign('sha256', Buffer.from(signingInput, 'utf8'), {
      key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const token = `${signingInput}.${sig}`;
    this.cachedJwt = { token, issuedAtSec: nowSec };
    return token;
  }

  async notifyIncomingDeposit(txn: Transaction): Promise<void> {
    if (!this.isApnsConfigured) return;
    const devices = (await this.d.repos.devices.listByUser(txn.userId)).filter(
      (dev) => !dev.revokedAt && Boolean(dev.pushToken),
    );
    if (devices.length === 0) return;

    const formattedAmount = formatCopAmount(txn.amountMinor);
    const senderTrimmed = txn.title.trim();
    const isSavingsMaturity = Boolean(txn.providerRef?.startsWith('sbk_'));
    const isLoanDisbursement = Boolean(txn.providerRef?.startsWith('loan_'));
    const hasSender =
      senderTrimmed.length > 0 &&
      senderTrimmed.toLowerCase() !== 'depósito bre-b' &&
      senderTrimmed.toLowerCase() !== 'deposito bre-b';

    let title = `¡Recibiste ${formattedAmount}!`;
    let body = hasSender
      ? `Recibiste ${formattedAmount} de ${senderTrimmed} en tu cuenta CuyPay.`
      : `Recibiste ${formattedAmount} por Bre-B en tu cuenta CuyPay.`;

    if (isSavingsMaturity) {
      title = `¡Recibiste ${formattedAmount}!`;
      body = `Se reintegró tu Bolsillo de Ahorro (capital + intereses) por ${formattedAmount} en tu cuenta CuyPay.`;
    } else if (isLoanDisbursement) {
      title = `¡Crédito desembolsado: ${formattedAmount}!`;
      body = `Aprobamos tu solicitud y acreditamos ${formattedAmount} en tu cuenta CuyPay.`;
    }

    const payload = JSON.stringify({
      aps: {
        alert: { title, body },
        sound: 'default',
        'mutable-content': 1,
      },
      txnId: txn.id,
      type: 'deposit',
    });

    await Promise.all(
      devices.map((dev) =>
        this.sendApns(dev.pushToken!, dev.pushEnvironment ?? 'production', payload, `deposit-${txn.id}`).catch(
          (err) => {
            this.d.logger.warn(
              { err: (err as Error).message, deviceId: dev.id, txnId: txn.id },
              'APNs push send failed',
            );
          },
        ),
      ),
    );
  }

  private sendApns(
    deviceToken: string,
    environment: 'sandbox' | 'production',
    payload: string,
    collapseId: string,
  ): Promise<void> {
    const authority =
      environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const jwt = this.buildApnsJwt();
    const topic = this.d.config.APNS_BUNDLE_ID;

    return new Promise((resolve, reject) => {
      const client = http2.connect(authority);
      const timer = setTimeout(() => {
        client.destroy();
        reject(new Error('APNs timeout'));
      }, 6_000);
      timer.unref?.();

      client.on('error', (err) => {
        clearTimeout(timer);
        client.close();
        reject(err);
      });

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': collapseId,
        'content-type': 'application/json',
      });

      let status = 0;
      let responseBody = '';

      req.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', () => {
        clearTimeout(timer);
        client.close();
        if (status >= 200 && status < 300) {
          resolve();
        } else {
          reject(new Error(`APNs HTTP ${status}: ${responseBody}`));
        }
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        client.close();
        reject(err);
      });

      req.end(payload);
    });
  }
}
