import { createHash } from 'node:crypto';
import { presentCard, presentTransaction, type TransactionJson } from '../domain/presenters.js';
import type { Card, CardStatus, Transaction, User } from '../domain/types.js';
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
}

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
    return this.syncCardsIfNeeded(cards);
  }

  async get(userId: string, cardId: string): Promise<Card> {
    const card = await this.d.repos.cards.byId(cardId);
    if (!card || card.userId !== userId) throw new AppError('NOT_FOUND', 'Tarjeta no encontrada');
    const [synced] = await this.syncCardsIfNeeded([card]);
    return synced ?? card;
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

  async issueVirtual(user: User, input?: IssueCardInput): Promise<Card> {
    requireKycApproved(user);
    const existing = await this.d.repos.cards.listByUser(user.id);
    const active = existing.filter((c) => c.status !== 'canceled');
    if (active.length >= 3) {
      throw new AppError('VALIDATION_ERROR', 'Límite de tarjetas activas alcanzado (máximo 3)');
    }

    const holder = await this.resolveHolderFromKyc(user);
    const holderName = `${holder.firstName} ${holder.lastName}`.trim();
    const cardLabel = input?.label?.trim() || 'CuyPay Virtual';
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
      createdAt: now,
      updatedAt: now,
    };
    await this.d.repos.cards.create(card);
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
    const card = await this.get(userId, cardId);
    if (card.status === 'canceled') throw new AppError('VALIDATION_ERROR', 'La tarjeta está cancelada');
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

    try {
      await this.d.coinsenda.updateCardWorkingState(card.providerCardId, newState);
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('PROVIDER_ERROR', 'No se pudo actualizar el estado de la tarjeta');
    }

    card.status = newState;
    card.updatedAt = this.d.clock.now();
    await this.d.repos.cards.update(card);

    // Si el usuario elimina definitivamente su última tarjeta activa y no va a emitir reemplazo inmediato,
    // devolvemos automáticamente el saldo del bolsillo de tarjeta a su saldo principal Bre-B.
    if (newState === 'canceled' && !opts?.preservePocket) {
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
            description: 'Reintegro automático al eliminar tarjeta virtual',
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

    return card;
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
      const card = await this.get(user.id, cardId);
      if (card.status === 'canceled') {
        throw new AppError('VALIDATION_ERROR', 'No puedes recargar una tarjeta cancelada');
      }

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
    const activeCards = (await this.d.repos.cards.listByUser(userId)).filter((c) => c.status !== 'canceled');
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
    const card = await this.get(userId, cardId);
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
