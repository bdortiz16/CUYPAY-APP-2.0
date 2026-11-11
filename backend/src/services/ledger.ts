import type { Currency, LedgerAccountKind, LedgerEntry } from '../domain/types.js';
import { CURRENCIES } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';

export interface Leg {
  kind: LedgerAccountKind;
  userId?: string | null; // obligatorio para cuentas de usuario
  currency: Currency;
  amountMinor: bigint; // con signo: positivo = crédito (aumenta saldo de pasivo)
}

export interface WalletBalance {
  currency: Currency;
  balanceMinor: bigint;
  availableMinor: bigint;
  heldMinor: bigint;
}

/**
 * Libro mayor de partida doble. Cada movimiento es un journal cuyas patas suman
 * cero POR MONEDA. Saldos de usuario:
 *   available = saldo(user_available), held = saldo(user_held), balance = available + held.
 */
export class LedgerService {
  constructor(private readonly d: ServiceDeps) {}

  async post(legs: Leg[], transactionId: string | null): Promise<string> {
    if (legs.length < 2) throw new AppError('INTERNAL_ERROR', 'Journal con menos de dos patas');
    const sums = new Map<Currency, bigint>();
    for (const l of legs) {
      if ((l.kind === 'user_available' || l.kind === 'user_held' || l.kind === 'card_pocket') && !l.userId) {
        throw new AppError('INTERNAL_ERROR', 'Pata de usuario sin userId');
      }
      sums.set(l.currency, (sums.get(l.currency) ?? 0n) + l.amountMinor);
    }
    for (const [cur, s] of sums) {
      if (s !== 0n) throw new AppError('INTERNAL_ERROR', `Journal desbalanceado en ${cur}: ${s}`);
    }
    const now = this.d.clock.now();
    const journalId = newId('jnl', now);
    const entries: LedgerEntry[] = [];
    for (const l of legs) {
      if (l.amountMinor === 0n) continue;
      const acc = await this.d.repos.ledger.getOrCreateAccount(l.kind, l.userId ?? null, l.currency, now);
      entries.push({
        id: newId('len', now),
        journalId,
        accountId: acc.id,
        currency: l.currency,
        amountMinor: l.amountMinor,
        transactionId,
        createdAt: now,
      });
    }
    await this.d.repos.ledger.insertEntries(entries);
    return journalId;
  }

  async wallet(userId: string, currency: Currency): Promise<WalletBalance> {
    const now = this.d.clock.now();
    const avail = await this.d.repos.ledger.getOrCreateAccount('user_available', userId, currency, now);
    const held = await this.d.repos.ledger.getOrCreateAccount('user_held', userId, currency, now);
    const availableMinor = await this.d.repos.ledger.balance(avail.id);
    const heldMinor = await this.d.repos.ledger.balance(held.id);
    return { currency, availableMinor, heldMinor, balanceMinor: availableMinor + heldMinor };
  }

  async cardPocket(userId: string, currency: Currency = 'COP'): Promise<bigint> {
    const now = this.d.clock.now();
    const pocket = await this.d.repos.ledger.getOrCreateAccount('card_pocket', userId, currency, now);
    return this.d.repos.ledger.balance(pocket.id);
  }

  async wallets(userId: string): Promise<WalletBalance[]> {
    return Promise.all(CURRENCIES.map((c) => this.wallet(userId, c)));
  }

  /**
   * Asientos compensatorios: un journal nuevo con cada pata de la transacción negada
   * (mismas cuentas). Deja el efecto neto de la transacción en cero sin borrar historia.
   */
  async reverseTransaction(transactionId: string): Promise<string | null> {
    const entries = await this.d.repos.ledger.entriesByTransaction(transactionId);
    if (!entries.length) return null;
    const now = this.d.clock.now();
    const journalId = newId('jnl', now);
    const net = new Map<string, LedgerEntry>();
    for (const e of entries) {
      const prev = net.get(e.accountId);
      if (prev) prev.amountMinor += e.amountMinor;
      else net.set(e.accountId, { ...e });
    }
    const out: LedgerEntry[] = [];
    for (const e of net.values()) {
      if (e.amountMinor === 0n) continue;
      out.push({ id: newId('len', now), journalId, accountId: e.accountId, currency: e.currency, amountMinor: -e.amountMinor, transactionId, createdAt: now });
    }
    if (!out.length) return null;
    const sums = new Map<Currency, bigint>();
    for (const e of out) sums.set(e.currency, (sums.get(e.currency) ?? 0n) + e.amountMinor);
    for (const [cur, s] of sums) if (s !== 0n) throw new AppError('INTERNAL_ERROR', `Reverso desbalanceado en ${cur}: ${s}`);
    await this.d.repos.ledger.insertEntries(out);
    return journalId;
  }

