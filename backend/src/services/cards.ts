import { createHash } from 'node:crypto';
import { presentCard, presentTransaction, type TransactionJson } from '../domain/presenters.js';
import type { Card, CardCancelReason, CardKind, CardPurpose, CardStatus, Transaction, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { assertDeliverableEmail, isPlaceholderEmail } from '../lib/email-validator.js';
import { AppError, isAppError } from '../lib/errors.js';
import { toSafeNumber } from '../lib/money.js';
import type { CardHolderInput } from '../ports/index.js';
import type { KeyedMutex, ServiceDeps } from './deps.js';
import type { IdempotencyService } from './idempotency.js';
import { requireKycApproved } from './kyc.js';
import type { LedgerService } from './ledger.js';
import { assertNotFrozen } from './runtime-config.js';

export interface IssueCardInput {
  label?: string;
  /** 'fixed' (por defecto) o 'temporary' (vence 24 h después de crearse). */
  kind?: CardKind;
  purpose?: CardPurpose;
}

/** Vigencia de una tarjeta virtual TEMPORAL (modelo Nubank: 24 h desde su creación). */
export const TEMPORARY_CARD_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LABELS: Record<CardPurpose, string> = {
  personal: 'CuyPay Virtual',
  family: 'Familiar',
  friend: 'Amigo',
  online: 'Compras online',
  other: 'Tarjeta adicional',
};

export const cardKind = (c: Card): CardKind => c.kind ?? 'fixed';

/** Una temporal vencida ya no puede usarse aunque el barrido aún no la haya cancelado en Coinsenda. */
export const isCardExpired = (c: Card, now: Date): boolean =>
  cardKind(c) === 'temporary' && Boolean(c.expiresAt) && c.expiresAt!.getTime() <= now.getTime();

export interface CardPocketTransferInput {
  amountMinor: number;
  idempotencyKey?: string;
}

export interface CardPocketTransferResult {
  card: ReturnType<typeof presentCard>;
  pocketBalanceMinor: number;
  mainAvailableMinor: number;
  transaction: TransactionJson;
}

export interface ApplePayTokenizeInput {
  certificates: string[];
  nonce: string;
  nonceSignature: string;
}

const MIN_CARD_POCKET_TRANSFER_MINOR = 10_000n; // $100 COP mínimo

function deterministicSandboxDocumentNumber(seed: string): string {
  const hex = createHash('sha256').update(`cuypay-cardholder:${seed}`).digest('hex');
  const digits = (BigInt(`0x${hex.slice(0, 14)}`) % 100_000_000n).toString().padStart(8, '0');
  return `19${digits}`;
}

function isAdultBirthdate(ymd: string, now: Date): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  if (year < 1920) return false;
  let age = now.getUTCFullYear() - year;
  const monthDiff = now.getUTCMonth() - month;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < day)) {
    age -= 1;
  }
  return age >= 18;
}

/**
 * Servicio de tarjetas virtuales y físicas (respaldado por Coinsenda Farming & Marketplace).
 */
export class CardService {
  constructor(
    private readonly d: ServiceDeps,
    private readonly ledger: LedgerService,
    private readonly idem: IdempotencyService,
    private readonly mutex: KeyedMutex,
  ) {}

  async pocketBalance(userId: string): Promise<bigint> {
    return this.ledger.cardPocket(userId, 'COP');
  }

  async pocketSummary(userId: string) {
    const [pocketMinor, mainWallet] = await Promise.all([
      this.ledger.cardPocket(userId, 'COP'),
      this.ledger.wallet(userId, 'COP'),
    ]);
    return {
      currency: 'COP' as const,
      balanceMinor: toSafeNumber(pocketMinor),
      availableMinor: toSafeNumber(pocketMinor),
      mainAvailableMinor: toSafeNumber(mainWallet.availableMinor),
    };
  }

  async list(userId: string): Promise<Card[]> {
    const cards = await this.d.repos.cards.listByUser(userId);
    await this.expireDue(cards);
    return this.syncCardsIfNeeded(cards);
  }

