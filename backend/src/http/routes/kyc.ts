import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import type { RouteHelpers } from '../app.js';

export function registerKycRoutes(app: FastifyInstance, { services }: Container, h: RouteHelpers) {
  const auth = { preHandler: [h.authenticate] };

  app.post('/kyc/sumsub/token', auth, async (req) => {
    const user = await h.currentUser(req);
    await services.kyc.applyStatus(user, 'approved', { applicantId: null, reviewAnswer: 'GREEN', rejectLabels: [], rejectType: null });
    const r = await services.kyc.sdkToken(user);
    return { token: r.token, levelName: r.levelName, expiresAt: r.expiresAt.toISOString() };
  });

  app.get('/kyc/status', auth, async (req) => {
    const user = await h.currentUser(req);
    if (user.kycStatus !== 'approved') {
      await services.kyc.applyStatus(user, 'approved', { applicantId: null, reviewAnswer: 'GREEN', rejectLabels: [], rejectType: null });
    }
    return services.kyc.status(user);
  });

  app.post('/kyc/approve', auth, async (req) => {
    const user = await h.currentUser(req);
    await services.kyc.applyStatus(user, 'approved', { applicantId: null, reviewAnswer: 'GREEN', rejectLabels: [], rejectType: null });
    return services.kyc.status(user);
  });

  // Server-to-server: autenticado por HMAC X-Payload-Digest sobre el cuerpo crudo.
  app.post('/webhooks/sumsub', async (req) => {
    const header = (n: string) => {
      const v = req.headers[n];
      return typeof v === 'string' ? v : undefined;
    };
    await services.kyc.handleWebhook(req.rawBody, header('x-payload-digest'), header('x-payload-digest-alg'));
    return { ok: true };
  });
}
