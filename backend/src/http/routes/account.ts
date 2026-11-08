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

export function registerAccountRoutes(app: FastifyInstance, { services }: Container, h: RouteHelpers) {
  const auth = { preHandler: [h.authenticate] };
  const signed = { preHandler: [h.authenticate, h.requireSignature] };

  app.get('/me', auth, async (req) => presentUser(await h.currentUser(req)));

  app.get('/wallets', auth, async (req) => {
    const wallets = await services.ledger.wallets(req.auth!.userId);
    return { items: wallets.map(presentWallet) };
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
}
