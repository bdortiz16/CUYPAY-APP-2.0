import { stableHash } from '../lib/crypto.js';
import { AppError, isAppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';

export interface IdemResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotencia por (usuario, ámbito, clave):
 *  - misma clave + mismo cuerpo → misma respuesta (replay, sin re-ejecutar);
 *  - misma clave + cuerpo distinto → 409 IDEMPOTENCY_CONFLICT;
 *  - si la operación falla con error de negocio (4xx) la clave se libera para reintentar.
 *  - si falla después de crear una transacción (p. ej. PROVIDER_ERROR con la tx ya
 *    registrada como failed), se guarda el error para que el reintento no duplique.
 * Las llamadas deben ir dentro del mutex del usuario.
 */
export class IdempotencyService {
  constructor(private readonly d: ServiceDeps) {}

  async run<T>(
    userId: string,
    scope: string,
    key: string,
    body: unknown,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdemResult<T>> {
    const requestHash = stableHash(body);
    const existing = await this.d.repos.idempotency.get(userId, scope, key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'La idempotencyKey ya se usó con otro cuerpo', { idempotencyKey: key });
      }
      if (existing.status === 'in_progress') {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Operación en curso con esta idempotencyKey', { idempotencyKey: key });
      }
      const stored = existing.responseBody as { error?: { code: string; message: string; details: Record<string, unknown> } };
      if (existing.responseStatus && existing.responseStatus >= 400 && stored?.error) {
        throw new AppError(stored.error.code as never, stored.error.message, stored.error.details, existing.responseStatus);
      }
      return { status: existing.responseStatus ?? 200, body: existing.responseBody as T, replayed: true };
    }
    const inserted = await this.d.repos.idempotency.tryInsert({
      userId,
      scope,
      key,
      requestHash,
      status: 'in_progress',
      responseStatus: null,
      responseBody: null,
      createdAt: this.d.clock.now(),
    });
    if (!inserted) throw new AppError('IDEMPOTENCY_CONFLICT', 'Operación en curso con esta idempotencyKey', { idempotencyKey: key });
    try {
      const res = await fn();
      await this.d.repos.idempotency.complete(userId, scope, key, res.status, res.body);
      return { ...res, replayed: false };
    } catch (err) {
      if (isAppError(err) && err.details.transactionId) {
        await this.d.repos.idempotency.complete(userId, scope, key, err.status, err.toBody());
      } else {
        await this.d.repos.idempotency.remove(userId, scope, key);
      }
      throw err;
    }
  }
}
