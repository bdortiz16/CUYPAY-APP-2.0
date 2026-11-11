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

export type CardHolderDocumentType =
  | 'cedula_ciudadania'
  | 'cedula_extranjeria'
  | 'ppt'
  | 'pep'
  | 'pasaporte';

export interface KycVerifiedAddress {
  country?: string;
  province?: string;
  city?: string;
  zipCode?: string;
  streetName?: string;
  streetNumber?: string;
  district?: string;
  additionalInfo?: string;
}

export interface KycVerifiedProfile {
  applicantId: string;
  firstName: string;
  lastName: string;
  birthdate: string | null; // YYYY-MM-DD
  nationality: string | null;
  documentCountry: string | null;
  documentType: CardHolderDocumentType;
  documentNumber: string | null;
  isSandboxMockDocument: boolean;
  email: string | null;
  phone: string | null;
  verifiedEmailFromKyc?: string | null;
  verifiedPhoneFromKyc?: string | null;
  address: KycVerifiedAddress | null;
}

export interface CardHolderInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthdate: string; // YYYY-MM-DD
  nationality: string;
  documentCountry: string;
  documentType: CardHolderDocumentType;
  documentNumber: string;
  address?: KycVerifiedAddress | null;
  existingCardHolderId?: string | null;
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
  /** Bloquea o reactiva una llave Bre-B propia. */
  updateBrebKeyStatus?(providerKeyId: string, status: 'active' | 'blocked'): Promise<void>;
  /** Cancela definitivamente una llave Bre-B propia. */
  cancelBrebKey?(providerKeyId: string): Promise<void>;

  // ── Tarjetas (farming + marketplace) ──
  /** Emite o vincula una tarjeta virtual/física en Coinsenda. */
  issueCard(input: {
    userId: string;
    holderName: string;
    email: string;
    currency: Currency;
    label?: string;
    holder?: CardHolderInput;
  }): Promise<{
    providerCardId: string;
    providerCardHolderId?: string;
    holderName?: string;
    ledgerAccountId: string;
    lastFour: string;
    brand: string;
    status: 'active' | 'frozen';
    raw: unknown;
  }>;
  /** Obtiene la URL segura (iframe del emisor) donde el usuario ve PAN, fecha y CVV. */
  getCardLookUrl(providerCardId: string, providerCardHolderId?: string): Promise<{ url: string }>;
  /** Lista metadatos actuales de las tarjetas en el proveedor para sincronizar últimos 4 dígitos y estado. */
  getProviderCards?(): Promise<
    Array<{
      providerCardId: string;
      lastFour: string;
      brand: string;
      status: 'active' | 'frozen' | 'canceled';
      label?: string;
    }>
  >;
  /** Actualiza el estado operativo: congelada (freeze), activa (reactivate) o cancelada. */
  updateCardWorkingState(providerCardId: string, state: 'active' | 'frozen' | 'canceled'): Promise<void>;
  /** Renombra la tarjeta. */
  updateCardLabel(providerCardId: string, label: string): Promise<void>;
  /** Tokenización in-app provisioning para Apple Pay. */
  tokenizeApplePay(input: {
    providerCardId: string;
    certificates: string[];
    nonce: string;
    nonceSignature: string;
  }): Promise<{
    activationData: string;
    encryptedPassData: string;
    ephemeralPublicKey: string;
  }>;
  /** Consulta el saldo disponible de la cuenta COP ómnibus (tesorería del portal admin). */
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
  getApplicantProfile?(input: { applicantId?: string | null; externalUserId: string }): Promise<KycVerifiedProfile | null>;
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
