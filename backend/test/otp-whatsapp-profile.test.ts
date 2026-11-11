import { describe, expect, it, vi } from 'vitest';
import { TwilioWhatsAppOtpSender } from '../src/adapters/otp/twilio.js';
import { ResendEmailOtpSender } from '../src/adapters/otp/resend.js';
import { loadConfig } from '../src/config.js';
import { createContainer, type ContainerOverrides } from '../src/container.js';
import { buildApp } from '../src/http/app.js';
import { FakeClock } from '../src/lib/clock.js';
import { makeEnv, registerUser, TestDevice } from './helpers.js';

async function makeCustomEnv(env: Record<string, string>, overrides: ContainerOverrides) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PROVIDERS_MODE: 'mock',
    AUTH_RATE_LIMIT_MAX: '10000',
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    ...env,
  });
  const clock = new FakeClock('2026-11-07T15:00:00.000Z');
  const container = createContainer(config, { clock, ...overrides });
  const app = await buildApp(container);
  await app.ready();
  return { app, container, clock, close: () => app.close() };
}

describe('Twilio WhatsApp OTP, Resend Email OTP y confirmación de contacto en Perfil', () => {
  it('envía OTP por WhatsApp usando Messages.json cuando hay remitente WhatsApp dedicado o plantilla ContentSid', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ sid: 'SM_whatsapp_123', status: 'queued' }), { status: 201 });
    });

    const sender = new TwilioWhatsAppOtpSender({
      accountSid: 'AC_test_sid',
      authToken: 'tok_test_secret',
      whatsappFrom: '+573001112233',
      whatsappContentSid: 'HX_template_otp',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const res = await sender.send('+573154103792', '482910');
    expect(res).toEqual({
      verificationMode: 'local',
      channel: 'whatsapp',
      externalSid: 'SM_whatsapp_123',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json');
    const params = new URLSearchParams(String(calls[0]!.init?.body));
    expect(params.get('From')).toBe('whatsapp:+573001112233');
    expect(params.get('To')).toBe('whatsapp:+573154103792');
    expect(params.get('ContentSid')).toBe('HX_template_otp');
    expect(params.get('ContentVariables')).toBe(JSON.stringify({ '1': '482910' }));
  });

  it('usa Twilio Verify v2 por WhatsApp (con fallback a SMS) y verifica mediante VerificationCheck', async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    let attempt = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ url, body });
      attempt += 1;

      if (url.endsWith('/Verifications')) {
        return new Response(JSON.stringify({ sid: `VE_${attempt}`, status: 'pending', channel: body.get('Channel') }), {
          status: 201,
        });
      }
      if (url.endsWith('/VerificationCheck')) {
        const code = body.get('Code');
        return new Response(
          JSON.stringify({
            status: code === '654321' ? 'approved' : 'pending',
            valid: code === '654321',
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const sender = new TwilioWhatsAppOtpSender({
      accountSid: 'AC_test_sid',
      authToken: 'tok_test_secret',
      verifyServiceSid: 'VA0d66656c3983f7f5a1cbd3e903fbfae3',
      whatsappFrom: '+14155238886', // sandbox por defecto -> prioriza Verify oficial
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const dispatch = await sender.send('+573154103792', '000000');
    expect(dispatch).toEqual({
      verificationMode: 'twilio_verify',
      channel: 'whatsapp',
      externalSid: 'VE_1',
    });
    expect(calls[0]!.url).toBe('https://verify.twilio.com/v2/Services/VA0d66656c3983f7f5a1cbd3e903fbfae3/Verifications');
    expect(calls[0]!.body.get('To')).toBe('+573154103792');
    expect(calls[0]!.body.get('Channel')).toBe('whatsapp');
    expect(calls[0]!.body.get('Locale')).toBe('es');

    expect(await sender.verifyExternal('+573154103792', '111111')).toBe(false);
    expect(await sender.verifyExternal('+573154103792', '654321')).toBe(true);
  });

  it('envía códigos de verificación por correo usando Resend', async () => {
    const captured: { body: Record<string, unknown> | null; auth: string } = { body: null, auth: '' };
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      captured.auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      captured.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 're_email_123' }), { status: 200 });
    });

    const resend = new ResendEmailOtpSender({
      apiKey: 're_live_key_test',
      fromEmail: 'CuyPay <no-reply@cuypay.com>',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await resend.sendEmailOtp({
      email: 'Cliente@Gmail.com',
      code: '739104',
      purpose: 'change_contact',
      firstName: 'Camila',
    });

    expect(captured.auth).toBe('Bearer re_live_key_test');
    expect(captured.body).toMatchObject({
      from: 'CuyPay <no-reply@cuypay.com>',
      to: ['cliente@gmail.com'],
      subject: '739104 es tu código de verificación de CuyPay',
    });
    expect(String(captured.body?.['html'])).toContain('739104');
  });

  it('pre-verifica el OTP de WhatsApp en /v1/auth/otp/verify con Twilio Verify sin consumir dos veces VerificationCheck al registrar', async () => {
    let verifyExternalCalls = 0;
    const customTwilioOtp = {
      async send() {
        return { verificationMode: 'twilio_verify' as const, channel: 'whatsapp' as const, externalSid: 'VE_live_1' };
      },
      async verifyExternal(_phone: string, code: string) {
        verifyExternalCalls += 1;
        // Simula comportamiento real de Twilio Verify: solo aprueba una vez
        return verifyExternalCalls === 1 && code === '918273';
      },
    };

    const env = await makeCustomEnv(
      { OTP_PROVIDER_MODE: 'twilio', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok123' },
      { otp: customTwilioOtp },
    );

    try {
      const phone = '+573154103792';
      const reqRes = await env.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone },
      });
      expect(reqRes.statusCode).toBe(200);
      const { otpId, channel } = reqRes.json();
      expect(channel).toBe('whatsapp');

      // Código incorrecto falla inmediatamente en el paso de OTP
      const badVerify = await env.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { otpId, phone, otpCode: '000000' },
      });
      expect(badVerify.statusCode).toBe(401);
      expect(badVerify.json().error.code).toBe('OTP_INVALID');

      // Reiniciamos el contador simulado para probar aprobación única
      verifyExternalCalls = 0;
      const okVerify = await env.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { otpId, phone, otpCode: '918273' },
      });
      expect(okVerify.statusCode).toBe(200);
      expect(okVerify.json()).toEqual({ verified: true, otpId, phone });
      expect(verifyExternalCalls).toBe(1);

      // Ahora completa /v1/auth/register usando el mismo otpId + otpCode sin volver a llamar a VerificationCheck
      const devKey = new TestDevice();
      const regRes = await env.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          otpId,
          otpCode: '918273',
          phone,
          email: 'bryan.ortiz@gmail.com',
          firstName: 'Bryan',
          lastName: 'Ortiz',
          country: 'CO',
          deviceName: 'iPhone 17 Pro',
          devicePublicKey: devKey.publicKeyX963,
          password: '4829',
        },
      });
      expect(regRes.statusCode).toBe(200);
      expect(verifyExternalCalls).toBe(1);
      expect(regRes.json().user).toMatchObject({
        phone,
        phoneVerified: true,
        email: 'bryan.ortiz@gmail.com',
      });
    } finally {
      await env.close();
    }
  });

  it('confirma cambios de celular y de correo en el Perfil mediante código por WhatsApp y por Correo (Resend)', async () => {
    const sentWhatsapp: { phone: string; code: string }[] = [];
    const sentEmails: { email: string; code: string }[] = [];

    const env = await makeCustomEnv(
      {
        OTP_PROVIDER_MODE: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'tok123',
      },
      {
        otp: {
          async send(phone: string, code: string) {
            sentWhatsapp.push({ phone, code });
            return { verificationMode: 'local', channel: 'whatsapp' };
          },
        },
        emailOtp: {
          isConfigured: true,
          async sendEmailOtp(input: { email: string; code: string }) {
            sentEmails.push({ email: input.email, code: input.code });
          },
        },
      },
    );

    try {
      // Registro inicial del cliente con WhatsApp OTP real
      const initOtp = await env.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '+573001234567' },
      });
      const initCode = sentWhatsapp.at(-1)!.code;
      const devKey = new TestDevice();
      const reg = await env.app.inject({
        method: 'POST',
        url: '/v1/auth/register',
        payload: {
          otpId: initOtp.json().otpId,
          otpCode: initCode,
          phone: '+573001234567',
          email: 'inicial@gmail.com',
          firstName: 'Laura',
          lastName: 'Gómez',
          country: 'CO',
          deviceName: 'iPhone de Laura',
          devicePublicKey: devKey.publicKeyX963,
        },
      });
      expect(reg.statusCode).toBe(200);
      const token = reg.json().accessToken as string;
      const authHeaders = { authorization: `Bearer ${token}` };

      // 1) En modo twilio, PUT /v1/me directo sin OTP bloquea el cambio de celular o correo
      const blockedPut = await env.app.inject({
        method: 'PUT',
        url: '/v1/me',
        headers: authHeaders,
        payload: { phone: '+573154103792' },
      });
      expect(blockedPut.statusCode).toBe(400);

      // Pero sí permite actualizar solo el nombre sin OTP
      const namePut = await env.app.inject({
        method: 'PUT',
        url: '/v1/me',
        headers: authHeaders,
        payload: { firstName: 'Laura Sofía' },
      });
      expect(namePut.statusCode).toBe(200);
      expect(namePut.json().firstName).toBe('Laura Sofía');

      // 2) Cambiar celular por WhatsApp: envía el código al NUEVO celular +573154103792
      const phoneOtpReq = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/otp/request',
        headers: authHeaders,
        payload: { phone: '+573154103792' },
      });
      expect(phoneOtpReq.statusCode).toBe(200);
      expect(phoneOtpReq.json()).toMatchObject({
        channel: 'whatsapp',
        maskedDestination: '+57 315 ••• 3792',
        emailOtpAvailable: true,
      });
      expect(sentWhatsapp.at(-1)!.phone).toBe('+573154103792');
      const newPhoneCode = sentWhatsapp.at(-1)!.code;

      // Impide confirmar un teléfono distinto al que recibió el código
      const spoofAttempt = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/confirm',
        headers: authHeaders,
        payload: {
          otpId: phoneOtpReq.json().otpId,
          otpCode: newPhoneCode,
          phone: '+573209998877',
        },
      });
      expect(spoofAttempt.statusCode).toBe(401);
      expect(spoofAttempt.json().error.code).toBe('OTP_INVALID');

      // Confirma correctamente el nuevo celular +573154103792
      const phoneConfirm = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/confirm',
        headers: authHeaders,
        payload: {
          otpId: phoneOtpReq.json().otpId,
          otpCode: newPhoneCode,
          phone: '+573154103792',
        },
      });
      expect(phoneConfirm.statusCode).toBe(200);
      expect(phoneConfirm.json()).toMatchObject({
        phone: '+573154103792',
        phoneVerified: true,
      });

      // 3) Cambiar correo confirmando por WhatsApp (envía el código al WhatsApp actual +573154103792)
      const emailViaWaReq = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/otp/request',
        headers: authHeaders,
        payload: { email: 'laura.nueva@gmail.com', channel: 'whatsapp' },
      });
      expect(emailViaWaReq.statusCode).toBe(200);
      expect(emailViaWaReq.json()).toMatchObject({
        channel: 'whatsapp',
        maskedDestination: '+57 315 ••• 3792',
      });
      expect(sentWhatsapp.at(-1)!.phone).toBe('+573154103792');
      const waEmailCode = sentWhatsapp.at(-1)!.code;

      const emailViaWaConfirm = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/confirm',
        headers: authHeaders,
        payload: {
          otpId: emailViaWaReq.json().otpId,
          otpCode: waEmailCode,
          email: 'laura.nueva@gmail.com',
        },
      });
      expect(emailViaWaConfirm.statusCode).toBe(200);
      expect(emailViaWaConfirm.json()).toMatchObject({
        email: 'laura.nueva@gmail.com',
        emailVerified: false,
      });

      // 4) También permite cambiar o verificar el correo enviando el código directamente al correo con Resend
      const emailViaResendReq = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/otp/request',
        headers: authHeaders,
        payload: { email: 'laura.verificada@gmail.com', channel: 'email' },
      });
      expect(emailViaResendReq.statusCode).toBe(200);
      expect(emailViaResendReq.json().channel).toBe('email');
      expect(sentEmails.at(-1)!.email).toBe('laura.verificada@gmail.com');
      const resendCode = sentEmails.at(-1)!.code;

      const emailViaResendConfirm = await env.app.inject({
        method: 'POST',
        url: '/v1/me/contact/confirm',
        headers: authHeaders,
        payload: {
          otpId: emailViaResendReq.json().otpId,
          otpCode: resendCode,
          email: 'laura.verificada@gmail.com',
        },
      });
      expect(emailViaResendConfirm.statusCode).toBe(200);
      expect(emailViaResendConfirm.json()).toMatchObject({
        email: 'laura.verificada@gmail.com',
        emailVerified: true,
      });
    } finally {
      await env.close();
    }
  });

  it('mantiene compatibilidad con registerUser en modo mock', async () => {
    const env = await makeEnv();
    try {
      const c = await registerUser(env, { phone: '+573112223344', email: 'test.real@gmail.com' });
      const me = await c.call('GET', '/v1/me');
      expect(me.status).toBe(200);
      expect(me.body.phoneVerified).toBe(true);
    } finally {
      await env.close();
    }
  });
});
