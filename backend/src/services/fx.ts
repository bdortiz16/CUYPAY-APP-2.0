import { presentTransaction, type TransactionJson } from '../domain/presenters.js';
import type { Currency, Quote, Transaction, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import { applySpread, computeFee, convertMinor, invertRate, rateToNumber } from '../lib/money.js';
import type { KeyedMutex, ServiceDeps } from './deps.js';
import type { IdempotencyService } from './idempotency.js';
import { requireKycApproved } from './kyc.js';
import type { LedgerService } from './ledger.js';
import type { LimitsService } from './limits.js';

const assertPair = (from: string, to: string) => {
  // Fase 1: solo COP→BRL (BRL→COP queda preparado en el modelo).
  if (from !== 'COP' || to !== 'BRL') {
    throw new AppError('VALIDATION_ERROR', 'Por ahora solo se admite la conversión COP → BRL', { from, to });
  }
};

/** Conversión COP → BRL. */
export class FxService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
    private readonly limits: LimitsService,
    private readonly idem: IdempotencyService,
    private readonly mutex: KeyedMutex,
  ) {}

  /** Tasa al cliente = media con spread (BRL por 1 COP), escalada. */
  private async clientRate(from: Currency, to: Currency) {
    const mid = await this.d.brl.getMidRate(from, to);
    return { mid: mid.rateScaled, rate: applySpread(mid.rateScaled, this.d.config.FX_SPREAD_BPS), updatedAt: mid.updatedAt };
  }

  async rate(from: string, to: string) {
    assertPair(from, to);
    const r = await this.clientRate('COP', 'BRL');
    const history = await this.d.brl.getHistory('COP', 'BRL', 30);
    const inv = invertRate(r.rate);
    return {
      from: 'COP' as const,
      to: 'BRL' as const,
      rate: rateToNumber(r.rate),
      // COP por 1 BRL, redondeado a 2 decimales para presentación.
      inverseRate: Number((inv * 100n / 10n ** 10n).toString()) / 100,
      updatedAt: r.updatedAt.toISOString(),
      history: history.map((h) => ({ date: h.date, rate: rateToNumber(applySpread(h.rateScaled, this.d.config.FX_SPREAD_BPS)) })),
    };
  }

  async quote(user: User, input: { fromCurrency: string; toCurrency: string; amountMinor: number }): Promise<Quote> {
    assertPair(input.fromCurrency, input.toCurrency);
    const from = BigInt(input.amountMinor);
    const fee = computeFee(from, this.d.config.CONVERSION_FEE_BPS, this.d.config.CONVERSION_FEE_MIN_MINOR);
    if (fee >= from) throw new AppError('VALIDATION_ERROR', 'El monto no cubre la comisión', { feeMinor: Number(fee) });
    const r = await this.clientRate('COP', 'BRL');
    const to = convertMinor(from, fee, r.rate);
    if (to <= 0n) throw new AppError('VALIDATION_ERROR', 'Monto demasiado pequeño para convertir');
    const now = this.d.clock.now();
    const q: Quote = {
      id: newId('qt', now),
      userId: user.id,
      fromCurrency: 'COP',
      toCurrency: 'BRL',
      fromAmountMinor: from,
      feeMinor: fee,
      toAmountMinor: to,
      rateScaled: r.rate,
      midRateScaled: r.mid,
      expiresAt: new Date(now.getTime() + this.d.config.QUOTE_TTL_SECONDS * 1000),
      usedAt: null,
      createdAt: now,
    };
    await this.d.repos.quotes.create(q);
    return q;
  }

  async convert(user: User, input: { quoteId: string; idempotencyKey: string }): Promise<{ status: number; body: TransactionJson }> {
    requireKycApproved(user);
    return this.mutex.run(user.id, () =>
      this.idem.run(user.id, 'conversion', input.idempotencyKey, input, async () => {
        const txn = await this.doConvert(user, input.quoteId);
        return { status: 201, body: presentTransaction(txn) };
      }),
    );
  }

  private async doConvert(user: User, quoteId: string): Promise<Transaction> {
    const now = this.d.clock.now();
    const q = await this.d.repos.quotes.byId(quoteId);
    if (!q || q.userId !== user.id) throw new AppError('NOT_FOUND', 'Cotización no encontrada');
    if (q.usedAt) throw new AppError('QUOTE_EXPIRED', 'La cotización ya fue utilizada', { reason: 'used' });
    if (q.expiresAt <= now) throw new AppError('QUOTE_EXPIRED', 'La cotización venció, solicita una nueva', { reason: 'expired' });

    await this.limits.assertWithin(user, 'conversion', q.fromAmountMinor);
    const wallet = await this.ledger.wallet(user.id, q.fromCurrency);
    if (wallet.availableMinor < q.fromAmountMinor) {
      throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente', { availableMinor: Number(wallet.availableMinor) });
    }

    const txnId = newId('txn', now);
    // Ejecuta con el socio de liquidez; si falla no se mueve nada en el libro.
    const exec = await this.d.brl.executeConversion({
      reference: txnId,
      fromCurrency: q.fromCurrency,
      toCurrency: q.toCurrency,
      fromAmountMinor: q.fromAmountMinor - q.feeMinor,
      toAmountMinor: q.toAmountMinor,
      rateScaled: q.rateScaled,
    });

    const txn: Transaction = {
      id: txnId,
      userId: user.id,
      type: 'conversion',
      direction: 'out',
      currency: q.fromCurrency,
      amountMinor: q.fromAmountMinor,
      feeMinor: q.feeMinor,
      status: 'completed',
      title: `${q.fromCurrency} → ${q.toCurrency}`,
      subtitle: 'Conversión',
      description: null,
      conversion: {
        fromCurrency: q.fromCurrency,
        fromAmountMinor: q.fromAmountMinor,
        toCurrency: q.toCurrency,
        toAmountMinor: q.toAmountMinor,
        rateScaled: q.rateScaled,
      },
      beneficiaryId: null,
      quoteId: q.id,
      providerRef: exec.providerRef,
      flagged: false,
      failureReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repos.transactions.create(txn);
    await this.ledger.convert(
      user.id,
      { from: q.fromCurrency, to: q.toCurrency, fromAmount: q.fromAmountMinor, fee: q.feeMinor, toAmount: q.toAmountMinor },
      txn.id,
    );
    await this.limits.record(user.id, 'conversion', q.fromAmountMinor, txn.id);
    q.usedAt = now;
    await this.d.repos.quotes.update(q);
    return txn;
  }
}
