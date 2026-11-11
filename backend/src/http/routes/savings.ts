import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { parse, type RouteHelpers } from '../app.js';

const CreateBlockSchema = z.object({
  termDays: z.number().int().positive(),
  amountMinor: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
});

const IdParam = z.object({ id: z.string().min(1).max(64) });

export function registerSavingsRoutes(v1: FastifyInstance, container: Container, h: RouteHelpers) {
  const { services, deps } = container;

  // Consultar configuración de tasas y contrato
  v1.get('/savings/config', async (_req, reply) => {
    const config = await services.savings.getConfig();
    reply.send({
      rates: config.rates,
      minAmountMinor: config.minAmountMinor.toString(),
      maxAmountMinor: config.maxAmountMinor.toString(),
      contractTerms: config.contractTerms,
      updatedAt: config.updatedAt.toISOString(),
    });
  });

  // Consultar bloques de ahorro del usuario
  v1.get('/savings', { preHandler: [h.authenticate] }, async (req, reply) => {
    const user = await h.currentUser(req);
    const data = await services.savings.listUserBlocks(user.id);
    reply.send(data);
  });

  // Consultar certificado y contrato aceptado de un bloque específico
  v1.get('/savings/:id/certificate', { preHandler: [h.authenticate] }, async (req, reply) => {
    const user = await h.currentUser(req);
    const { id } = parse(IdParam, req.params);
    const block = await deps.repos.savingsBlocks.byId(id);
    if (!block || block.userId !== user.id) {
      throw new AppError('NOT_FOUND', 'Bolsillo de ahorro no encontrado');
    }
    const config = await services.savings.getConfig();
    reply.send({
      id: block.id,
      holderName: `${user.firstName} ${user.lastName}`.trim(),
      holderEmail: user.email,
      holderPhone: user.phone,
      termDays: block.termDays,
      principalMinor: block.principalMinor.toString(),
      lockedRate: block.lockedRate,
      expectedYieldMinor: block.expectedYieldMinor.toString(),
      totalPayoutMinor: block.totalPayoutMinor.toString(),
      currency: block.currency,
      status: block.status,
      escrowStatus: block.escrowStatus ?? (block.status === 'completed' ? 'settled' : 'unfunded'),
      startedAt: block.startedAt.toISOString(),
      maturesAt: block.maturesAt.toISOString(),
      completedAt: block.completedAt?.toISOString() ?? null,
      contractAcceptedAt: block.contractAcceptedAt.toISOString(),
      contractTerms: config.contractTerms,
    });
  });

  // Constituir un nuevo bolsillo de ahorro (verifica firma ECDSA cuando el cliente móvil la incluye)
  v1.post('/savings', { preHandler: [h.authenticate] }, async (req, reply) => {
    if (req.headers['x-cuypay-signature'] || req.headers['x-cuypay-device']) {
      await h.requireSignature(req);
    }
    const user = await h.currentUser(req);
    const body = parse(CreateBlockSchema, req.body);
    const block = await services.savings.createBlock(user, body.termDays, body.amountMinor);
    reply.status(201).send({
      id: block.id,
      termDays: block.termDays,
      principalMinor: block.principalMinor.toString(),
      lockedRate: block.lockedRate,
      expectedYieldMinor: block.expectedYieldMinor.toString(),
      totalPayoutMinor: block.totalPayoutMinor.toString(),
      currency: block.currency,
      status: block.status,
      escrowStatus: block.escrowStatus ?? 'unfunded',
      startedAt: block.startedAt.toISOString(),
      maturesAt: block.maturesAt.toISOString(),
      completedAt: null,
    });
  });
}
