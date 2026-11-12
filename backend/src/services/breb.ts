import { randomInt } from 'node:crypto';
import type { BrebKey, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';

export const CORPORATE_BREB_PREFIX = 'xatechservic';

const GENERIC_ALIAS_RE = /^@[a-z0-9](?:[a-z0-9.]{1,34}[a-z0-9])?$/;
const SUFFIX_RE = /^[a-z0-9](?:[a-z0-9.]{1,18}[a-z0-9])?$/;

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

function normalizeCorporateTypos(handleWithoutAt: string): string {
  let lower = handleWithoutAt.toLowerCase().replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  // Corrige variante común escrita sin 'v' (@xatechseric -> @xatechservic)
  if (lower.startsWith('xatechseric') && !lower.startsWith(CORPORATE_BREB_PREFIX) && lower.length > 'xatechseric'.length) {
    lower = CORPORATE_BREB_PREFIX + lower.slice('xatechseric'.length).replace(/^\.+/, '');
  }
  // Evita duplicación accidental (@xatechservicxatechservicbryan039 -> @xatechservicbryan039)
  const doubled = CORPORATE_BREB_PREFIX + CORPORATE_BREB_PREFIX;
  if (lower.startsWith(doubled) && lower.length > doubled.length) {
    lower = CORPORATE_BREB_PREFIX + lower.slice(doubled.length).replace(/^\.+/, '');
  }
  return lower;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('breb_timeout')), ms);
    timer.unref?.();
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Llave Bre-B propia (recibir COP). */
export class BrebService {
  constructor(private readonly d: ServiceDeps) {}

  private get isLiveMode(): boolean {
    return this.d.config.PROVIDERS_MODE === 'live';
  }

  async get(userId: string): Promise<BrebKey> {
    const key = await this.d.repos.brebKeys.byUser(userId);
    if (!key) throw new AppError('NOT_FOUND', 'Aún no tienes llave Bre-B');
    return key;
  }

  normalizeAlias(input: string): string {
    const raw = input.trim().toLowerCase().replace(/\s+/g, '').replace(/^@+/, '');
    const cleaned = normalizeCorporateTypos(raw);

    if (cleaned.startsWith(CORPORATE_BREB_PREFIX) && cleaned.length > CORPORATE_BREB_PREFIX.length) {
      const suffix = cleaned.slice(CORPORATE_BREB_PREFIX.length).replace(/^\.+|\.+$/g, '');
      if (suffix.length < 3 || suffix.length > 16 || !SUFFIX_RE.test(suffix)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Después de @${CORPORATE_BREB_PREFIX} escribe de 3 a 16 letras o números (ej. bryan039 o 1019).`,
          { field: 'preferredAlias' },
        );
      }
      return `@${CORPORATE_BREB_PREFIX}${suffix}`;
    }

    if (this.isLiveMode) {
      const suffix = cleaned.replace(/^\.+|\.+$/g, '');
      if (suffix.length < 3 || suffix.length > 16 || !SUFFIX_RE.test(suffix)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Escribe de 3 a 16 letras o números para tu llave @${CORPORATE_BREB_PREFIX} (ej. bryan039 o 1019).`,
          { field: 'preferredAlias' },
        );
      }
      return `@${CORPORATE_BREB_PREFIX}${suffix}`;
    }

