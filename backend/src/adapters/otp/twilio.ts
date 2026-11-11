import type { Logger } from 'pino';
import type { OtpDispatchResult, OtpSender } from '../../ports/index.js';
import { AppError } from '../../lib/errors.js';

export interface TwilioOtpOptions {
  accountSid: string;
  authToken: string;
  /** Servicio Twilio Verify v2 (p. ej. VA0d66656c3983f7f5a1cbd3e903fbfae3) para WhatsApp/SMS oficial sin ventana de 24h. */
  verifyServiceSid?: string;
  /** Número remitente WhatsApp en Twilio Programmable Messaging (p. ej. "+14155238886" sandbox o remitente WABA propio). */
  whatsappFrom?: string;
  /** Plantilla aprobada de WhatsApp en Twilio Content API (HX...) opcional para Messages.json. */
  whatsappContentSid?: string;
  smsFrom?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

interface TwilioErrorPayload {
  code?: number;
  message?: string;
  status?: number;
}

const TWILIO_SANDBOX_WHATSAPP = '+14155238886';
const PLACEHOLDER_SENDERS = new Set(['', '+1234567890', '1234567890']);

export class TwilioWhatsAppOtpSender implements OtpSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TwilioOtpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get basicAuthHeader(): string {
    return `Basic ${Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString('base64')}`;
  }

  private normalizePhone(phone: string): string {
    const clean = phone.trim().replace(/^whatsapp:/i, '');
    return clean.startsWith('+') ? clean : `+${clean}`;
  }

  private cleanWhatsappFrom(): string | null {
    const raw = (this.opts.whatsappFrom ?? '').trim().replace(/^whatsapp:/i, '');
    if (!raw || PLACEHOLDER_SENDERS.has(raw)) return null;
    return raw.startsWith('+') ? raw : `+${raw}`;
  }

