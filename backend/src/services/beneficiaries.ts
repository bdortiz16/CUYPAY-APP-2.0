import type { AmlCheck, Beneficiary, BrebResolution, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';

const RESOLUTION_TTL_MS = 10 * 60_000;

/** "Juan Pérez" → "JUAN P***Z" */
export function maskHolderName(firstName: string, lastName: string): string {
  const first = firstName.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  const last = lastName.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (!last) return first;
  if (last.length <= 2) return `${first} ${last[0]}***`;
  return `${first} ${last[0]}***${last[last.length - 1]}`;
}

export const maskDocument = (doc: string): string => `****${doc.slice(-4)}`;

/** Normaliza la llave a consultar: celulares/documentos sin espacios; alias @ en minúsculas. */
export function normalizeBeneficiaryAlias(alias: string): string {
  const a = alias.trim();
  if (a.startsWith('@')) return a.toLowerCase();
  return a.replace(/[\s-]/g, '');
}

/** Inscripción de beneficiarios: resolución Bre-B → AML (Sartblock) → cuenta destino en Coinsenda. */
export class BeneficiaryService {
  constructor(private readonly d: ServiceDeps) {}

  async resolve(user: User, rawAlias: string): Promise<BrebResolution> {
    requireKycApproved(user);
    const alias = normalizeBeneficiaryAlias(rawAlias);
    if (!alias || alias.length > 64) throw new AppError('VALIDATION_ERROR', 'Llave inválida', { field: 'alias' });
    const holder = await this.d.coinsenda.resolveBrebAlias(alias);
    if (!holder) throw new AppError('BREB_ALIAS_NOT_FOUND', 'La llave Bre-B no existe', { alias });
    const now = this.d.clock.now();
    const res: BrebResolution = {
      id: newId('res', now),
      userId: user.id,
      alias,
      holderFirstName: holder.firstName,
      holderLastName: holder.lastName,
      documentType: holder.documentType,
      documentNumber: holder.documentNumber,
      bankName: holder.bankName,
      raw: holder.raw,
      expiresAt: new Date(now.getTime() + RESOLUTION_TTL_MS),
      createdAt: now,
    };
    await this.d.repos.resolutions.create(res);
    return res;
  }

  async create(user: User, input: { resolutionId: string; nickname?: string }): Promise<{ beneficiary: Beneficiary; aml: AmlCheck }> {
    requireKycApproved(user);
    const now = this.d.clock.now();
    const res = await this.d.repos.resolutions.byId(input.resolutionId);
    if (!res || res.userId !== user.id) throw new AppError('NOT_FOUND', 'Resolución no encontrada');
    if (res.expiresAt <= now) throw new AppError('VALIDATION_ERROR', 'La resolución venció, consulta la llave de nuevo', { field: 'resolutionId' });

    // Si ya existe un beneficiario vigente (no eliminado ni rechazado) con esa llave, se devuelve.
    const existing = (await this.d.repos.beneficiaries.listByUser(user.id)).find(
      (b) => b.alias === res.alias && !b.deletedAt && b.status !== 'rejected',
    );
    if (existing) {
      if (existing.status === 'active' && !existing.providerWithdrawAccountId) {
        try {
          await this.ensureWithdrawAccount(existing);
        } catch (err) {
          this.d.logger.warn({ err: (err as Error).message, beneficiaryId: existing.id }, 'could not backfill withdraw account');
        }
      }
      const aml = await this.d.repos.aml.byId(existing.amlCheckId);
      if (aml) return { beneficiary: existing, aml };
    }

    const fullName = `${res.holderFirstName} ${res.holderLastName}`.trim();
    const beneficiaryId = newId('ben', now);
    const screening = await this.d.aml.screen({
      fullName,
      documentType: res.documentType,
      documentNumber: res.documentNumber,
      country: 'CO',
    });
    const aml: AmlCheck = {
      id: newId('aml', now),
      userId: user.id,
      subjectType: 'beneficiary',
      subjectId: beneficiaryId,
      provider: 'sartblock',
      result: screening.result,
      referenceId: screening.referenceId,
      checkedAt: this.d.clock.now(),
      raw: screening.raw,
    };
    await this.d.repos.aml.create(aml);

    const beneficiary: Beneficiary = {
      id: beneficiaryId,
      userId: user.id,
      alias: res.alias,
      holderName: fullName,
      documentType: res.documentType,
      documentNumber: res.documentNumber,
      nickname: input.nickname?.trim() || null,
      bankName: res.bankName,
      status: screening.result === 'clear' ? 'active' : screening.result === 'hit' ? 'rejected' : 'pending_review',
      amlCheckId: aml.id,
      providerWithdrawAccountId: null,
      createdAt: now,
      deletedAt: null,
    };

    if (beneficiary.status === 'active') {
      try {
        beneficiary.providerWithdrawAccountId = await this.registerWithdrawAccount(res, beneficiary);
      } catch (err) {
        this.d.logger.warn({ err: (err as Error).message, beneficiaryId }, 'Coinsenda no tiene activo módulo de retiros; beneficiario guardado en CuyPay');
      }
    }
    await this.d.repos.beneficiaries.create(beneficiary);
    await this.d.events.publish({ type: 'beneficiary.screened', beneficiary, aml });
    if (beneficiary.status === 'pending_review') await this.d.events.publish({ type: 'beneficiary.review_required', beneficiary });

    if (beneficiary.status === 'rejected') {
      // TODO(compliance): notificar al oficial de cumplimiento / evaluar ROS ante la UIAF.
      this.d.logger.warn({ userId: user.id, beneficiaryId, amlRef: aml.referenceId }, 'aml hit on beneficiary');
    }
    return { beneficiary, aml };
  }

  async ensureWithdrawAccount(b: Beneficiary): Promise<Beneficiary> {
    if (b.providerWithdrawAccountId) return b;
    const parts = b.holderName.trim().split(/\s+/);
    const firstName = parts[0] ?? b.holderName;
    const lastName = parts.slice(1).join(' ');
    const { withdrawAccountId } = await this.d.coinsenda.addWithdrawAccount({
      holder: {
        alias: b.alias,
        firstName,
        lastName,
        documentType: b.documentType,
        documentNumber: b.documentNumber,
        bankName: b.bankName,
        raw: null,
      },
      label: `cuypay:${b.userId}:${b.id}`,
    });
    b.providerWithdrawAccountId = withdrawAccountId;
    await this.d.repos.beneficiaries.update(b);
    return b;
  }

  private async registerWithdrawAccount(res: BrebResolution, b: Beneficiary): Promise<string> {
    const { withdrawAccountId } = await this.d.coinsenda.addWithdrawAccount({
      holder: {
        alias: res.alias,
        firstName: res.holderFirstName,
        lastName: res.holderLastName,
        documentType: res.documentType,
        documentNumber: res.documentNumber,
        bankName: res.bankName,
        raw: res.raw,
      },
      label: `cuypay:${b.userId}:${b.id}`,
    });
    return withdrawAccountId;
  }

  async list(userId: string) {
    const items = (await this.d.repos.beneficiaries.listByUser(userId)).filter((b) => !b.deletedAt);
    const out: { beneficiary: Beneficiary; aml: AmlCheck | null }[] = [];
    for (const b of items) out.push({ beneficiary: b, aml: await this.d.repos.aml.byId(b.amlCheckId) });
    return out;
  }

  async getOwned(userId: string, id: string): Promise<Beneficiary> {
    const b = await this.d.repos.beneficiaries.byId(id);
    if (!b || b.userId !== userId || b.deletedAt) throw new AppError('NOT_FOUND', 'Beneficiario no encontrado');
    return b;
  }

  async remove(userId: string, id: string): Promise<void> {
    const b = await this.getOwned(userId, id);
    b.deletedAt = this.d.clock.now();
    await this.d.repos.beneficiaries.update(b);
    if (b.providerWithdrawAccountId) {
      try {
        await this.d.coinsenda.hideWithdrawAccount(b.providerWithdrawAccountId);
      } catch (err) {
        this.d.logger.warn({ beneficiaryId: id, err: (err as Error).message }, 'could not hide withdraw account');
      }
    }
  }

  /** Decisión del oficial de cumplimiento sobre un beneficiario en pending_review (ruta admin). */
  async review(id: string, decision: 'approve' | 'reject'): Promise<Beneficiary> {
    const b = await this.d.repos.beneficiaries.byId(id);
    if (!b || b.deletedAt) throw new AppError('NOT_FOUND', 'Beneficiario no encontrado');
    if (b.status !== 'pending_review') throw new AppError('VALIDATION_ERROR', 'El beneficiario no está en revisión');
    if (decision === 'reject') {
      b.status = 'rejected';
    } else {
      const { withdrawAccountId } = await this.d.coinsenda.addWithdrawAccount({
        holder: {
          alias: b.alias,
          firstName: b.holderName.split(' ')[0] ?? b.holderName,
          lastName: b.holderName.split(' ').slice(1).join(' '),
          documentType: b.documentType,
          documentNumber: b.documentNumber,
          bankName: b.bankName,
          raw: null,
        },
        label: `cuypay:${b.userId}:${b.id}`,
      });
      b.providerWithdrawAccountId = withdrawAccountId;
      b.status = 'active';
    }
    await this.d.repos.beneficiaries.update(b);
    return b;
  }
}
