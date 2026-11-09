import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { parse, type RouteHelpers } from '../app.js';

const CreateBlockSchema = z.object({
  termDays: z.number().int().positive(),
  amountMinor: z.union([z.number(), z.string()]).transform((v) => BigInt(v)),
});

export function registerSavingsRoutes(v1: FastifyInstance, container: Container, h: RouteHelpers) {
  const { services } = container;

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

  // Constituir un nuevo bloque de ahorro
  v1.post('/savings', { preHandler: [h.authenticate] }, async (req, reply) => {
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
      startedAt: block.startedAt.toISOString(),
      maturesAt: block.maturesAt.toISOString(),
    });
  });
}