  async healthCheck(): Promise<void> {
    const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}.json`, {
      method: 'GET',
      headers: {
        Authorization: this.basicAuthHeader,
      },
    });
    if (!res.ok) {
      throw new AppError('PROVIDER_ERROR', `Twilio health check falló (${res.status})`, { provider: 'twilio' });
    }
  }

  async send(phone: string, code: string): Promise<OtpDispatchResult> {
    const formatted = this.normalizePhone(phone);
    const whatsappFrom = this.cleanWhatsappFrom();
    const hasDedicatedWhatsappSender = Boolean(whatsappFrom && whatsappFrom !== TWILIO_SANDBOX_WHATSAPP);

    // 1) Si hay un remitente propio de WhatsApp Business (distinto del sandbox), o no hay Verify configurado:
    //    usamos Messages.json directamente con el código generado por CuyPay.
    if (whatsappFrom && (hasDedicatedWhatsappSender || !this.opts.verifyServiceSid)) {
      try {
        return await this.sendViaProgrammableWhatsApp(formatted, whatsappFrom, code);
      } catch (err) {
        // Si Messages.json falla por plantilla/ventana 24h y existe Verify Service, respaldamos con Twilio Verify WhatsApp.
        if (this.opts.verifyServiceSid && !this.isComplianceBlock(err)) {
          this.opts.logger?.warn({ phoneSuffix: formatted.slice(-4) }, 'Fallback de Messages.json a Twilio Verify WhatsApp');
          return await this.sendViaVerify(formatted);
        }
        throw err;
      }
    }

    // 2) Si existe Twilio Verify Service (usa el remitente oficial de WhatsApp de Twilio sin requerir "join" al sandbox):
    if (this.opts.verifyServiceSid) {
      try {
        return await this.sendViaVerify(formatted);
      } catch (err) {
        // Si el usuario sí está unido al sandbox de WhatsApp y Verify falló por otra causa, intentamos Messages.json.
        if (whatsappFrom && !this.isComplianceBlock(err)) {
          return await this.sendViaProgrammableWhatsApp(formatted, whatsappFrom, code);
        }
        throw err;
      }
    }

    throw new AppError('PROVIDER_ERROR', 'No hay un remitente de WhatsApp ni servicio Verify configurado en Twilio', {
      provider: 'twilio',
    });
  }

  async verifyExternal(phone: string, code: string): Promise<boolean> {
    if (!this.opts.verifyServiceSid) return false;
    const formatted = this.normalizePhone(phone);
    const url = `https://verify.twilio.com/v2/Services/${this.opts.verifyServiceSid}/VerificationCheck`;
    const body = new URLSearchParams({
      To: formatted,
      Code: code.trim(),
    });

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuthHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.opts.logger?.warn({ status: res.status, phoneSuffix: formatted.slice(-4), err: text }, 'Twilio Verify check non-200');
        return false;
      }
      const data = (await res.json()) as { status?: string; valid?: boolean };
      return data.status === 'approved' && data.valid !== false;
    } catch (err) {
      this.opts.logger?.error({ err }, 'Error consultando VerificationCheck en Twilio Verify');
      throw new AppError('PROVIDER_ERROR', 'No pudimos validar el código con WhatsApp. Intenta de nuevo.', { provider: 'twilio' });
    }
  }

  private async sendViaVerify(formattedPhone: string): Promise<OtpDispatchResult> {
    const url = `https://verify.twilio.com/v2/Services/${this.opts.verifyServiceSid}/Verifications`;

    const tryChannel = async (channel: 'whatsapp' | 'sms') => {
      const body = new URLSearchParams({
        To: formattedPhone,
        Channel: channel,
        Locale: 'es',
      });
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuthHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      return res;
    };

    try {
      let res = await tryChannel('whatsapp');
      let usedChannel: 'whatsapp' | 'sms' = 'whatsapp';

      if (!res.ok) {
        const errPayload = await this.parseTwilioError(res);
        // Si no es bloqueo de cuenta/compliance ni teléfono inválido, probamos respaldo por SMS en Verify.
        if (res.status !== 401 && errPayload.code !== 21608 && errPayload.code !== 20003 && errPayload.code !== 60200) {
          this.opts.logger?.warn(
            { status: res.status, twilioCode: errPayload.code, phoneSuffix: formattedPhone.slice(-4) },
            'WhatsApp en Twilio Verify no disponible para este número; reintentando por SMS',
          );
          const smsRes = await tryChannel('sms');
          if (smsRes.ok) {
            res = smsRes;
            usedChannel = 'sms';
          } else {
            const smsErr = await this.parseTwilioError(smsRes);
            throw this.toAppError(smsRes.status, smsErr);
          }
        } else {
          throw this.toAppError(res.status, errPayload);
        }
      }

      const data = (await res.json().catch(() => ({}))) as { sid?: string };
      this.opts.logger?.info({ phoneSuffix: formattedPhone.slice(-4), channel: usedChannel }, 'OTP enviado con Twilio Verify');
      return {
        verificationMode: 'twilio_verify',
        channel: usedChannel,
        externalSid: data.sid,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.opts.logger?.error({ err }, 'Error de red llamando a Twilio Verify');
      throw new AppError('PROVIDER_ERROR', 'Error de conexión al enviar el código por WhatsApp', { provider: 'twilio' });
    }
  }

  private async sendViaProgrammableWhatsApp(
    formattedPhone: string,
    whatsappFrom: string,
    code: string,
  ): Promise<OtpDispatchResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.opts.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      From: `whatsapp:${whatsappFrom}`,
      To: `whatsapp:${formattedPhone}`,
    });

    if (this.opts.whatsappContentSid) {
      body.set('ContentSid', this.opts.whatsappContentSid);
      body.set('ContentVariables', JSON.stringify({ '1': code }));
    } else {
      body.set(
        'Body',
        `Tu código de verificación CuyPay es: *${code}*.\n\nVálido por 10 minutos. Nunca compartas este código con nadie.`,
      );
    }

    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: this.basicAuthHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const errPayload = await this.parseTwilioError(res);
        this.opts.logger?.error(
          { status: res.status, twilioCode: errPayload.code, err: errPayload.message },
          'Twilio WhatsApp Messages.json failed',
        );
        throw this.toAppError(res.status, errPayload);
      }

      const data = (await res.json().catch(() => ({}))) as { sid?: string };
      this.opts.logger?.info({ phoneSuffix: formattedPhone.slice(-4) }, 'OTP enviado por WhatsApp (Messages.json)');
      return {
        verificationMode: 'local',
        channel: 'whatsapp',
        externalSid: data.sid,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.opts.logger?.error({ err }, 'Error de conexión enviando WhatsApp con Twilio');
      throw new AppError('PROVIDER_ERROR', 'Error al conectar con Twilio para WhatsApp', { provider: 'twilio' });
    }
  }

  private async parseTwilioError(res: Response): Promise<TwilioErrorPayload> {
    const text = await res.text().catch(() => '');
    try {
      return JSON.parse(text) as TwilioErrorPayload;
    } catch {
      return { message: text, status: res.status };
    }
  }

  private isComplianceBlock(err: unknown): boolean {
    if (!(err instanceof AppError)) return false;
    const code = (err.details as Record<string, unknown> | undefined)?.twilioCode;
    return code === 20003 || code === 21608;
  }

  private toAppError(httpStatus: number, err: TwilioErrorPayload): AppError {
    const twilioCode = err.code;
    if (twilioCode === 21211 || twilioCode === 60200) {
      return new AppError('VALIDATION_ERROR', 'El número de celular ingresado no es válido para recibir WhatsApp.', {
        field: 'phone',
        twilioCode,
      });
    }
    if (twilioCode === 60203 || twilioCode === 20429) {
      return new AppError('RATE_LIMITED', 'Solicitaste demasiados códigos seguidos. Espera unos minutos e intenta de nuevo.', {
        provider: 'twilio',
        twilioCode,
      });
    }
    if (twilioCode === 21608 || twilioCode === 20003) {
      return new AppError(
        'PROVIDER_ERROR',
        'Twilio requiere completar la aprobación de Trust Hub o agregar este número en Verified Caller IDs para enviar el código por WhatsApp.',
        { provider: 'twilio', status: httpStatus, twilioCode },
      );
    }
    return new AppError('PROVIDER_ERROR', 'No se pudo enviar el código de verificación por WhatsApp. Intenta nuevamente.', {
      provider: 'twilio',
      status: httpStatus,
      twilioCode,
    });
  }
}
