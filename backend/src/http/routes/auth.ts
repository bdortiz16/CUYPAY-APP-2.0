import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { presentSession } from '../../domain/presenters.js';
import { parse, type RouteHelpers } from '../app.js';

const Phone = z.string().regex(/^\+[1-9]\d{7,14}$/, 'Teléfono en formato E.164');

const OtpRequest = z.object({ phone: Phone });
const Register = z.object({
  otpId: z.string().min(1).max(64),
  otpCode: z.string().regex(/^\d{4,8}$/),
  phone: Phone,
  email: z.string().email().max(254),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  country: z.literal('CO'),
  deviceName: z.string().trim().min(1).max(100),
  devicePublicKey: z.string().min(80).max(120),
  password: z.string().min(4).max(64).optional(),
});
const ChallengeReq = z.object({ deviceId: z.string().min(1).max(64) });
const LoginReq = z.object({
  challengeId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(64),
  signature: z.string().min(8).max(200),
});
const LoginPasswordReq = z.object({
  phone: Phone,
  password: z.string().min(4).max(64),
  deviceName: z.string().trim().max(100).optional(),
  devicePublicKey: z.string().min(80).max(120).optional(),
});
const RefreshReq = z.object({ refreshToken: z.string().min(16).max(200) });

export function registerAuthRoutes(app: FastifyInstance, { services }: Container, h: RouteHelpers) {
  const rl = { config: h.authRateLimit };

  app.post('/auth/otp/request', rl, async (req) => {
    const { phone } = parse(OtpRequest, req.body);
    const r = await services.auth.requestOtp(phone);
    return { otpId: r.otpId, expiresAt: r.expiresAt.toISOString() };
  });

  app.post('/auth/register', rl, async (req) => {
    const body = parse(Register, req.body);
    return presentSession(await services.auth.register(body));
  });

  app.post('/auth/login/password', rl, async (req) => {
    const body = parse(LoginPasswordReq, req.body);
    return presentSession(await services.auth.loginWithPassword(body));
  });

  app.post('/auth/challenge', rl, async (req) => {
    const { deviceId } = parse(ChallengeReq, req.body);
    const c = await services.auth.createChallenge(deviceId);
    return { challengeId: c.challengeId, nonce: c.nonce, expiresAt: c.expiresAt.toISOString() };
  });

  app.post('/auth/login', rl, async (req) => {
    const body = parse(LoginReq, req.body);
    return presentSession(await services.auth.login(body));
  });

  app.post('/auth/refresh', rl, async (req) => {
    const { refreshToken } = parse(RefreshReq, req.body);
    return presentSession(await services.auth.refresh(refreshToken));
  });

  app.post('/auth/logout', { preHandler: [h.authenticate] }, async (req, reply) => {
    await services.auth.logout(req.auth!);
    return reply.status(204).send();
  });
}
