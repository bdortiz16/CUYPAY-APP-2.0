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
      if ((l.kind === 'user_available' || l.kind === 'user_held') && !l.userId) {
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

  async wallets(userId: string): Promise<WalletBalance[]> {
    return Promise.all(CURRENCIES.map((c) => this.wallet(userId, c)));
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
