import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { Clock } from '../lib/clock.js';
import type {
  AmlProvider,
  BrlLiquidityProvider,
  CoinsendaGateway,
  EmailOtpSender,
  KycProvider,
  OtpSender,
} from '../ports/index.js';
import type { Repositories } from '../repositories/types.js';
import type { EventBus } from './events.js';

/** Dependencias compartidas por los servicios de dominio. */
export interface ServiceDeps {
  config: AppConfig;
  repos: Repositories;
  clock: Clock;
  logger: Logger;
  coinsenda: CoinsendaGateway;
  kyc: KycProvider;
  aml: AmlProvider;
  brl: BrlLiquidityProvider;
  otp: OtpSender;
  emailOtp?: EmailOtpSender;
  /** Bus de eventos interno (SSE del portal admin, alertas de cumplimiento). */
  events: EventBus;
}

/**
 * Mutex por clave (usuario) en proceso. Serializa operaciones que mueven dinero
 * del mismo usuario (chequeo de saldo/límites + retención). En producción con
 * varias instancias: SELECT ... FOR UPDATE / advisory lock en PostgreSQL.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
