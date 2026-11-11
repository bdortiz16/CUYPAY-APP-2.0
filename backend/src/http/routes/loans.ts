import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { ALLOWED_LOAN_TERMS } from '../../domain/types.js';
import { parse, type RouteHelpers } from '../app.js';

const AmountMinorSchema = z
  .union([z.number(), z.string()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, 'El monto debe ser mayor a cero');

const LoanTermSchema = z
  .number()
  .int()
  .refine((v) => ALLOWED_LOAN_TERMS.includes(v as (typeof ALLOWED_LOAN_TERMS)[number]), {
    message: 'El plazo debe ser 30, 60, 90, 180 o 360 días',
  });

const PreviewLoanSchema = z.object({
  principalMinor: AmountMinorSchema,
  termDays: LoanTermSchema,
  purpose: z.string().trim().max(240).optional().nullable(),
  documentType: z.string().trim().max(32).optional().nullable(),
  documentNumber: z.string().trim().max(24).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
});

const ApplyLoanSchema = PreviewLoanSchema.extend({
  documentSha256: z.string().trim().regex(/^[0-9a-f]{64}$/i, 'Hash SHA-256 del documento inválido'),
  acceptedPagare: z.boolean(),
  acceptedInstructionLetter: z.boolean(),
  acceptedCreditBureauAuth: z.boolean(),
});

const PayLoanSchema = z.object({
  amountMinor: AmountMinorSchema,
});

const IdParam = z.object({ id: z.string().min(1).max(64) });

export function registerLoanRoutes(v1: FastifyInstance, container: Container, h: RouteHelpers) {
  const { services } = container;
  const auth = { preHandler: [h.authenticate] };
  const signed = { preHandler: [h.authenticate, h.requireSignature] };

  // Configuración pública de tasas, plazos (30/60/90/180/360 días) y tope de usura SFC
  v1.get('/loans/config', async (_req, reply) => {
    const cfg = await services.loans.getConfig();
    reply.send({
      enabled: cfg.enabled,
      rates: cfg.rates,
      usuryCeilingEaPercent: cfg.usuryCeilingEaPercent,
      moratoryRateEaPercent: cfg.moratoryRateEaPercent,
      minAmountMinor: cfg.minAmountMinor.toString(),
      maxAmountMinor: cfg.maxAmountMinor.toString(),
      creditorLegalName: cfg.creditorLegalName,
      creditorNit: cfg.creditorNit,
      creditorDomicile: cfg.creditorDomicile,
      updatedAt: cfg.updatedAt.toISOString(),
    });
  });

  // Simulador precontractual + borrador exacto de Pagaré Electrónico y Carta de Instrucciones (SHA-256)
  v1.post('/loans/preview', auth, async (req, reply) => {
    const user = await h.currentUser(req);
    const body = parse(PreviewLoanSchema, req.body);
    const preview = await services.loans.preview(user, body);
    reply.send(preview);
  });

  // Radicar solicitud de crédito firmando electrónicamente el Pagaré + Carta de Instrucciones (🔐 Face ID / Secure Enclave)
  v1.post('/loans/apply', signed, async (req, reply) => {
    const user = await h.currentUser(req);
    const body = parse(ApplyLoanSchema, req.body);
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
    };
    const created = await services.loans.apply(user, body, {
      deviceId: header('x-cuypay-device'),
      timestamp: header('x-cuypay-timestamp'),
      nonce: header('x-cuypay-nonce'),
      signature: header('x-cuypay-signature'),
      method: req.method,
      path: req.url.split('?')[0] ?? req.url,
      rawBody: req.rawBody,
      ip: req.ip ?? 'unknown',
      userAgent: header('user-agent').slice(0, 300),
    });
    reply.status(201).send(created);
  });

  // Mis créditos y resumen de cartera del cliente
  v1.get('/loans', auth, async (req, reply) => {
    const user = await h.currentUser(req);
    reply.send(await services.loans.listUserLoans(user.id));
  });

  // Consultar el Pagaré Electrónico firmado (o Paz y Salvo) del cliente
  v1.get('/loans/:id/promissory-note', auth, async (req, reply) => {
    const user = await h.currentUser(req);
    const { id } = parse(IdParam, req.params);
    reply.send(await services.loans.getUserPromissoryNote(user.id, id));
  });

  // Abonar o liquidar anticipadamente sin penalidad (🔐 Face ID)
  v1.post('/loans/:id/pay', signed, async (req, reply) => {
    const user = await h.currentUser(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(PayLoanSchema, req.body);
    reply.send(await services.loans.payLoan(user, id, body.amountMinor));
  });
}
