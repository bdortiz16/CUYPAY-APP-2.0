import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { presentLimits, presentUser, presentWallet } from '../../domain/presenters.js';
import { parse, type RouteHelpers } from '../app.js';

const TxQuery = z.object({
  currency: z.enum(['COP', 'BRL']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(200).optional(),
});
const IdParam = z.object({ id: z.string().min(1).max(64) });
const Phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Teléfono en formato E.164');

const UpdateMe = z.object({
  firstName: z.string().trim().min(2).max(80).optional(),
  lastName: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: Phone.optional(),
  otpId: z.string().min(1).max(64).optional(),
  otpCode: z.string().regex(/^\d{4,8}$/).optional(),
});

const ContactOtpReq = z.object({
  phone: Phone.optional(),
  email: z.string().trim().email().max(254).optional(),
  channel: z.enum(['whatsapp', 'email']).optional(),
});

const ContactConfirmReq = z.object({
  otpId: z.string().min(1).max(64),
  otpCode: z.string().regex(/^\d{4,8}$/),
  firstName: z.string().trim().min(2).max(80).optional(),
  lastName: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: Phone.optional(),
});

import { getFxSettings } from '../../services/runtime-config.js';

export function registerAccountRoutes(app: FastifyInstance, { deps, services }: Container, h: RouteHelpers) {
  const auth = { preHandler: [h.authenticate] };
  const signed = { preHandler: [h.authenticate, h.requireSignature] };
  const authRl = { preHandler: [h.authenticate], config: h.authRateLimit };

  app.get('/me', auth, async (req) => {
    const user = await h.currentUser(req);
    if (process.env.AUTO_APPROVE_KYC === 'true' && user.kycStatus !== 'approved') {
      await services.kyc.applyStatus(user, 'approved', { applicantId: null, reviewAnswer: 'GREEN', rejectLabels: [], rejectType: null });
    }
    return presentUser(user);
  });

  app.put('/me', auth, async (req) => {
    const body = parse(UpdateMe, req.body);
    const updated = await services.auth.updateProfile(req.auth!.userId, body);
    return presentUser(updated);
  });

  app.post('/me/contact/otp/request', authRl, async (req) => {
    const body = parse(ContactOtpReq, req.body);
    const r = await services.auth.requestContactChangeOtp(req.auth!.userId, body);
    return {
      otpId: r.otpId,
      channel: r.channel,
      maskedDestination: r.maskedDestination,
      expiresAt: r.expiresAt.toISOString(),
      emailOtpAvailable: r.emailOtpAvailable,
    };
  });

  app.post('/me/contact/confirm', authRl, async (req) => {
    const body = parse(ContactConfirmReq, req.body);
    const updated = await services.auth.confirmContactUpdate(req.auth!.userId, body);
    return presentUser(updated);
  });

  app.get('/wallets', auth, async (req) => {
    const fx = await getFxSettings(deps);
    const allWallets = await services.ledger.wallets(req.auth!.userId);
    const active = fx.value.enabled ? allWallets : allWallets.filter((w) => w.currency === 'COP');
    return { items: active.map(presentWallet) };
  });

  app.get('/limits', auth, async (req) => presentLimits(await services.limits.snapshot(await h.currentUser(req))));

  app.get('/transactions', auth, async (req) => {
    const q = parse(TxQuery, req.query);
    return services.transactions.list(req.auth!.userId, q);
  });

  app.get('/devices', auth, async (req) => services.devices.list(req.auth!.userId, req.auth!.deviceId));

  app.delete('/devices/:id', signed, async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    await services.devices.revoke(req.auth!.userId, id);
    return reply.status(204).send();
  });

  app.get('/me/security', auth, async () => {
    return {
      idleTimeoutMinutes: 15,
      autoLockSeconds: 60,
      biometryRequired: true,
      allowedIdleOptions: [60, 300, 900],
    };
  });
}
