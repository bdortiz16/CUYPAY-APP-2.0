/** Entidades del portal admin (docs/ADMIN_API.md). Persistencia: db/schema.sql (sección Admin). */
import type { LimitRule } from '../config.js';
import type { Currency } from './types.js';

export type AdminRole = 'owner' | 'compliance' | 'treasury' | 'support' | 'viewer';
export const ADMIN_ROLES: readonly AdminRole[] = ['owner', 'compliance', 'treasury', 'support', 'viewer'];
export type AdminStatus = 'active' | 'disabled';

export interface AdminUser {
  id: string;
  email: string; // minúsculas
  name: string;
  role: AdminRole;
  status: AdminStatus;
  passwordHash: string; // scrypt$...
  totpSecret: string; // base32. TODO(security): cifrar en reposo con KMS en producción.
  lastTotpStep: number | null; // anti-reutilización del mismo código TOTP
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminSession {
  id: string; // = sid del JWT
  adminId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

export interface AuditEntry {
  id: string;
  at: Date;
  actor: { id: string; email: string; role: AdminRole };
  action: string;
  targetType: string;
  targetId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
}

export type AlertType = 'deposit_over_limit' | 'aml_hit' | 'velocity' | 'large_transaction' | 'multiple_devices' | 'structuring';
export type AlertSeverity = 'low' | 'medium' | 'high';
export type AlertResolution = 'false_positive' | 'customer_contacted' | 'frozen' | 'reported';

export interface ComplianceAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  customerId: string;
  transactionId: string | null;
  description: string;
  /** Sugerencia de reporte (ROS) a la UIAF según la regla que la generó. */
  uiafSuggested: boolean;
  status: 'open' | 'resolved';
  resolution: AlertResolution | null;
  resolutionNote: string | null;
  reportToUiaf: boolean;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null; // admin id
}

export interface CustomerNote {
  id: string;
  userId: string;
  authorId: string;
  authorEmail: string;
  text: string;
  createdAt: Date;
}

/** Estado operativo del cliente controlado desde el portal (no viene del KYC). */
export interface CustomerControl {
  userId: string;
  status: 'active' | 'frozen';
  frozenAt: Date | null;
  frozenReason: string | null;
  limitOverrides: LimitRule[];
  /** Depósitos recibidos mientras estaba congelado (quedan retenidos hasta descongelar). */
  heldDepositTxnIds: string[];
  updatedAt: Date;
}

export type ReconBreakKind = 'missing_in_ledger' | 'missing_in_provider' | 'amount_mismatch' | 'status_mismatch';
export interface ReconBreak {
  kind: ReconBreakKind;
  reference: string;
  amountMinor: bigint;
  currency: Currency;
  detail: string;
}
export interface ReconciliationRun {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'ok' | 'breaks' | 'error';
  breaks: ReconBreak[];
  triggeredBy: string; // admin id o 'system'
  error: string | null;
}

export interface SettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: Date;
  updatedBy: string | null; // email del admin
}
