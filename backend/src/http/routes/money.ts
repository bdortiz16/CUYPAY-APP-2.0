import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container.js';
import {
  presentBeneficiary,
  presentBrebKey,
  presentCard,
  presentLimits,
  presentQuote,
  presentResolution,
} from '../../domain/presenters.js';
import { AppError } from '../../lib/errors.js';
import { toSafeNumber } from '../../lib/money.js';
import { getFxSettings } from '../../services/runtime-config.js';
import { parse, type RouteHelpers } from '../app.js';

const Amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdemKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_\-:.]+$/);
const Id = z.string().min(1).max(64);

const CreateKey = z.object({ preferredAlias: z.string().min(1).max(32).optional() });
const ChangeKey = z.object({ preferredAlias: z.string().min(1).max(32) });
const IssueCard = z.object({ label: z.string().min(1).max(30).optional() });
const UpdateCardState = z.object({
  state: z.enum(['active', 'frozen', 'canceled']),
  preservePocket: z.boolean().optional(),
});
const UpdateCardLabel = z.object({ label: z.string().min(1).max(30) });
const CardPocketTransfer = z.object({
  amountMinor: Amount,
  idempotencyKey: IdemKey.optional(),
});
const ApplePayTokenize = z.object({
  certificates: z.array(z.string()),
  nonce: z.string(),
  nonceSignature: z.string(),
});
const Resolve = z.object({ alias: z.string().trim().min(1).max(64) });
const CreateBen = z.object({ resolutionId: Id, nickname: z.string().trim().max(60).optional() });
const Preview = z.object({ beneficiaryId: Id, amountMinor: Amount });
const Transfer = z.object({ beneficiaryId: Id, amountMinor: Amount, description: z.string().max(140).optional(), idempotencyKey: IdemKey });
const RateQuery = z.object({ from: z.string().default('COP'), to: z.string().default('BRL') });
const QuoteReq = z.object({ fromCurrency: z.enum(['COP', 'BRL']), toCurrency: z.enum(['COP', 'BRL']), amountMinor: Amount });
const ConvertReq = z.object({ quoteId: Id, idempotencyKey: IdemKey });

