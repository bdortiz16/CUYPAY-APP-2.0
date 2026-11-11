/** Entidades de dominio (persistencia: ver db/schema.sql). Montos en unidades menores (bigint). */

export type Currency = 'COP' | 'BRL';
export const CURRENCIES: readonly Currency[] = ['COP', 'BRL'];

export type KycStatus = 'not_started' | 'pending' | 'approved' | 'rejected' | 'retry';
export type Tier = 'basic' | 'full';

export interface User {
  id: string;
  phone: string;
  email: string;
  firstName: string;
  lastName: string;
  country: 'CO';
  kycStatus: KycStatus;
  tier: Tier;
  passwordHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  publicKey: string; // base64 X9.63
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface Otp {
  id: string;
  phone: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface Challenge {
  id: string;
  deviceId: string;
  nonce: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface RefreshToken {
  id: string;
  tokenHash: string;
  familyId: string;
  userId: string;
  deviceId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface KycApplicant {
  userId: string;
  provider: 'sumsub';
  applicantId: string | null;
  providerCardHolderId?: string | null;
  levelName: string;
  status: KycStatus;
  reviewAnswer: string | null;
  rejectLabels: string[];
  rejectType: string | null;
  updatedAt: Date;
}

export type BrebKeyType = 'phone' | 'email' | 'national_id' | 'alias';
export type BrebKeyStatus = 'active' | 'blocked' | 'pending' | 'replaced';
export interface BrebKey {
  id: string;
  userId: string;
  type?: BrebKeyType;
  alias: string;
  status: BrebKeyStatus;
  holderName: string;
  providerKeyId: string; // deposit_provider_id en Coinsenda
  createdAt: Date;
}

export type CardType = 'virtual' | 'physical';
export type CardStatus = 'active' | 'frozen' | 'canceled';
export interface Card {
  id: string;
  userId: string;
  cardType: CardType;
  status: CardStatus;
  label: string;
  holderName?: string;
  lastFour: string;
  brand: string;
  currency: Currency;
  providerCardId: string;
  providerCardHolderId?: string;
  ledgerAccountId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BrebResolution {
  id: string;
  userId: string;
  alias: string;
  holderFirstName: string;
  holderLastName: string;
  documentType: string;
  documentNumber: string;
  bankName: string;
  raw: unknown;
  expiresAt: Date;
  createdAt: Date;
}

export type AmlResult = 'clear' | 'hit' | 'review';
export interface AmlCheck {
  id: string;
  userId: string;
  subjectType: 'beneficiary';
  subjectId: string;
  provider: 'sartblock';
  result: AmlResult;
  referenceId: string;
  checkedAt: Date;
  raw: unknown;
}

export type BeneficiaryStatus = 'active' | 'pending_review' | 'rejected';
export interface Beneficiary {
  id: string;
  userId: string;
  alias: string;
  holderName: string;
  documentType: string;
  documentNumber: string;
  nickname: string | null;
  bankName: string;
  status: BeneficiaryStatus;
  amlCheckId: string;
  providerWithdrawAccountId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export type TxnType = 'deposit' | 'transfer' | 'conversion';
export type TxnStatus = 'pending' | 'completed' | 'failed' | 'reversed';
export interface ConversionInfo {
  fromCurrency: Currency;
  fromAmountMinor: bigint;
  toCurrency: Currency;
  toAmountMinor: bigint;
  rateScaled: bigint;
}
export interface Transaction {
  id: string;
  userId: string;
  type: TxnType;
  direction: 'in' | 'out';
  currency: Currency;
  amountMinor: bigint;
  feeMinor: bigint;
  status: TxnStatus;
  title: string;
  subtitle: string;
  description: string | null;
  conversion: ConversionInfo | null;
  beneficiaryId: string | null;
  quoteId: string | null;
  providerRef: string | null; // id de depósito / retiro en Coinsenda, o ref. del proveedor BRL
  flagged: boolean; // marcado para cumplimiento (p. ej. depósito sobre límite)
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Quote {
  id: string;
  userId: string;
  fromCurrency: Currency;
  toCurrency: Currency;
  fromAmountMinor: bigint;
  feeMinor: bigint;
  toAmountMinor: bigint;
  rateScaled: bigint; // después del spread
  midRateScaled: bigint;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export type LimitOperation = 'transfer_out' | 'conversion' | 'deposit_in';
export interface LimitUsage {
  id: string;
  userId: string;
  operation: LimitOperation;
  amountMinor: bigint; // COP equivalente
  transactionId: string;
  occurredAt: Date;
  voidedAt: Date | null;
}

export interface IdempotencyRecord {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  status: 'in_progress' | 'completed';
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
}

/** Cuentas del libro mayor. Las de usuario son pasivos (saldo positivo = dinero del usuario). */
export type LedgerAccountKind =
  | 'user_available'
  | 'user_held'
  | 'savings_vault' // fondos en custodia de bloques de ahorro a plazo fijo
  | 'breb_settlement' // contrapartida: cuenta COP en Coinsenda
  | 'fx_clearing' // contrapartida con el proveedor de liquidez BRL
  | 'fee_revenue'
  | 'seed_equity'; // solo para datos demo
export interface LedgerAccount {
  id: string;
  kind: LedgerAccountKind;
  userId: string | null;
  currency: Currency;
  createdAt: Date;
}
export interface LedgerEntry {
  id: string;
  journalId: string;
  accountId: string;
  currency: Currency;
  amountMinor: bigint; // con signo; cada journal suma 0 por moneda
  transactionId: string | null;
  createdAt: Date;
}

export interface ProcessedDeposit {
  providerDepositId: string;
  userId: string | null;
  transactionId: string | null;
  processedAt: Date;
  note: string | null;
}

// ───────────── Bloques de Ahorro (Pólizas / Bóveda a Plazo) ─────────────

export type SavingsBlockStatus = 'active' | 'maturing_soon' | 'completed' | 'canceled';

export interface SavingsRateTier {
  termDays: number;
  ratePercent: number;
  enabled: boolean;
}

export interface SavingsConfig {
  rates: SavingsRateTier[];
  minAmountMinor: bigint;
  maxAmountMinor: bigint;
  contractTerms: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface SavingsBlock {
  id: string;
  userId: string;
  principalMinor: bigint;
  termDays: number;
  lockedRate: number; // Tasa fija garantizada al momento de apertura (inmutable)
  expectedYieldMinor: bigint;
  totalPayoutMinor: bigint;
  currency: Currency;
  status: SavingsBlockStatus;
  startedAt: Date;
  maturesAt: Date;
  completedAt: Date | null;
  contractVersion: number;
  contractAcceptedAt: Date;
  createdAt: Date;
}

