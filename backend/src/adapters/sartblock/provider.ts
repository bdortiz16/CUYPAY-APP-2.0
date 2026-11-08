import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AmlResult } from '../../domain/types.js';
import { AppError } from '../../lib/errors.js';
import type { AmlProvider, AmlScreenInput } from '../../ports/index.js';

/**
 * AML simulado: nombres con "BLOQUEADO" → hit; con "REVISION" → review; resto → clear.
 * (Comparación sin tildes ni mayúsculas.)
 */
export class MockAmlProvider implements AmlProvider {
  async screen(input: AmlScreenInput) {
    const n = input.fullName.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
    const result: AmlResult = n.includes('BLOQUEADO') ? 'hit' : n.includes('REVISION') ? 'review' : 'clear';
    return { result, referenceId: `sb_mock_${randomUUID()}`, raw: { mock: true } };
  }
}

export interface LiveSartblockOptions {
  baseUrl: string;
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Adaptador HTTP genérico para Sartblock.
 * TODO(sartblock): la especificación de la API no está disponible. Confirmar ruta,
 * autenticación, nombres de campos, catálogo de resultados y si la consulta es
 * síncrona o por webhook. Lo de abajo es una suposición razonable y debe validarse.
 */
export class LiveSartblockProvider implements AmlProvider {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: LiveSartblockOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** TODO(sartblock): usar el endpoint de estado real cuando se conozca la especificación. */
  async healthCheck(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl, { method: 'GET', headers: { Authorization: `Bearer ${this.opts.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new AppError('PROVIDER_ERROR', `Sartblock no respondió: ${(err as Error).message}`, { provider: 'sartblock' });
    }
    if (res.status >= 500) throw new AppError('PROVIDER_ERROR', `Sartblock respondió ${res.status}`, { provider: 'sartblock' });
  }

  async screen(input: AmlScreenInput) {
    let res: Response;
    try {
      // TODO(sartblock): ruta y esquema de auth asumidos.
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/v1/screenings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          fullName: input.fullName,
          documentType: input.documentType,
          documentNumber: input.documentNumber,
          country: input.country,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.opts.logger.error({ err: (err as Error).message }, 'sartblock network error');
      throw new AppError('PROVIDER_ERROR', 'El proveedor AML no respondió', { provider: 'sartblock' });
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      this.opts.logger.warn({ status: res.status }, 'sartblock error');
      throw new AppError('PROVIDER_ERROR', 'Error del proveedor AML', { provider: 'sartblock', status: res.status });
    }
    // TODO(sartblock): mapear el campo/valores reales. Ante cualquier valor desconocido → 'review' (fail-safe).
    const rawResult = String(json.result ?? json.status ?? json.match ?? '').toLowerCase();
    const result: AmlResult = ['clear', 'no_match', 'clean'].includes(rawResult)
      ? 'clear'
      : ['hit', 'match', 'blocked'].includes(rawResult)
        ? 'hit'
        : 'review';
    const referenceId = String(json.referenceId ?? json.id ?? json.reference ?? `sb_${randomUUID()}`);
    return { result, referenceId, raw: json };
  }
}
