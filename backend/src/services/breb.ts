import { randomInt } from 'node:crypto';
import type { BrebKey, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';

const ALIAS_RE = /^@[a-z0-9]{3,20}$/;

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Llave Bre-B propia (recibir COP). */
export class BrebService {
  constructor(private readonly d: ServiceDeps) {}

  async get(userId: string): Promise<BrebKey> {
    const key = await this.d.repos.brebKeys.byUser(userId);
    if (!key) throw new AppError('NOT_FOUND', 'Aún no tienes llave Bre-B');
    return key;
  }

  normalizeAlias(input: string): string {
    const a = input.trim().toLowerCase();
    const withAt = a.startsWith('@') ? a : `@${a}`;
    if (!ALIAS_RE.test(withAt)) {
      throw new AppError('VALIDATION_ERROR', 'La llave debe ser @ seguido de 3 a 20 letras o números', { field: 'preferredAlias' });
    }
    return withAt;
  }

  private generateAlias(user: User): string {
    const base = `@cuypay${slug(user.firstName).slice(0, 10)}`;
    return `${base}${randomInt(100, 1000)}`;
  }

  private async isFree(alias: string): Promise<boolean> {
    if (await this.d.repos.brebKeys.byAlias(alias)) return false;
    try {
      return (await this.d.coinsenda.resolveBrebAlias(alias)) === null;
    } catch (err) {
      if (isAppError(err) && err.code === 'BREB_ALIAS_TAKEN') return false;
      this.d.logger.warn({ alias, err }, 'resolveBrebAlias no disponible o falló; procediendo a creación directa');
      return true;
    }
  }

  async create(user: User, preferredAlias?: string): Promise<BrebKey> {
    requireKycApproved(user);
    if (await this.d.repos.brebKeys.byUser(user.id)) throw new AppError('BREB_KEY_EXISTS', 'Ya tienes una llave Bre-B');

    let alias: string;
    if (preferredAlias) {
      alias = this.normalizeAlias(preferredAlias);
      if (!(await this.isFree(alias))) throw new AppError('BREB_ALIAS_TAKEN', 'Esa llave ya está tomada', { alias });
    } else {
      let found: string | null = null;
      for (let i = 0; i < 8 && !found; i++) {
        const candidate = this.generateAlias(user);
        if (await this.isFree(candidate)) found = candidate;
      }
      if (!found) throw new AppError('BREB_ALIAS_TAKEN', 'No se pudo generar una llave libre, intenta con una preferida');
      alias = found;
    }

    const holderName = `${user.firstName} ${user.lastName}`.trim();
    let created;
    try {
      created = await this.d.coinsenda.createBrebKey({ alias, holderName, userRef: user.id });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError(
        'PROVIDER_ERROR',
        'El servicio de Bre-B (Coinsenda / Banco de la República) se encuentra en mantenimiento temporal. Por favor inténtalo en unos minutos.',
        { provider: 'coinsenda' }
      );
    }
    const now = this.d.clock.now();
    const key: BrebKey = {
      id: newId('brk', now),
      userId: user.id,
      alias: created.alias,
      status: created.status,
      holderName,
      providerKeyId: created.providerKeyId,
      createdAt: now,
    };
    await this.d.repos.brebKeys.create(key);
    return key;
  }

  async list(userId: string): Promise<BrebKey[]> {
    const keys = await this.d.repos.brebKeys.listByUser(userId);
    return keys;
  }

  async change(user: User, newPreferredAlias: string): Promise<BrebKey> {
    requireKycApproved(user);
    const existing = await this.d.repos.brebKeys.byUser(user.id);
    if (!existing) {
      return this.create(user, newPreferredAlias);
    }

    const alias = this.normalizeAlias(newPreferredAlias);
    if (alias === existing.alias) {
      return existing;
    }
    if (!(await this.isFree(alias))) {
      throw new AppError('BREB_ALIAS_TAKEN', 'Esa llave ya está tomada', { alias });
    }

    // Cancelar en Coinsenda
    if (this.d.coinsenda.cancelBrebKey) {
      try {
        await this.d.coinsenda.cancelBrebKey(existing.providerKeyId);
      } catch {
        // Mejor esfuerzo
      }
    }
    // Marcar la llave anterior como 'replaced' para preservar el historial de depósitos
    existing.status = 'replaced';
    await this.d.repos.brebKeys.update(existing);

    // Crear la nueva
    const holderName = `${user.firstName} ${user.lastName}`.trim();
    let created;
    try {
      created = await this.d.coinsenda.createBrebKey({ alias, holderName, userRef: user.id });
    } catch (err) {
      if (isAppError(err)) throw err;
      throw new AppError(
        'PROVIDER_ERROR',
        'El servicio de Bre-B (Coinsenda / Banco de la República) se encuentra en mantenimiento temporal. Por favor inténtalo en unos minutos.',
        { provider: 'coinsenda' }
      );
    }
    const now = this.d.clock.now();
    const newKey: BrebKey = {
      id: newId('brk', now),
      userId: user.id,
      alias: created.alias,
      status: created.status,
      holderName,
      providerKeyId: created.providerKeyId,
      createdAt: now,
    };
    await this.d.repos.brebKeys.create(newKey);
    return newKey;
  }

  async delete(user: User): Promise<void> {
    const existing = await this.d.repos.brebKeys.byUser(user.id);
    if (!existing) throw new AppError('NOT_FOUND', 'No tienes llave Bre-B registrada');

    if (this.d.coinsenda.cancelBrebKey) {
      try {
        await this.d.coinsenda.cancelBrebKey(existing.providerKeyId);
      } catch {
        // Mejor esfuerzo
      }
    }
    existing.status = 'blocked';
    await this.d.repos.brebKeys.update(existing);
  }
}
