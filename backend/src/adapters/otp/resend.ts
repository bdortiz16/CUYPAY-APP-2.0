import type { Logger } from 'pino';
import type { EmailOtpSender } from '../../ports/index.js';
import { AppError } from '../../lib/errors.js';

export interface ResendEmailOtpOptions {
  apiKey: string;
  fromEmail: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export class MockEmailOtpSender implements EmailOtpSender {
  readonly isConfigured = true;
  readonly sent: { email: string; code: string; purpose: 'verify_email' | 'change_contact' }[] = [];

  constructor(private readonly logger?: Logger) {}

  async sendEmailOtp(input: { email: string; code: string; purpose: 'verify_email' | 'change_contact' }): Promise<void> {
    this.sent.push({ email: input.email, code: input.code, purpose: input.purpose });
    this.logger?.info({ purpose: input.purpose }, 'email otp sent (mock)');
  }
}

export class UnconfiguredEmailOtpSender implements EmailOtpSender {
  readonly isConfigured = false;

  async sendEmailOtp(): Promise<void> {
    throw new AppError(
      'PROVIDER_ERROR',
      'El envío de códigos por correo (Resend) aún no está activo. Usa la confirmación por WhatsApp.',
      { provider: 'resend' },
    );
  }
}

/**
 * Envío real de códigos OTP al correo del cliente mediante Resend (dominio verificado cuypay.com).
 */
export class ResendEmailOtpSender implements EmailOtpSender {
  readonly isConfigured = true;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResendEmailOtpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendEmailOtp(input: {
    email: string;
    code: string;
    purpose: 'verify_email' | 'change_contact';
    firstName?: string;
  }): Promise<void> {
    const greeting = input.firstName?.trim() ? `Hola ${input.firstName.trim()},` : 'Hola,';
    const actionText =
      input.purpose === 'change_contact'
        ? 'confirmar la actualización de tu correo electrónico en CuyPay'
        : 'verificar tu correo electrónico en CuyPay';

    const subject = `${input.code} es tu código de verificación de CuyPay`;
    const text = `${greeting}\n\nUsa el siguiente código para ${actionText}:\n\n${input.code}\n\nEste código vence en 10 minutos. Si no solicitaste este cambio, ignora este mensaje.\n\nEquipo CuyPay`;
    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff;color:#0f172a;border:1px solid #e2e8f0;border-radius:16px;">
        <div style="font-size:20px;font-weight:800;color:#0b4f4a;margin-bottom:16px;">CuyPay</div>
        <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">${greeting}</p>
        <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Ingresa este código de 6 dígitos en la app para ${actionText}:</p>
        <div style="background:#f1f5f9;border-radius:12px;padding:18px;text-align:center;font-size:32px;font-weight:800;letter-spacing:8px;color:#0b4f4a;margin-bottom:20px;">
          ${input.code}
        </div>
        <p style="font-size:13px;color:#64748b;line-height:1.5;margin:0;">Válido por 10 minutos. Nunca compartas este código con nadie.</p>
      </div>
    `.trim();

    try {
      const res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.opts.fromEmail,
          to: [input.email.trim().toLowerCase()],
          subject,
          text,
          html,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        this.opts.logger?.error({ status: res.status, err: errBody }, 'Resend email OTP failed');
        throw new AppError('PROVIDER_ERROR', 'No pudimos enviar el código a ese correo electrónico. Verifica que esté bien escrito.', {
          provider: 'resend',
          status: res.status,
        });
      }

      this.opts.logger?.info({ purpose: input.purpose }, 'OTP enviado por correo con Resend');
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.opts.logger?.error({ err }, 'Error de red llamando a Resend');
      throw new AppError('PROVIDER_ERROR', 'Error de conexión al enviar el correo de verificación.', { provider: 'resend' });
    }
  }
}
