import { AppError } from '../../lib/errors.js';
import type { ServiceDeps } from '../deps.js';

export type ProviderId = 'coinsenda' | 'sumsub' | 'sartblock' | 'brl_partner' | 'otp';
export const PROVIDER_IDS: readonly ProviderId[] = ['coinsenda', 'sumsub', 'sartblock', 'brl_partner', 'otp'];

const NAMES: Record<ProviderId, string> = {
  coinsenda: 'Coinsenda (Bre-B)',
  sumsub: 'Sumsub (KYC)',
  sartblock: 'Sartblock (AML)',
  brl_partner: 'Socio BRL / PIX',
  otp: 'OTP / SMS',
};

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  status: 'operational' | 'degraded' | 'down';
  mode: 'mock' | 'live';
  latencyMs: number | null;
  successRate24h: number | null;
  lastCheckAt: string | null;
  lastError: string | null;
}

const SLOW_MS = 3000;
const DAY = 86_400_000;

/** Health checks de proveedores (bajo demanda y periódicos), con historial de 24 h en memoria. */
export class ProviderHealthService {
  private readonly last = new Map<ProviderId, ProviderStatus>();
  private readonly history = new Map<ProviderId, { at: number; ok: boolean }[]>();

  constructor(private readonly d: ServiceDeps) {}

  private mode(id: ProviderId): 'mock' | 'live' {
    if (id === 'brl_partner') return this.d.config.BRL_PROVIDER_MODE ?? this.d.config.PROVIDERS_MODE;
    if (id === 'otp') return this.d.config.NODE_ENV === 'production' ? 'live' : 'mock';
    return this.d.config.PROVIDERS_MODE;
  }

  private probe(id: ProviderId): (() => Promise<void>) | null {
    const { coinsenda, kyc, aml, brl, otp } = this.d;
    switch (id) {
      case 'coinsenda':
        return coinsenda.healthCheck ? () => coinsenda.healthCheck!() : () => coinsenda.listDeposits().then(() => undefined);
      case 'sumsub':
        return kyc.healthCheck ? () => kyc.healthCheck!() : null;
      case 'sartblock':
        return aml.healthCheck ? () => aml.healthCheck!() : null;
      case 'brl_partner':
        return brl.healthCheck ? () => brl.healthCheck!() : () => brl.getMidRate('COP', 'BRL').then(() => undefined);
      case 'otp':
        return otp.healthCheck ? () => otp.healthCheck!() : null;
    }
  }

  async check(id: ProviderId): Promise<ProviderStatus> {
    if (!PROVIDER_IDS.includes(id)) throw new AppError('NOT_FOUND', 'Proveedor desconocido');
    const now = this.d.clock.now();
    const probe = this.probe(id);
    const t0 = Date.now();
    let ok = true;
    let error: string | null = null;
    try {
      if (probe) await probe();
    } catch (err) {
      ok = false;
      error = (err as Error).message;
    }
    const latencyMs = Date.now() - t0;
    const h = (this.history.get(id) ?? []).filter((x) => now.getTime() - x.at <= DAY);
    h.push({ at: now.getTime(), ok });
    this.history.set(id, h);
    const successRate24h = Math.round((h.filter((x) => x.ok).length / h.length) * 1000) / 1000;
    const status: ProviderStatus = {
      id,
      name: NAMES[id],
      status: !ok ? 'down' : latencyMs > SLOW_MS || successRate24h < 0.95 ? 'degraded' : 'operational',
      mode: this.mode(id),
      latencyMs,
      successRate24h,
      lastCheckAt: now.toISOString(),
      lastError: error,
    };
    const prev = this.last.get(id);
    this.last.set(id, status);
    if (!prev || prev.status !== status.status) await this.d.events.publish({ type: 'provider.status', status });
    return status;
  }

  async checkAll(): Promise<ProviderStatus[]> {
    return Promise.all(PROVIDER_IDS.map((id) => this.check(id)));
  }

  /** Último estado conocido; si nunca se revisó, corre el check. */
  async list(): Promise<ProviderStatus[]> {
    return Promise.all(PROVIDER_IDS.map(async (id) => this.last.get(id) ?? this.check(id)));
  }
}