  /**
   * Nota: no cancela temporales vencidas (se usa dentro del mutex del usuario y el KeyedMutex no es
   * reentrante). Las operaciones sensibles usan getUsable(), que rechaza tarjetas vencidas.
   */
  async get(userId: string, cardId: string): Promise<Card> {
    const card = await this.d.repos.cards.byId(cardId);
    if (!card || card.userId !== userId) throw new AppError('NOT_FOUND', 'Tarjeta no encontrada');
    const [synced] = await this.syncCardsIfNeeded([card]);
    return synced ?? card;
  }

  /** Detalle para la app: si es una temporal vencida, la cancela primero (fuera de cualquier mutex). */
  async detail(userId: string, cardId: string): Promise<Card> {
    const card = await this.get(userId, cardId);
    await this.expireDue([card]);
    return card;
  }

  /** Igual que get() pero exige que la tarjeta siga vigente (no cancelada ni temporal vencida). */
  private async getUsable(userId: string, cardId: string, action: string): Promise<Card> {
    const card = await this.get(userId, cardId);
    if (isCardExpired(card, this.d.clock.now())) {
      throw new AppError('VALIDATION_ERROR', `Tu tarjeta temporal ya venció; no puedes ${action}. Crea una nueva tarjeta temporal.`, {
        field: 'card',
        reason: 'card_expired',
      });
    }
    if (card.status === 'canceled') throw new AppError('VALIDATION_ERROR', 'La tarjeta está cancelada');
    return card;
  }

  private async syncCardsIfNeeded(cards: Card[]): Promise<Card[]> {
    if (!this.d.coinsenda.getProviderCards) return cards;
    const needsSync = cards.some((c) => c.status !== 'canceled' && (!c.lastFour || c.lastFour === '0000'));
    if (!needsSync) return cards;

    try {
      const remoteCards = await this.d.coinsenda.getProviderCards();
      const remoteById = new Map(remoteCards.map((r) => [r.providerCardId, r]));
      const now = this.d.clock.now();
      const out: Card[] = [];

      for (const c of cards) {
        const remote = remoteById.get(c.providerCardId);
        if (remote && c.status !== 'canceled') {
          let changed = false;
          if (remote.lastFour && remote.lastFour !== '0000' && remote.lastFour !== c.lastFour) {
            c.lastFour = remote.lastFour;
            changed = true;
          }
          if (remote.brand && remote.brand !== c.brand) {
            c.brand = remote.brand;
            changed = true;
          }
          if (remote.status && remote.status !== c.status) {
            c.status = remote.status;
            changed = true;
          }
          if (changed) {
            c.updatedAt = now;
            await this.d.repos.cards.update(c);
          }
        }
        out.push(c);
      }
      return out;
    } catch {
      return cards;
    }
  }

  private async resolveHolderFromKyc(user: User): Promise<CardHolderInput> {
    const now = this.d.clock.now();
    const kycRec = await this.d.repos.kyc.byUser(user.id);
    const kycProfile = this.d.kyc.getApplicantProfile
      ? await this.d.kyc.getApplicantProfile({
          applicantId: kycRec?.applicantId ?? null,
          externalUserId: user.id,
        })
      : null;

    const isSandboxOrMockKyc =
      !kycProfile ||
      kycProfile.isSandboxMockDocument ||
      this.d.config.PROVIDERS_MODE !== 'live' ||
      Boolean(this.d.config.SUMSUB_APP_TOKEN?.startsWith('sbx:'));

    const isLive = this.d.config.PROVIDERS_MODE === 'live';

    const userFirst = user.firstName.trim();
    const userLast = user.lastName.trim();
    const isPlaceholderName = userFirst.toLowerCase() === 'usuario' && userLast.toLowerCase() === 'cuypay';

    const firstName = (
      (!kycProfile?.isSandboxMockDocument && kycProfile?.firstName) ||
      (!isPlaceholderName ? userFirst : '') ||
      kycProfile?.firstName ||
      userFirst
    ).trim();
    const lastName = (
      (!kycProfile?.isSandboxMockDocument && kycProfile?.lastName) ||
      (!isPlaceholderName ? userLast : '') ||
      kycProfile?.lastName ||
      userLast
    ).trim();

    const emailCandidates = [user.email, kycProfile?.verifiedEmailFromKyc, kycProfile?.email].filter(
      (c): c is string => Boolean(c && !isPlaceholderEmail(c)),
    );

    let deliverableEmail: string | null = null;
    let lastEmailErrorMessage: string | null = null;
    for (const candidate of emailCandidates) {
      try {
        deliverableEmail = await assertDeliverableEmail(candidate, { isLive });
        break;
      } catch (err) {
        if (isAppError(err)) lastEmailErrorMessage = err.message;
      }
    }

    if (!deliverableEmail) {
      if (isLive || emailCandidates.length > 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          lastEmailErrorMessage ??
            'Actualiza tu correo electrónico real en tu perfil antes de crear tu tarjeta para recibir los códigos de Apple Wallet y compras.',
          { field: 'email' },
        );
      }
    }

