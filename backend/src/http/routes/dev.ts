import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { presentBeneficiary, presentTransaction } from '../../domain/presenters.js';
import { MockCoinsendaGateway } from '../../adapters/coinsenda/mock.js';
import { AppError } from '../../lib/errors.js';
import { parse, type RouteHelpers } from '../app.js';

/**
 * Rutas FUERA del contrato:
 *  - /v1/dev/*   solo con PROVIDERS_MODE=mock y NODE_ENV≠production (demo de la app iOS).
 *  - /v1/admin/* solo si ADMIN_API_KEY está definido (header X-Admin-Key). Decisión de cumplimiento.
 */
export function registerDevRoutes(app: FastifyInstance, container: Container, h: RouteHelpers) {
  const { config, deps, services } = container;
  const auth = { preHandler: [h.authenticate] };

  if (config.devRoutes) {
    app.post('/dev/kyc/approve', auth, async (req) => {
      const user = await h.currentUser(req);
      await services.kyc.applyStatus(user, 'approved', { applicantId: null, reviewAnswer: 'GREEN', rejectLabels: [], rejectType: null });
      return services.kyc.status(user);
    });

    app.post('/dev/deposits/simulate', auth, async (req, reply) => {
      const body = parse(
        z.object({ amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), payerName: z.string().max(80).optional() }),
        req.body,
      );
      if (!(deps.coinsenda instanceof MockCoinsendaGateway)) throw new AppError('NOT_FOUND', 'Solo en modo mock');
      const key = await services.breb.get(req.auth!.userId);
      const dep = deps.coinsenda.simulateDeposit({ providerKeyId: key.providerKeyId, amountMinor: BigInt(body.amountMinor), payerName: body.payerName });
      const txn = await services.deposits.ingest(dep);
      if (!txn) throw new AppError('INTERNAL_ERROR', 'El depósito no se acreditó');
      return reply.status(201).send(presentTransaction(txn));
    });
  }

  if (config.ADMIN_API_KEY) {
    const adminKey = Buffer.from(config.ADMIN_API_KEY);
    const requireAdmin = async (req: FastifyRequest) => {
      const v = req.headers['x-admin-key'];
      const given = Buffer.from(typeof v === 'string' ? v : '');
      if (given.length !== adminKey.length || !timingSafeEqual(given, adminKey)) throw new AppError('UNAUTHORIZED', 'No autorizado');
    };
    app.post('/admin/beneficiaries/:id/review', { preHandler: [requireAdmin] }, async (req) => {
      const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
      const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), req.body);
      const b = await services.beneficiaries.review(id, decision);
      return presentBeneficiary(b, await deps.repos.aml.byId(b.amlCheckId));
    });
  }
}
