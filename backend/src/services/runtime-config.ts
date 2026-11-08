import { z } from 'zod';
import { LimitsConfigSchema, type LimitsConfig } from '../config.js';
import type { CustomerControl } from '../domain/admin.js';
import { AppError } from '../lib/errors.js';
import type { ServiceDeps } from './deps.js';

/**
 * Configuración editable en caliente desde el portal admin (tabla `settings`).
 * Si no hay valor guardado se usan los valores de entorno (config.ts).
 */

export const FxSettingsSchema = z.object({
  spreadBps: z.number().int().min(0).max(5000),
  feeBps: z.number().int().min(0).max(5000),
  minFeeMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  minAmountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maxAmountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  enabled: z.boolean(),
});
export type FxSettings = z.infer<typeof FxSettingsSchema>;

export interface Versioned<T> {
  value: T;
  updatedAt: Date | null;
  updatedBy: string | null;
}

const FX_KEY = 'fx.COP/BRL';
const LIMITS_KEY = 'limits';

export async function getFxSettings(d: ServiceDeps): Promise<Versioned<FxSettings>> {
  const rec = await d.repos.settings.get<FxSettings>(FX_KEY);
  if (rec) return { value: rec.value, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
  return {
    value: {
      spreadBps: d.config.FX_SPREAD_BPS,
      feeBps: d.config.CONVERSION_FEE_BPS,
      minFeeMinor: d.config.CONVERSION_FEE_MIN_MINOR,
      minAmountMinor: 0,
      maxAmountMinor: null,
      enabled: true,
    },
    updatedAt: null,
    updatedBy: null,
  };
}

export async function setFxSettings(d: ServiceDeps, value: FxSettings, updatedBy: string): Promise<void> {
  await d.repos.settings.set({ key: FX_KEY, value: FxSettingsSchema.parse(value), updatedAt: d.clock.now(), updatedBy });
}

export async function getLimitsConfig(d: ServiceDeps): Promise<Versioned<LimitsConfig>> {
  const rec = await d.repos.settings.get<LimitsConfig>(LIMITS_KEY);
  if (rec) return { value: rec.value, updatedAt: rec.updatedAt, updatedBy: rec.updatedBy };
  return { value: d.config.limits, updatedAt: null, updatedBy: null };
}

export async function setLimitsConfig(d: ServiceDeps, value: LimitsConfig, updatedBy: string): Promise<void> {
  await d.repos.settings.set({ key: LIMITS_KEY, value: LimitsConfigSchema.parse(value), updatedAt: d.clock.now(), updatedBy });
}

// ── Estado del cliente (congelado / overrides) ──

export async function getCustomerControl(d: ServiceDeps, userId: string): Promise<CustomerControl> {
  return (
    (await d.repos.customerControls.get(userId)) ?? {
      userId,
      status: 'active',
      frozenAt: null,
      frozenReason: null,
      limitOverrides: [],
      heldDepositTxnIds: [],
      updatedAt: d.clock.now(),
    }
  );
}

export async function isFrozen(d: ServiceDeps, userId: string): Promise<boolean> {
  return (await d.repos.customerControls.get(userId))?.status === 'frozen';
}

/** 403 ACCOUNT_FROZEN si cumplimiento congeló la cuenta (bloquea login, envíos y conversiones). */
export async function assertNotFrozen(d: ServiceDeps, userId: string): Promise<void> {
  if (await isFrozen(d, userId)) {
    throw new AppError('ACCOUNT_FROZEN', 'Tu cuenta está temporalmente bloqueada. Contacta a soporte de CuyPay.');
  }
}