    const effectiveEmail = deliverableEmail || user.email.trim().toLowerCase();
    const phone = (user.phone || kycProfile?.verifiedPhoneFromKyc || kycProfile?.phone || '').trim();
    if (!phone && isLive) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Actualiza tu número de celular en tu perfil antes de crear tu tarjeta para recibir los códigos de verificación.',
        { field: 'phone' },
      );
    }

    let documentNumber = kycProfile?.documentNumber ?? null;
    if (!documentNumber) {
      const brebKeys = await this.d.repos.brebKeys.listByUser(user.id);
      const nationalIdKey = brebKeys.find(
        (k) => k.type === 'national_id' && /^\d{6,10}$/.test(k.alias.replace(/^@/, '')),
      );
      if (nationalIdKey) {
        documentNumber = nationalIdKey.alias.replace(/^@/, '');
      }
    }
    if (!documentNumber && isSandboxOrMockKyc) {
      documentNumber = deterministicSandboxDocumentNumber(`${user.id}:${effectiveEmail}:${phone}`);
    }
    if (!documentNumber) {
      throw new AppError(
        'KYC_REQUIRED',
        'No encontramos un documento de identidad válido en Sumsub para crear el titular de tu tarjeta.',
      );
    }

    let birthdate = kycProfile?.birthdate ?? null;
    if (birthdate && !isAdultBirthdate(birthdate, now)) {
      if (!isSandboxOrMockKyc) {
        throw new AppError('VALIDATION_ERROR', 'Debes ser mayor de 18 años para emitir una tarjeta virtual.');
      }
      birthdate = '1996-05-15';
    }
    if (!birthdate) {
      birthdate = '1996-05-15';
    }

    const existingCardHolderId = kycRec?.providerCardHolderId ?? null;

    return {
      firstName,
      lastName,
      email: effectiveEmail,
      phone,
      birthdate,
      nationality: kycProfile?.nationality || user.country || 'COL',
      documentCountry: kycProfile?.documentCountry || user.country || 'COL',
      documentType: kycProfile?.documentType ?? 'cedula_ciudadania',
      documentNumber,
      address: kycProfile?.address ?? null,
      existingCardHolderId,
    };
  }

  /**
   * Emite una tarjeta virtual en Coinsenda. El cliente puede tener tantas tarjetas virtuales
   * adicionales como quiera (familiares, amigos, compras online): todas están a nombre del titular
   * verificado en KYC y gastan del mismo bolsillo de tarjeta.
   * - FIJA: permanece activa hasta que el cliente la elimine.
   * - TEMPORAL: se cancela automáticamente en Coinsenda 24 h después de crearse.
   */
  async issueVirtual(user: User, input?: IssueCardInput): Promise<Card> {
    requireKycApproved(user);
    await assertNotFrozen(this.d, user.id);
    const kind: CardKind = input?.kind ?? 'fixed';
    const purpose: CardPurpose = input?.purpose ?? (kind === 'temporary' ? 'online' : 'personal');

    const holder = await this.resolveHolderFromKyc(user);
    const holderName = `${holder.firstName} ${holder.lastName}`.trim();
    const cardLabel = (input?.label?.trim() || (kind === 'temporary' ? 'Temporal' : DEFAULT_LABELS[purpose])).slice(0, 30);
    let issued;
    try {
      issued = await this.d.coinsenda.issueCard({
        userId: user.id,
        holderName,
        email: holder.email,
        currency: 'COP',
        label: cardLabel,
        holder,
      });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('PROVIDER_ERROR', 'No se pudo emitir la tarjeta en Coinsenda', { provider: 'coinsenda' });
    }

    const now = this.d.clock.now();
    if (issued.providerCardHolderId) {
      const kycRec = await this.d.repos.kyc.byUser(user.id);
      if (kycRec && kycRec.providerCardHolderId !== issued.providerCardHolderId) {
        await this.d.repos.kyc.upsert({
          ...kycRec,
          providerCardHolderId: issued.providerCardHolderId,
          updatedAt: now,
        });
      }
    }

    const card: Card = {
      id: newId('crd', now),
      userId: user.id,
      cardType: 'virtual',
      status: issued.status,
      label: cardLabel,
      holderName: issued.holderName || holderName,
      lastFour: issued.lastFour,
      brand: issued.brand,
      currency: 'COP',
      providerCardId: issued.providerCardId,
      ...(issued.providerCardHolderId ? { providerCardHolderId: issued.providerCardHolderId } : {}),
      ledgerAccountId: issued.ledgerAccountId,
      kind,
      purpose,
      expiresAt: kind === 'temporary' ? new Date(now.getTime() + TEMPORARY_CARD_TTL_MS) : null,
      canceledAt: null,
      canceledReason: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repos.cards.create(card);
    this.d.logger.info({ userId: user.id, cardId: card.id, kind, purpose, expiresAt: card.expiresAt ?? null }, 'virtual card issued');
    const currentPocket = await this.ledger.cardPocket(user.id, 'COP');
    if (this.d.coinsenda.syncCardSpendingLimit) {
      await this.d.coinsenda.syncCardSpendingLimit({
        providerCardId: card.providerCardId,
        allowedAmountMinor: currentPocket,
        cardLabel: card.label,
      });
    }
    return card;
  }

  async getLookUrl(userId: string, cardId: string): Promise<{ url: string }> {
    const card = await this.getUsable(userId, cardId, 'ver sus datos');
    try {
      return await this.d.coinsenda.getCardLookUrl(card.providerCardId, card.providerCardHolderId);
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('PROVIDER_ERROR', 'No se pudo obtener el acceso a los datos de la tarjeta');
    }
  }

  async updateWorkingState(
    userId: string,
    cardId: string,
    newState: CardStatus,
    opts?: { preservePocket?: boolean },
  ): Promise<Card> {
    const card = await this.get(userId, cardId);
    if (card.status === 'canceled') {
      throw new AppError('VALIDATION_ERROR', 'Una tarjeta cancelada no puede ser modificada');
    }
    if (newState === 'active' && isCardExpired(card, this.d.clock.now())) {
      throw new AppError('VALIDATION_ERROR', 'Tu tarjeta temporal ya venció y no se puede reactivar. Crea una nueva tarjeta temporal.', {
        reason: 'card_expired',
      });
    }
    return this.applyState(card, newState, { preservePocket: opts?.preservePocket, reason: 'user' });
  }

  /** Cambia el estado en Coinsenda y localmente; si cancela, registra motivo y devuelve el bolsillo si ya no quedan tarjetas. */
  private async applyState(
    card: Card,
    newState: CardStatus,
    opts: { preservePocket?: boolean; reason: CardCancelReason },
  ): Promise<Card> {
    try {
      await this.d.coinsenda.updateCardWorkingState(card.providerCardId, newState);
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('PROVIDER_ERROR', 'No se pudo actualizar el estado de la tarjeta');
    }

    const now = this.d.clock.now();
    card.status = newState;
    card.updatedAt = now;
    if (newState === 'canceled') {
      card.canceledAt = now;
      card.canceledReason = opts.reason;
    }
    await this.d.repos.cards.update(card);

    if (newState === 'canceled' && !opts.preservePocket) {
      await this.refundPocketIfNoActiveCards(card);
    }
    return card;
  }

  /**
   * Si el usuario elimina definitivamente su última tarjeta activa (o vence su última temporal) y no va a
   * emitir reemplazo inmediato, devolvemos automáticamente el saldo del bolsillo de tarjeta a su saldo principal Bre-B.
   */
  private async refundPocketIfNoActiveCards(card: Card): Promise<void> {
    const userId = card.userId;
    await this.mutex.run(userId, async () => {
      const remainingActive = (await this.d.repos.cards.listByUser(userId)).filter((c) => c.status !== 'canceled');
      if (remainingActive.length > 0) return;
      const pocketMinor = await this.ledger.cardPocket(userId, 'COP');
      if (pocketMinor <= 0n) return;
      try {
        let transferRef: string | null = null;
        if (this.d.coinsenda.transferCardPocketFunds) {
          const tr = await this.d.coinsenda.transferCardPocketFunds({
            direction: 'from_card',
            amountMinor: pocketMinor,
          });
          transferRef = tr.transferId;
        }
        const now = this.d.clock.now();
        const txnId = newId('txn', now);
        await this.ledger.withdrawCardPocket(userId, 'COP', pocketMinor, txnId);
        const expired = card.canceledReason === 'expired';
        const txn: Transaction = {
          id: txnId,
          userId,
          type: 'card_pocket',
          direction: 'in',
          currency: 'COP',
          amountMinor: pocketMinor,
          feeMinor: 0n,
          status: 'completed',
          title: 'Devolución de Tarjeta CuyPay',
          subtitle: 'Saldo devuelto a tu cuenta principal Bre-B',
          description: expired
            ? 'Reintegro automático al vencer tu tarjeta virtual temporal'
            : 'Reintegro automático al eliminar tarjeta virtual',
          conversion: null,
          beneficiaryId: null,
          quoteId: null,
          providerRef: transferRef ?? card.id,
          flagged: false,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
        };
        await this.d.repos.transactions.create(txn);
        await this.d.events.publish({ type: 'transaction.created', txn });
      } catch (err) {
        this.d.logger.warn(
          { userId, cardId: card.id, err: (err as Error).message },
          'No se pudo devolver automáticamente el bolsillo al cancelar tarjeta; el saldo permanece en card_pocket',
        );
      }
    });
  }

  /** Cancela en Coinsenda las temporales vencidas de la lista (mejor esfuerzo; si falla se reintenta en el siguiente barrido). */
  private async expireDue(cards: Card[]): Promise<number> {
    const now = this.d.clock.now();
    let expired = 0;
    for (const c of cards) {
      if (c.status === 'canceled' || !isCardExpired(c, now)) continue;
      try {
        await this.applyState(c, 'canceled', { reason: 'expired' });
        expired++;
        this.d.logger.info({ userId: c.userId, cardId: c.id, expiresAt: c.expiresAt }, 'temporary virtual card expired and canceled');
        await this.d.events.publish({ type: 'customer.updated', userId: c.userId });
      } catch (err) {
        this.d.logger.warn(
          { userId: c.userId, cardId: c.id, err: (err as Error).message },
          'No se pudo cancelar en Coinsenda la tarjeta temporal vencida; se reintentará',
        );
      }
    }
    return expired;
  }

  /** Barrido periódico (poller): cancela automáticamente todas las tarjetas temporales vencidas. */
  async expireTemporaryCards(): Promise<number> {
    const now = this.d.clock.now();
    const due = (await this.d.repos.cards.listAll()).filter((c) => c.status !== 'canceled' && isCardExpired(c, now));
    if (!due.length) return 0;
    return this.expireDue(due);
  }

  /** Portal admin: cancelación forzada de una tarjeta (p. ej. fraude). Devuelve el bolsillo si era la última. */
  async adminCancel(cardId: string): Promise<{ before: Card; after: Card }> {
    const card = await this.d.repos.cards.byId(cardId);
    if (!card) throw new AppError('NOT_FOUND', 'Tarjeta no encontrada');
    if (card.status === 'canceled') throw new AppError('CONFLICT', 'La tarjeta ya está cancelada');
    const before = { ...card };
    const after = await this.applyState(card, 'canceled', { reason: 'admin' });
    return { before, after };
  }

  async fundPocket(user: User, cardId: string, input: CardPocketTransferInput): Promise<{ status: number; body: CardPocketTransferResult }> {
    requireKycApproved(user);
    await assertNotFrozen(this.d, user.id);
    const amountMinor = BigInt(input.amountMinor);
    if (amountMinor < MIN_CARD_POCKET_TRANSFER_MINOR) {
      throw new AppError('VALIDATION_ERROR', 'El monto mínimo para recargar tu tarjeta es de $100 COP', {
        minAmountMinor: Number(MIN_CARD_POCKET_TRANSFER_MINOR),
      });
    }

    const execute = async (): Promise<{ status: number; body: CardPocketTransferResult }> => {
      const card = await this.getUsable(user.id, cardId, 'recargarla');

      const mainWallet = await this.ledger.wallet(user.id, 'COP');
      if (mainWallet.availableMinor < amountMinor) {
        throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente en tu cuenta principal Bre-B para recargar la tarjeta', {
          availableMinor: Number(mainWallet.availableMinor),
          requiredMinor: Number(amountMinor),
        });
      }

      let providerRef: string | null = null;
      if (this.d.coinsenda.transferCardPocketFunds) {
        const res = await this.d.coinsenda.transferCardPocketFunds({
          direction: 'to_card',
          amountMinor,
        });
        providerRef = res.transferId || null;
      }

      const now = this.d.clock.now();
      const txnId = newId('txn', now);
      await this.ledger.fundCardPocket(user.id, 'COP', amountMinor, txnId);

      const suffix = card.lastFour && card.lastFour !== '0000' ? ` •••• ${card.lastFour}` : '';
      const txn: Transaction = {
        id: txnId,
        userId: user.id,
        type: 'card_pocket',
        direction: 'out',
        currency: 'COP',
        amountMinor,
        feeMinor: 0n,
        status: 'completed',
        title: 'Recarga a Tarjeta CuyPay',
        subtitle: `Bolsillo ${card.label}${suffix}`,
        description: 'Transferencia sin costo desde tu saldo principal Bre-B',
        conversion: null,
        beneficiaryId: null,
        quoteId: null,
        providerRef: providerRef ?? card.id,
        flagged: false,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.repos.transactions.create(txn);
      await this.d.events.publish({ type: 'transaction.created', txn });

      const [updatedPocket, updatedMain] = await Promise.all([
        this.ledger.cardPocket(user.id, 'COP'),
        this.ledger.wallet(user.id, 'COP'),
      ]);

      await this.syncActiveCardsLimit(user.id, updatedPocket);

      return {
        status: 200,
        body: {
          card: presentCard(card, updatedPocket),
          pocketBalanceMinor: toSafeNumber(updatedPocket),
          mainAvailableMinor: toSafeNumber(updatedMain.availableMinor),
          transaction: presentTransaction(txn),
        },
      };
    };

    return this.mutex.run(user.id, () =>
      input.idempotencyKey
        ? this.idem.run(user.id, `card_fund:${cardId}`, input.idempotencyKey, { cardId, amountMinor: input.amountMinor }, execute)
        : execute(),
    );
  }

  async withdrawPocket(user: User, cardId: string, input: CardPocketTransferInput): Promise<{ status: number; body: CardPocketTransferResult }> {
    requireKycApproved(user);
    await assertNotFrozen(this.d, user.id);
    const amountMinor = BigInt(input.amountMinor);
    if (amountMinor < MIN_CARD_POCKET_TRANSFER_MINOR) {
      throw new AppError('VALIDATION_ERROR', 'El monto mínimo para retirar del bolsillo de tu tarjeta es de $100 COP', {
        minAmountMinor: Number(MIN_CARD_POCKET_TRANSFER_MINOR),
      });
    }

    const execute = async (): Promise<{ status: number; body: CardPocketTransferResult }> => {
      const card = await this.get(user.id, cardId);
      const currentPocket = await this.ledger.cardPocket(user.id, 'COP');
      if (currentPocket < amountMinor) {
        throw new AppError('INSUFFICIENT_FUNDS', 'Saldo insuficiente en el bolsillo de tu tarjeta', {
          availableMinor: Number(currentPocket),
          requiredMinor: Number(amountMinor),
        });
      }

      let providerRef: string | null = null;
      if (this.d.coinsenda.transferCardPocketFunds) {
        const res = await this.d.coinsenda.transferCardPocketFunds({
          direction: 'from_card',
          amountMinor,
        });
        providerRef = res.transferId || null;
      }

      const now = this.d.clock.now();
      const txnId = newId('txn', now);
      await this.ledger.withdrawCardPocket(user.id, 'COP', amountMinor, txnId);

      const suffix = card.lastFour && card.lastFour !== '0000' ? ` •••• ${card.lastFour}` : '';
      const txn: Transaction = {
        id: txnId,
        userId: user.id,
        type: 'card_pocket',
        direction: 'in',
        currency: 'COP',
        amountMinor,
        feeMinor: 0n,
        status: 'completed',
        title: 'Retiro desde Tarjeta CuyPay',
        subtitle: `Hacia tu saldo principal Bre-B${suffix}`,
        description: 'Transferencia sin costo hacia tu saldo principal Bre-B',
        conversion: null,
        beneficiaryId: null,
        quoteId: null,
        providerRef: providerRef ?? card.id,
        flagged: false,
        failureReason: null,
        createdAt: now,
        updatedAt: now,
      };
      await this.d.repos.transactions.create(txn);
      await this.d.events.publish({ type: 'transaction.created', txn });

      const [updatedPocket, updatedMain] = await Promise.all([
        this.ledger.cardPocket(user.id, 'COP'),
        this.ledger.wallet(user.id, 'COP'),
      ]);

      await this.syncActiveCardsLimit(user.id, updatedPocket);

      return {
        status: 200,
        body: {
          card: presentCard(card, updatedPocket),
          pocketBalanceMinor: toSafeNumber(updatedPocket),
          mainAvailableMinor: toSafeNumber(updatedMain.availableMinor),
          transaction: presentTransaction(txn),
        },
      };
    };

    return this.mutex.run(user.id, () =>
      input.idempotencyKey
        ? this.idem.run(user.id, `card_withdraw:${cardId}`, input.idempotencyKey, { cardId, amountMinor: input.amountMinor }, execute)
        : execute(),
    );
  }

  private async syncActiveCardsLimit(userId: string, allowedAmountMinor: bigint): Promise<void> {
    if (!this.d.coinsenda.syncCardSpendingLimit) return;
    const now = this.d.clock.now();
    const activeCards = (await this.d.repos.cards.listByUser(userId)).filter((c) => c.status !== 'canceled' && !isCardExpired(c, now));
    await Promise.all(
      activeCards.map((c) =>
        this.d.coinsenda.syncCardSpendingLimit!({
          providerCardId: c.providerCardId,
          allowedAmountMinor,
          cardLabel: c.label,
        }),
      ),
    );
  }

  /** Sincroniza compras realizadas con tarjeta en Coinsenda Farming hacia el bolsillo del titular. */
  async syncPurchases(): Promise<number> {
    if (!this.d.coinsenda.listCardTransactions) return 0;
    const remoteTxns = await this.d.coinsenda.listCardTransactions();
    let processed = 0;

    for (const rtx of [...remoteTxns].reverse()) {
      if (rtx.state !== 'accepted' || rtx.amountMinor <= 0n) continue;
      const dedupeKey = `card_tx:${rtx.id}`;
      const prev = await this.d.repos.processedDeposits.get(dedupeKey);
      if (prev) continue;

      const card = await this.d.repos.cards.byProviderCardId(rtx.providerCardId);
      if (!card) continue;

      await this.mutex.run(card.userId, async () => {
        const now = this.d.clock.now();
        const txnId = newId('txn', now);
        const inserted = await this.d.repos.processedDeposits.tryInsert({
          providerDepositId: dedupeKey,
          userId: card.userId,
          transactionId: txnId,
          processedAt: now,
          note: 'card_purchase',
        });
        if (!inserted) return;

        const currentPocket = await this.ledger.cardPocket(card.userId, 'COP');
        const pocketDebit = currentPocket >= rtx.amountMinor ? rtx.amountMinor : currentPocket;
        const overflowFromMain = rtx.amountMinor - pocketDebit;

        if (pocketDebit > 0n) {
          await this.ledger.debitCardPurchase(card.userId, 'COP', pocketDebit, txnId);
        }
        if (overflowFromMain > 0n) {
          const mainWallet = await this.ledger.wallet(card.userId, 'COP');
          const mainDebit = mainWallet.availableMinor >= overflowFromMain ? overflowFromMain : mainWallet.availableMinor;
          if (mainDebit > 0n) {
            await this.ledger.post(
              [
                { kind: 'user_available', userId: card.userId, currency: 'COP', amountMinor: -mainDebit },
                { kind: 'breb_settlement', currency: 'COP', amountMinor: mainDebit },
              ],
              txnId,
            );
          }
        }

        const suffix = card.lastFour && card.lastFour !== '0000' ? ` •••• ${card.lastFour}` : '';
        const txn: Transaction = {
          id: txnId,
          userId: card.userId,
          type: 'card_purchase',
          direction: 'out',
          currency: 'COP',
          amountMinor: rtx.amountMinor,
          feeMinor: 0n,
          status: 'completed',
          title: rtx.merchantName || 'Compra con tarjeta',
          subtitle: `Tarjeta CuyPay${suffix}`,
          description: null,
          conversion: null,
          beneficiaryId: null,
          quoteId: null,
          providerRef: rtx.id,
          flagged: false,
          failureReason: null,
          createdAt: rtx.createdAt,
          updatedAt: now,
        };
        await this.d.repos.transactions.create(txn);
        await this.d.events.publish({ type: 'transaction.created', txn });

        const updatedPocket = await this.ledger.cardPocket(card.userId, 'COP');
        await this.syncActiveCardsLimit(card.userId, updatedPocket);
        processed++;
      });
    }

    return processed;
  }

  async updateLabel(userId: string, cardId: string, label: string): Promise<Card> {
    const card = await this.get(userId, cardId);
    const cleanLabel = label.trim().slice(0, 30);
    if (!cleanLabel) throw new AppError('VALIDATION_ERROR', 'El nombre de la tarjeta no puede estar vacío');

    try {
      await this.d.coinsenda.updateCardLabel(card.providerCardId, cleanLabel);
    } catch {
      // Mejor esfuerzo en Coinsenda
    }

    card.label = cleanLabel;
    card.updatedAt = this.d.clock.now();
    await this.d.repos.cards.update(card);
    return card;
  }

  async tokenizeApplePay(userId: string, cardId: string, input: ApplePayTokenizeInput) {
    const card = await this.getUsable(userId, cardId, 'vincularla a Apple Pay');
    if (card.status !== 'active') throw new AppError('VALIDATION_ERROR', 'La tarjeta debe estar activa para vincular a Apple Pay');

    try {
      return await this.d.coinsenda.tokenizeApplePay({
        providerCardId: card.providerCardId,
        certificates: input.certificates,
        nonce: input.nonce,
        nonceSignature: input.nonceSignature,
      });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('PROVIDER_ERROR', 'No se pudo autorizar el pase de Apple Pay en Coinsenda');
    }
  }
}
