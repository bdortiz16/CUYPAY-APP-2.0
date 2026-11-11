import type { Card, CardStatus, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError, isAppError } from '../lib/errors.js';
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

/**
 * Servicio de tarjetas virtuales y físicas (respaldado por Coinsenda Farming & Marketplace).
 */
export class CardService {
  constructor(private readonly d: ServiceDeps) {}

  async list(userId: string): Promise<Card[]> {
    return this.d.repos.cards.listByUser(userId);
  }

  async get(userId: string, cardId: string): Promise<Card> {
    const card = await this.d.repos.cards.byId(cardId);
    if (!card || card.userId !== userId) throw new AppError('NOT_FOUND', 'Tarjeta no encontrada');
    return card;
  }

  async issueVirtual(user: User, input?: IssueCardInput): Promise<Card> {
    requireKycApproved(user);
    const existing = await this.d.repos.cards.listByUser(user.id);
    const active = existing.filter((c) => c.status !== 'canceled');
    if (active.length >= 3) {
      throw new AppError('VALIDATION_ERROR', 'Límite de tarjetas activas alcanzado (máximo 3)');
    }

    const holderName = `${user.firstName} ${user.lastName}`.trim();
    const cardLabel = input?.label?.trim() || 'CuyPay Virtual';
    let issued;
    try {
      issued = await this.d.coinsenda.issueCard({
        userId: user.id,
        holderName,
        email: user.email,
        currency: 'COP',
        label: cardLabel,
      });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError('PROVIDER_ERROR', 'No se pudo emitir la tarjeta en Coinsenda', { provider: 'coinsenda' });
    }

    const now = this.d.clock.now();
    const card: Card = {
      id: newId('crd', now),
      userId: user.id,
      cardType: 'virtual',
      status: issued.status,
      label: cardLabel,
      lastFour: issued.lastFour,
      brand: issued.brand,
      currency: 'COP',
      providerCardId: issued.providerCardId,
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
      return await this.d.coinsenda.getCardLookUrl(card.providerCardId);
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