  /** Efecto neto actual de una transacción sobre cada cuenta (para validar reversos). */
  async netByAccount(transactionId: string): Promise<Map<string, { currency: Currency; amountMinor: bigint }>> {
    const net = new Map<string, { currency: Currency; amountMinor: bigint }>();
    for (const e of await this.d.repos.ledger.entriesByTransaction(transactionId)) {
      const prev = net.get(e.accountId);
      net.set(e.accountId, { currency: e.currency, amountMinor: (prev?.amountMinor ?? 0n) + e.amountMinor });
    }
    return net;
  }

  // ── Movimientos tipados ──

  /** Depósito Bre-B entrante: la cuenta de liquidación en Coinsenda (activo) ↔ bolsillo COP. */
  credit(userId: string, currency: Currency, amount: bigint, txnId: string, contra: LedgerAccountKind = 'breb_settlement') {
    return this.post(
      [
        { kind: contra, currency, amountMinor: -amount },
        { kind: 'user_available', userId, currency, amountMinor: amount },
      ],
      txnId,
    );
  }

  /** Recarga el bolsillo de la tarjeta desde el saldo disponible principal (Bre-B). */
  fundCardPocket(userId: string, currency: Currency, amount: bigint, txnId: string) {
    return this.post(
      [
        { kind: 'user_available', userId, currency, amountMinor: -amount },
        { kind: 'card_pocket', userId, currency, amountMinor: amount },
      ],
      txnId,
    );
  }

  /** Retira fondos del bolsillo de la tarjeta hacia el saldo disponible principal (Bre-B). */
  withdrawCardPocket(userId: string, currency: Currency, amount: bigint, txnId: string) {
    return this.post(
      [
        { kind: 'card_pocket', userId, currency, amountMinor: -amount },
        { kind: 'user_available', userId, currency, amountMinor: amount },
      ],
      txnId,
    );
  }

  /** Liquida una compra con tarjeta debitando el bolsillo de la tarjeta contra la custodia COP. */
  debitCardPurchase(userId: string, currency: Currency, amount: bigint, txnId: string) {
    return this.post(
      [
        { kind: 'card_pocket', userId, currency, amountMinor: -amount },
        { kind: 'breb_settlement', currency, amountMinor: amount },
      ],
      txnId,
    );
  }

  /** Retiene fondos para un envío pendiente. */
  hold(userId: string, currency: Currency, amount: bigint, txnId: string) {
    return this.post(
      [
        { kind: 'user_available', userId, currency, amountMinor: -amount },
        { kind: 'user_held', userId, currency, amountMinor: amount },
      ],
      txnId,
    );
  }

  /** Libera la retención (envío fallido/revertido). */
  releaseHold(userId: string, currency: Currency, amount: bigint, txnId: string) {
    return this.post(
      [
        { kind: 'user_held', userId, currency, amountMinor: -amount },
        { kind: 'user_available', userId, currency, amountMinor: amount },
      ],
      txnId,
    );
  }

  /** Liquida un envío: sale de la retención hacia Coinsenda (+ comisión). */
  settleHold(userId: string, currency: Currency, amount: bigint, fee: bigint, txnId: string) {
    return this.post(
      [
        { kind: 'user_held', userId, currency, amountMinor: -(amount + fee) },
        { kind: 'breb_settlement', currency, amountMinor: amount },
        { kind: 'fee_revenue', currency, amountMinor: fee },
      ],
      txnId,
    );
  }

  /** Conversión: origen → clearing FX (+ comisión); clearing FX → destino. */
  convert(
    userId: string,
    p: { from: Currency; to: Currency; fromAmount: bigint; fee: bigint; toAmount: bigint },
    txnId: string,
  ) {
    return this.post(
      [
        { kind: 'user_available', userId, currency: p.from, amountMinor: -p.fromAmount },
        { kind: 'fee_revenue', currency: p.from, amountMinor: p.fee },
        { kind: 'fx_clearing', currency: p.from, amountMinor: p.fromAmount - p.fee },
        { kind: 'fx_clearing', currency: p.to, amountMinor: -p.toAmount },
        { kind: 'user_available', userId, currency: p.to, amountMinor: p.toAmount },
      ],
      txnId,
    );
  }
}
