import type { Logger } from 'pino';
import type { ComplianceAlert } from '../domain/admin.js';
import type { AmlCheck, Beneficiary, Device, Transaction, User } from '../domain/types.js';

/**
 * Bus de eventos interno (en proceso). Los servicios de dominio publican; el portal admin
 * (SSE) y el motor de alertas de cumplimiento se suscriben.
 * En producción con varias instancias: reemplazar por Redis Pub/Sub / LISTEN-NOTIFY de PostgreSQL.
 */
export type DomainEvent =
  | { type: 'transaction.created' | 'transaction.updated'; txn: Transaction }
  | { type: 'customer.created'; user: User }
  | { type: 'customer.updated'; userId: string }
  | { type: 'kyc.updated'; userId: string; status: User['kycStatus']; tier: User['tier'] }
  | { type: 'compliance.alert'; alert: ComplianceAlert }
  | { type: 'beneficiary.review_required'; beneficiary: Beneficiary }
  /** Interno: resultado del screening AML de un beneficiario (genera alertas aml_hit). */
  | { type: 'beneficiary.screened'; beneficiary: Beneficiary; aml: AmlCheck }
  /** Interno: nuevo dispositivo vinculado (regla multiple_devices). */
  | { type: 'device.created'; device: Device }
  | { type: 'provider.status'; status: unknown }
  | { type: 'treasury.updated'; snapshot: unknown };

export type DomainEventType = DomainEvent['type'];
export type EventListener = (e: DomainEvent) => void | Promise<void>;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly logger?: Logger) {}

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.listeners.size;
  }

  /**
   * Entrega el evento a todos los suscriptores y espera a los asíncronos (determinístico en tests).
   * Un suscriptor que falla nunca rompe la operación que publicó.
   */
  async publish(e: DomainEvent): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const fn of this.listeners) {
      try {
        const r = fn(e);
        if (r && typeof (r as Promise<void>).then === 'function') {
          pending.push((r as Promise<void>).catch((err) => this.logger?.error({ err: (err as Error).message, type: e.type }, 'event listener failed')));
        }
      } catch (err) {
        this.logger?.error({ err: (err as Error).message, type: e.type }, 'event listener failed');
      }
    }
    await Promise.all(pending);
  }
}
