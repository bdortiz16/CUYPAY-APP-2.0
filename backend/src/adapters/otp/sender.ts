import type { Logger } from 'pino';
import type { OtpSender } from '../../ports/index.js';

/** OTP simulado: no envía nada (el código fijo 123456 se usa fuera de producción). */
export class MockOtpSender implements OtpSender {
  readonly sent: { phone: string; code: string }[] = [];
  constructor(private readonly logger?: Logger) {}
  async send(phone: string, code: string) {
    this.sent.push({ phone, code });
    // Nunca se loguea el código ni el teléfono completo.
    this.logger?.info({ phoneSuffix: phone.slice(-4) }, 'otp sent (mock)');
  }
}

/**
 * TODO(otp): proveedor SMS/WhatsApp real (p. ej. Twilio Verify / Infobip) para producción.
 */
export class UnconfiguredOtpSender implements OtpSender {
  async send(): Promise<void> {
    throw new Error('OtpSender real no configurado');
  }
}
