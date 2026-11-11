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
  phoneVerifiedAt?: Date | null;
  emailVerifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  publicKey: string; // base64 X9.63
  pushToken?: string | null;
  pushEnvironment?: 'sandbox' | 'production' | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export type OtpPurpose = 'auth' | 'contact_change' | 'email_verify';
export type OtpChannel = 'whatsapp' | 'sms' | 'email';
export type OtpVerificationMode = 'local' | 'twilio_verify';

export interface Otp {
  id: string;
  phone: string;
  email?: string | null;
  userId?: string | null;
  purpose?: OtpPurpose;
  channel?: OtpChannel;
  verificationMode?: OtpVerificationMode;
  codeHash: string;
  attempts: number;
  verifiedAt?: Date | null;
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

export type TxnType = 'deposit' | 'transfer' | 'conversion' | 'card_pocket' | 'card_purchase' | 'savings' | 'loan';
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
  | 'card_pocket' // bolsillo dedicado de la tarjeta virtual (pasivo de usuario)
  | 'savings_vault' // bolsillo recaudo de ahorros / intereses (fondos captados de bloques a plazo)
  | 'savings_escrow' // reserva bloqueada 72h antes del vencimiento (capital + intereses listos para reintegro)
  | 'loan_pool' // bolsillo disponible de préstamos (recursos propios para desembolsar créditos)
  | 'treasury_capital' // contrapartida patrimonial interna para fondeo/retiro de bolsillos admin
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

// ───────────── Bloques de Ahorro (Bolsillo de Ahorros a Plazo) ─────────────

export type SavingsBlockStatus = 'active' | 'maturing_soon' | 'completed' | 'canceled';
export type SavingsEscrowStatus = 'unfunded' | 'funded_locked' | 'settled';

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
  escrowStatus?: SavingsEscrowStatus;
  escrowFundedAt?: Date | null;
  escrowFundedBy?: string | null;
  startedAt: Date;
  maturesAt: Date;
  completedAt: Date | null;
  contractVersion: number;
  contractAcceptedAt: Date;
  createdAt: Date;
}

// ───────────── Créditos con Recursos Propios + Pagaré Electrónico (Colombia) ─────────────

export const ALLOWED_LOAN_TERMS = [30, 60, 90, 180, 360] as const;
export type LoanTermDays = (typeof ALLOWED_LOAN_TERMS)[number];

export type LoanStatus =
  | 'pending_review'
  | 'approved_active'
  | 'overdue'
  | 'paid'
  | 'rejected'
  | 'canceled';

export type PromissoryNoteStatus =
  | 'signed_custody'
  | 'active_enforceable'
  | 'cancelled_paid'
  | 'voided_rejected';

export interface LoanRateTier {
  termDays: number;
  rateEaPercent: number;
  enabled: boolean;
}

export interface LoanConfig {
  enabled: boolean;
  rates: LoanRateTier[];
  /** Tope máximo legal de usura E.A. certificado por la Superintendencia Financiera de Colombia. */
  usuryCeilingEaPercent: number;
  /** Tasa moratoria E.A. aplicable en caso de mora (siempre <= usuryCeilingEaPercent). */
  moratoryRateEaPercent: number;
  minAmountMinor: bigint;
  maxAmountMinor: bigint;
  creditorLegalName: string;
  creditorNit: string;
  creditorDomicile: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface ElectronicSignatureEvidence {
  method: 'ECDSA_P256_SHA256_SECURE_ENCLAVE';
  deviceId: string;
  deviceName: string;
  devicePublicKey: string;
  ecdsaSignatureBase64: string;
  canonicalSha256: string;
  nonce: string;
  timestampSec: number;
  signedAt: string;
  signerIp: string;
  signerUserAgent: string;
  acceptedPagare: boolean;
  acceptedInstructionLetter: boolean;
  acceptedCreditBureauAuth: boolean;
}

export interface PromissoryNote {
  id: string;
  number: string; // Ej: PAG-2026-000101
  loanId: string;
  userId: string;
  status: PromissoryNoteStatus;
  principalMinor: bigint;
  interestMinor: bigint;
  totalDueMinor: bigint;
  termDays: number;
  interestRateEa: number;
  nominalMonthlyPercent: number;
  moratoryRateEa: number;
  currency: Currency;
  creditorLegalName: string;
  creditorNit: string;
  creditorDomicile: string;
  debtorFullName: string;
  debtorDocumentType: string;
  debtorDocumentNumber: string;
  debtorEmail: string;
  debtorPhone: string;
  debtorCity: string;
  sumsubApplicantId: string | null;
  documentMarkdown: string;
  documentSha256: string;
  signature: ElectronicSignatureEvidence;
  disbursedAt: Date | null;
  dueAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Loan {
  id: string;
  userId: string;
  promissoryNoteId: string;
  promissoryNoteNumber: string;
  principalMinor: bigint;
  termDays: number;
  interestRateEa: number;
  nominalMonthlyPercent: number;
  moratoryRateEa: number;
  interestMinor: bigint;
  totalDueMinor: bigint;
  paidMinor: bigint;
  principalPaidMinor: bigint;
  interestPaidMinor: bigint;
  remainingMinor: bigint;
  currency: Currency;
  status: LoanStatus;
  purpose: string | null;
  debtorFullName: string;
  debtorDocumentType: string;
  debtorDocumentNumber: string;
  debtorEmail: string;
  debtorPhone: string;
  debtorCity: string;
  requestedAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
  disbursedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}


