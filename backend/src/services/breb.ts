import { randomInt } from 'node:crypto';
import type { BrebKey, User } from '../domain/types.js';
import { newId } from '../lib/clock.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';
import { requireKycApproved } from './kyc.js';

export const CORPORATE_BREB_PREFIX = 'xatechservic';

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

/**
 * Llave Bre-B propia (recibir COP).
 * Siempre generada automáticamente de forma genérica por el sistema / red Bre-B.
 */
export class BrebService {
  constructor(private readonly d: ServiceDeps) {}

  private get isLiveMode(): boolean {
    return this.d.config.PROVIDERS_MODE === 'live';
  }

  async get(userId: string): Promise<BrebKey> {
    const key = await this.d.repos.brebKeys.byUser(userId);
    if (!key) throw new AppError('NOT_FOUND', 'Aún no tienes llave Bre-B');

    if (key.status === 'pending' && key.providerKeyId && this.d.coinsenda.syncBrebKey) {
      try {
        const synced = await withTimeout(this.d.coinsenda.syncBrebKey(key.providerKeyId), 2_500);
        if (synced) {
          if (synced.status === 'canceled') {
            key.status = 'replaced';
            await this.d.repos.brebKeys.update(key);
            throw new AppError('NOT_FOUND', 'Aún no tienes llave Bre-B');
          }
          let changed = false;
          if (synced.alias && synced.alias !== key.alias) {
            key.alias = synced.alias;
            changed = true;
          }
          if (synced.status !== key.status) {
            key.status = synced.status;
            changed = true;
          }
          if (changed) {
            await this.d.repos.brebKeys.update(key);
          }
        }
      } catch (err) {
        if (isAppError(err) && err.code === 'NOT_FOUND') throw err;
        // Mejor esfuerzo: si el proveedor tarda, devolvemos el estado almacenado.
      }
    }

    return key;
  }

  private generateSystemAlias(): string {
    const code = randomInt(100000, 1000000);
    if (this.isLiveMode) {
      return `@${CORPORATE_BREB_PREFIX}${code}`;
    }
    return `@cuypay${code}`;
  }

  private async isFree(alias: string): Promise<boolean> {
    if (await this.d.repos.brebKeys.byAlias(alias)) return false;
    try {
      return (await withTimeout(this.d.coinsenda.resolveBrebAlias(alias), 3_500)) === null;
    } catch (err) {
      if (isAppError(err) && err.code === 'BREB_ALIAS_TAKEN') return false;
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
          .map((k) => withTimeout(this.d.coinsenda.cancelBrebKey!(k.providerKeyId), 5_000)),
      );
    }
    return activeOrStale;
  }

  async create(user: User, _ignoredPreferredAlias?: string): Promise<BrebKey> {
    requireKycApproved(user);
    if (await this.d.repos.brebKeys.byUser(user.id)) {
      throw new AppError('BREB_KEY_EXISTS', 'Ya tienes una llave Bre-B activa.');
    }

    let alias: string;
    if (this.isLiveMode) {
      alias = this.generateSystemAlias();
    } else {
      let found: string | null = null;
      for (let i = 0; i < 10 && !found; i++) {
        const candidate = this.generateSystemAlias();
        if (await this.isFree(candidate)) found = candidate;
      }
      alias = found ?? `@cuypay${Date.now().toString().slice(-8)}`;
    }

    const [allActive, userHistory] = await Promise.all([
      this.d.repos.brebKeys.listActive(),
      this.d.repos.brebKeys.listByUser(user.id),
    ]);
    const activeOtherProviderIds = allActive
      .filter((k) => k.userId !== user.id && Boolean(k.providerKeyId))
      .map((k) => k.providerKeyId);
    const retiredUserProviderIds = userHistory
      .filter((k) => k.status === 'replaced' && Boolean(k.providerKeyId))
      .map((k) => k.providerKeyId);

    const holderName = `${user.firstName} ${user.lastName}`.trim();
    let created;
    try {
      created = await this.d.coinsenda.createBrebKey({
        alias,
        holderName,
        userRef: user.id,
        activeOtherProviderIds,
        retiredUserProviderIds,
      });
    } catch (err) {
      if (isAppError(err)) throw err;
      this.d.logger.error({ err, userId: user.id }, 'createBrebKey failed');
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

  async change(user: User, _ignoredPreferredAlias?: string): Promise<BrebKey> {
    requireKycApproved(user);
    await this.retireAllUserAliasKeys(user.id);
    return this.create(user);
  }

  async delete(user: User): Promise<void> {
    // Idempotente y exhaustivo: retira cualquier llave activa, pendiente o bloqueada previa del usuario
    // para que GET /v1/breb/key devuelva 404 de inmediato y nunca quede una llave fantasma en pantalla.
    await this.retireAllUserAliasKeys(user.id);
  }
}