    const withAt = `@${cleaned}`;
    if (cleaned.length < 3 || !GENERIC_ALIAS_RE.test(withAt)) {
      throw new AppError('VALIDATION_ERROR', 'La llave debe tener entre 3 y 20 letras o números.', {
        field: 'preferredAlias',
      });
    }
    return withAt;
  }

  private generateAlias(user: User): string {
    if (this.isLiveMode) {
      const base = slug(user.firstName).slice(0, 5) || 'cuy';
      return `@${CORPORATE_BREB_PREFIX}${base}${randomInt(100, 1000)}`;
    }
    const base = `@cuypay${slug(user.firstName).slice(0, 10)}`;
    return `${base}${randomInt(100, 1000)}`;
  }

  private async isFree(alias: string): Promise<boolean> {
    if (await this.d.repos.brebKeys.byAlias(alias)) return false;
    try {
      return (await withTimeout(this.d.coinsenda.resolveBrebAlias(alias), 3_500)) === null;
    } catch (err) {
      if (isAppError(err) && err.code === 'BREB_ALIAS_TAKEN') return false;
      this.d.logger.warn({ alias, err: (err as Error)?.message }, 'resolveBrebAlias lento o no disponible; procediendo a creación directa');
      return true;
    }
  }

  private async retireAllUserAliasKeys(userId: string): Promise<BrebKey[]> {
    const all = await this.d.repos.brebKeys.listByUser(userId);
    const activeOrStale = all.filter((k) => k.status !== 'replaced' && k.type !== 'national_id');
    for (const key of activeOrStale) {
      key.status = 'replaced';
      await this.d.repos.brebKeys.update(key);
    }
    if (this.d.coinsenda.cancelBrebKey && activeOrStale.length > 0) {
      await Promise.allSettled(
        activeOrStale
          .filter((k) => Boolean(k.providerKeyId))
          .map((k) => withTimeout(this.d.coinsenda.cancelBrebKey!(k.providerKeyId), 4_500)),
      );
    }
    return activeOrStale;
  }

  async create(user: User, preferredAlias?: string): Promise<BrebKey> {
    requireKycApproved(user);
    if (await this.d.repos.brebKeys.byUser(user.id)) {
      throw new AppError('BREB_KEY_EXISTS', 'Ya tienes una llave Bre-B activa.');
    }

    let alias: string;
    if (preferredAlias && preferredAlias.trim()) {
      alias = this.normalizeAlias(preferredAlias);
      if (!(await this.isFree(alias))) {
        throw new AppError('BREB_ALIAS_TAKEN', 'Esa llave ya está en uso. Prueba con otra combinación.', { alias });
      }
    } else {
      let found: string | null = null;
      for (let i = 0; i < 8 && !found; i++) {
        const candidate = this.generateAlias(user);
        if (await this.isFree(candidate)) found = candidate;
      }
      if (!found) {
        throw new AppError('BREB_ALIAS_TAKEN', 'No pudimos encontrar una llave libre automática, escribe una personalizada.');
      }
      alias = found;
    }

    const holderName = `${user.firstName} ${user.lastName}`.trim();
    let created;
    try {
      created = await this.d.coinsenda.createBrebKey({ alias, holderName, userRef: user.id });
    } catch (err) {
      if (isAppError(err)) throw err;
      this.d.logger.error({ err, userId: user.id, alias }, 'createBrebKey failed');
      throw new AppError(
        'PROVIDER_ERROR',
        'La red Bre-B del Banco de la República está tardando en responder. Inténtalo de nuevo en unos segundos.',
      );
    }
    const now = this.d.clock.now();
    const key: BrebKey = {
      id: newId('brk', now),
      userId: user.id,
      type: 'alias',
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
    return this.d.repos.brebKeys.listByUser(userId);
  }

  async change(user: User, newPreferredAlias: string): Promise<BrebKey> {
    requireKycApproved(user);
    const existing = await this.d.repos.brebKeys.byUser(user.id);
    if (!existing) {
      return this.create(user, newPreferredAlias);
    }

    const alias = this.normalizeAlias(newPreferredAlias);
    if (alias.toLowerCase() === existing.alias.toLowerCase()) {
      return existing;
    }
    if (!(await this.isFree(alias))) {
      throw new AppError('BREB_ALIAS_TAKEN', 'Esa llave ya está en uso. Prueba con otra combinación.', { alias });
    }

    // Retirar todas las llaves previas activas/bloqueadas del usuario para preservar trazabilidad de depósitos
    await this.retireAllUserAliasKeys(user.id);

    const holderName = `${user.firstName} ${user.lastName}`.trim();
    let created;
    try {
      created = await this.d.coinsenda.createBrebKey({ alias, holderName, userRef: user.id });
    } catch (err) {
      if (isAppError(err)) throw err;
      this.d.logger.error({ err, userId: user.id, alias }, 'changeBrebKey failed');
      throw new AppError(
        'PROVIDER_ERROR',
        'La red Bre-B del Banco de la República está tardando en responder. Inténtalo de nuevo en unos segundos.',
      );
    }
    const now = this.d.clock.now();
    const newKey: BrebKey = {
      id: newId('brk', now),
      userId: user.id,
      type: 'alias',
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
    // Idempotente y exhaustivo: retira cualquier llave activa, pendiente o bloqueada previa del usuario
    // para que GET /v1/breb/key devuelva 404 de inmediato y nunca quede una llave fantasma en pantalla.
    await this.retireAllUserAliasKeys(user.id);
  }
}