export function registerMoneyRoutes(app: FastifyInstance, { deps, services }: Container, h: RouteHelpers) {
  const auth = { preHandler: [h.authenticate] };
  const signed = { preHandler: [h.authenticate, h.requireSignature] };

  // ── Llave Bre-B propia ──
  app.get('/breb/key', auth, async (req) => presentBrebKey(await services.breb.get(req.auth!.userId)));

  app.post('/breb/key', signed, async (req) => {
    const { preferredAlias } = parse(CreateKey, req.body);
    return presentBrebKey(await services.breb.create(await h.currentUser(req), preferredAlias));
  });

  app.put('/breb/key', signed, async (req) => {
    const { preferredAlias } = parse(ChangeKey, req.body);
    return presentBrebKey(await services.breb.change(await h.currentUser(req), preferredAlias));
  });

  app.delete('/breb/key', signed, async (req, reply) => {
    await services.breb.delete(await h.currentUser(req));
    return reply.status(204).send();
  });

  // ── Tarjetas (Coinsenda Farming & Marketplace) ──
  app.get('/cards', auth, async (req) => {
    const [cards, pocketMinor] = await Promise.all([
      services.cards.list(req.auth!.userId),
      services.cards.pocketBalance(req.auth!.userId),
    ]);
    return { items: cards.map((c) => presentCard(c, pocketMinor)) };
  });

  app.get('/cards/pocket', auth, async (req) => {
    return services.cards.pocketSummary(req.auth!.userId);
  });

  app.get('/cards/:id', auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const [card, pocketMinor] = await Promise.all([
      services.cards.get(req.auth!.userId, id),
      services.cards.pocketBalance(req.auth!.userId),
    ]);
    return presentCard(card, pocketMinor);
  });

  app.post('/cards/virtual', signed, async (req, reply) => {
    const body = parse(IssueCard, req.body ?? {});
    const user = await h.currentUser(req);
    const card = await services.cards.issueVirtual(user, body);
    const pocketMinor = await services.cards.pocketBalance(user.id);
    return reply.status(201).send(presentCard(card, pocketMinor));
  });

  app.get('/cards/:id/look-url', auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    return services.cards.getLookUrl(req.auth!.userId, id);
  });

  app.put('/cards/:id/status', signed, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const { state, preservePocket } = parse(UpdateCardState, req.body);
    const card = await services.cards.updateWorkingState(req.auth!.userId, id, state, { preservePocket });
    const pocketMinor = await services.cards.pocketBalance(req.auth!.userId);
    return presentCard(card, pocketMinor);
  });

  app.put('/cards/:id/label', auth, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const { label } = parse(UpdateCardLabel, req.body);
    const card = await services.cards.updateLabel(req.auth!.userId, id, label);
    const pocketMinor = await services.cards.pocketBalance(req.auth!.userId);
    return presentCard(card, pocketMinor);
  });

  app.post('/cards/:id/fund', signed, async (req, reply) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const body = parse(CardPocketTransfer, req.body);
    const r = await services.cards.fundPocket(await h.currentUser(req), id, body);
    return reply.status(r.status).send(r.body);
  });

  app.post('/cards/:id/withdraw', signed, async (req, reply) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const body = parse(CardPocketTransfer, req.body);
    const r = await services.cards.withdrawPocket(await h.currentUser(req), id, body);
    return reply.status(r.status).send(r.body);
  });

  app.post('/cards/:id/apple-pay/tokenize', signed, async (req) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    const body = parse(ApplePayTokenize, req.body);
    return services.cards.tokenizeApplePay(req.auth!.userId, id, body);
  });

  // ── Beneficiarios ──
  app.post('/beneficiaries/resolve', auth, async (req) => {
    const { alias } = parse(Resolve, req.body);
    return presentResolution(await services.beneficiaries.resolve(await h.currentUser(req), alias));
  });

  app.post('/beneficiaries', signed, async (req, reply) => {
    const body = parse(CreateBen, req.body);
    const { beneficiary, aml } = await services.beneficiaries.create(await h.currentUser(req), body);
    const json = presentBeneficiary(beneficiary, aml);
    if (beneficiary.status === 'rejected') {
      throw new AppError('AML_REJECTED', 'No es posible inscribir este beneficiario', { beneficiary: json });
    }
    return reply.status(201).send(json);
  });

  app.get('/beneficiaries', auth, async (req) => {
    const items = await services.beneficiaries.list(req.auth!.userId);
    return { items: items.map((x) => presentBeneficiary(x.beneficiary, x.aml)) };
  });

  app.delete('/beneficiaries/:id', signed, async (req, reply) => {
    const { id } = parse(z.object({ id: Id }), req.params);
    await services.beneficiaries.remove(req.auth!.userId, id);
    return reply.status(204).send();
  });

  // ── Envíos ──
  app.post('/transfers/preview', auth, async (req) => {
    const body = parse(Preview, req.body);
    const p = await services.transfers.preview(await h.currentUser(req), body.beneficiaryId, body.amountMinor);
    return {
      amountMinor: toSafeNumber(p.amount),
      feeMinor: toSafeNumber(p.fee),
      totalMinor: toSafeNumber(p.total),
      currency: 'COP',
      limits: presentLimits(p.limits),
    };
  });

  app.post('/transfers', signed, async (req, reply) => {
    const body = parse(Transfer, req.body);
    const r = await services.transfers.execute(await h.currentUser(req), body);
    return reply.status(r.status).send(r.body);
  });

  // ── FX ──
  app.get('/fx/rate', auth, async (req) => {
    const fx = await getFxSettings(deps);
    if (!fx.value.enabled) {
      throw new AppError('NOT_FOUND', 'Las conversiones entre COP y BRL están pausadas temporalmente.');
    }
    const q = parse(RateQuery, req.query);
    return services.fx.rate(q.from, q.to);
  });

  app.post('/fx/quotes', auth, async (req) => {
    const body = parse(QuoteReq, req.body);
    return presentQuote(await services.fx.quote(await h.currentUser(req), body));
  });

  app.post('/fx/conversions', signed, async (req, reply) => {
    const body = parse(ConvertReq, req.body);
    const r = await services.fx.convert(await h.currentUser(req), body);
    return reply.status(r.status).send(r.body);
  });
}
