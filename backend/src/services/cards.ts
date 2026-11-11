import { createHash } from 'node:crypto';
import type { Card, CardStatus, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { CardHolderInput } from '../ports/index.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';

export interface IssueCardInput {
  label?: string;
}

export interface ApplePayTokenizeInput {
  certificates: string[];
  nonce: string;
  nonceSignature: string;
}

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
  constructor(private readonly d: ServiceDeps) {}

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

  private async resolveHolderFromKyc(user: User, existingCards: Card[]): Promise<CardHolderInput> {
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

    const firstName = (kycProfile?.firstName || user.firstName).trim();
    const lastName = (kycProfile?.lastName || user.lastName).trim();
    const email = (user.email || kycProfile?.email || '').trim().toLowerCase();
    const phone = (user.phone || kycProfile?.phone || '').trim();

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
      documentNumber = deterministicSandboxDocumentNumber(user.id);
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

    const existingCardHolderId =
      kycRec?.providerCardHolderId ??
      existingCards.find((c) => c.providerCardHolderId)?.providerCardHolderId ??
      null;

    return {
      firstName,
      lastName,
      email,
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

    const holder = await this.resolveHolderFromKyc(user, existing);
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

  async updateWorkingState(userId: string, cardId: string, newState: CardStatus): Promise<Card> {
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
    return card;
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
