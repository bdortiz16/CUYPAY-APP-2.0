import type { Logger } from 'pino';
import type { OtpSender } from '../../ports/index.js';
import { AppError } from '../../lib/errors.js';

export interface TwilioOtpOptions {
  accountSid: string;
  authToken: string;
  whatsappFrom: string; // e.g. "+14155238886" (sandbox de Twilio) o número WhatsApp aprobado
  smsFrom?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class TwilioWhatsAppOtpSender implements OtpSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TwilioOtpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async healthCheck(): Promise<void> {
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64');
    const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}.json`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });
    if (!res.ok) {
      throw new AppError('PROVIDER_ERROR', `Twilio health check falló (${res.status})`, { provider: 'twilio' });
    }
  }

  async send(phone: string, code: string): Promise<void> {
    const formatted = phone.startsWith('+') ? phone : `+${phone}`;
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Messages.json`;

    const body = new URLSearchParams({
      From: `whatsapp:${this.opts.whatsappFrom.replace(/^whatsapp:/, '')}`,
      To: `whatsapp:${formatted}`,
      Body: `Tu código de verificación CuyPay es: *${code}*.\n\nVálido por 10 minutos. Nunca compartas este código con nadie.`,
    });

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        this.opts.logger?.error({ status: res.status, err: errorText }, 'Twilio WhatsApp sending failed');
        throw new AppError('PROVIDER_ERROR', 'No se pudo enviar el código por WhatsApp', { provider: 'twilio', status: res.status });
      }

      this.opts.logger?.info({ phoneSuffix: formatted.slice(-4) }, 'OTP enviado por WhatsApp exitosamente');
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.opts.logger?.error({ err }, 'Error de conexión enviando WhatsApp con Twilio');
      throw new AppError('PROVIDER_ERROR', 'Error al conectar con Twilio para WhatsApp', { provider: 'twilio' });
    }
  }
}
