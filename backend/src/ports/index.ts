/**
 * Puertos (interfaces) hacia proveedores externos. Cada uno tiene adaptador Mock
 * (por defecto en dev/tests) y Live. Ver src/adapters/*.
 */
import type { AmlResult, Currency } from '../domain/types.js';

// ───────────────────────── Coinsenda ─────────────────────────

export interface BrebAliasHolder {
  alias: string;
  firstName: string;
  lastName: string;
  documentType: string;
  documentNumber: string;
  bankName: string;
  raw: unknown;
}

export type WithdrawState = 'pending' | 'confirmed' | 'accepted' | 'rejected' | 'canceled' | 'failed' | 'unknown';

export interface CoinsendaDeposit {
  id: string;
  providerKeyId: string | null; // deposit_provider_id (llave Bre-B propia)
  amountMinor: bigint;
  currency: Currency;
  state: 'accepted' | 'pending' | 'rejected' | 'unknown';
  payerName: string | null;
  createdAt: Date;
  raw: unknown;
}

export interface CoinsendaGateway {
  /** Crea (reclama) una llave Bre-B propia para un usuario: depositProvider en la cuenta COP de CuyPay. */
  createBrebKey(input: { alias: string; holderName: string; userRef: string }): Promise<{
    providerKeyId: string;
    alias: string;
    status: 'active' | 'pending' | 'blocked';
    raw: unknown;
  }>;
  /** Consulta el directorio Bre-B. `null` = la llave no existe (withdrawaccount_23). */
  resolveBrebAlias(alias: string): Promise<BrebAliasHolder | null>;
  /** Inscribe la cuenta destino (Bre-B) en Coinsenda. */
  addWithdrawAccount(input: { holder: BrebAliasHolder; label: string }): Promise<{ withdrawAccountId: string; raw: unknown }>;
  /** "Eliminar" = ocultar la cuenta destino. */
  hideWithdrawAccount(withdrawAccountId: string): Promise<void>;
  /** Crea el retiro (queda `pending` hasta confirmar). */
  createWithdraw(input: { withdrawAccountId: string; amountMinor: bigint; reference: string }): Promise<{
    withdrawId: string;
    state: WithdrawState;
    raw: unknown;
  }>;
  /** Segundo paso obligatorio: addUpdateWithdraw state=confirmed. */
  confirmWithdraw(withdrawId: string): Promise<{ state: WithdrawState; raw: unknown }>;
  getWithdraw(withdrawId: string): Promise<{ state: WithdrawState; raw: unknown } | null>;
  /** Los depósitos más recientes de la cuenta (ventana de 200, order id DESC). */
  listDeposits(): Promise<CoinsendaDeposit[]>;
  /** Saldo disponible de la cuenta COP ómnibus (tesorería del portal admin). */
  getBalance?(): Promise<{ currency: Currency; balanceMinor: bigint; asOf: Date }>;
  /** Health check liviano (portal admin). Lanza si el proveedor no responde. */
  healthCheck?(): Promise<void>;
}

// ───────────────────────── KYC (Sumsub) ─────────────────────────

export interface KycProvider {
  createApplicant(input: {
    externalUserId: string;
    levelName: string;
    email: string;
    phone: string;
    firstName: string;
    lastName: string;
    country: string;
  }): Promise<{ applicantId: string }>;
  createSdkAccessToken(input: { externalUserId: string; levelName: string; ttlInSecs: number }): Promise<{ token: string }>;
  healthCheck?(): Promise<void>;
}

// ───────────────────────── AML (Sartblock) ─────────────────────────

export interface AmlScreenInput {
  fullName: string;
  documentType: string;
  documentNumber: string;
  country: string;
}
export interface AmlProvider {
  screen(input: AmlScreenInput): Promise<{ result: AmlResult; referenceId: string; raw: unknown }>;
  healthCheck?(): Promise<void>;
}

// ───────────────────────── Liquidez BRL ─────────────────────────

export interface BrlLiquidityProvider {
  /** Tasa media (sin spread de CuyPay), escalada por RATE_SCALE. */
  getMidRate(from: Currency, to: Currency): Promise<{ rateScaled: bigint; updatedAt: Date }>;
  /** Historial diario de tasa media (para la gráfica). */
  getHistory(from: Currency, to: Currency, days: number): Promise<{ date: string; rateScaled: bigint }[]>;
  /** Ejecuta la conversión con el socio de liquidez (fase 1: COP→BRL). */
  executeConversion(input: {
    reference: string;
    fromCurrency: Currency;
    toCurrency: Currency;
    fromAmountMinor: bigint;
    toAmountMinor: bigint;
    rateScaled: bigint;
  }): Promise<{ providerRef: string }>;
  /** Saldo BRL de CuyPay en el socio (respaldo de los bolsillos BRL). */
  getBalance?(): Promise<{ currency: Currency; balanceMinor: bigint; asOf: Date }>;
  healthCheck?(): Promise<void>;
}

// ───────────────────────── OTP ─────────────────────────

export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
  healthCheck?(): Promise<void>;
}
