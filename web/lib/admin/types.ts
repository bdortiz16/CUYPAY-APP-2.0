// Tipos del Admin API v1 (ver docs/ADMIN_API.md). Montos siempre en unidades menores (enteros).

export type Currency = "COP" | "BRL";
export type Role = "owner" | "compliance" | "treasury" | "support" | "viewer";

export interface Admin {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
  /** Claves de permiso (solo en GET /admin/me). */
  permissions?: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type KycStatus = "not_started" | "pending" | "approved" | "rejected" | "retry";
export type Tier = "basic" | "full";
export type RiskLevel = "low" | "medium" | "high";

export interface SavingsRateTierDto {
  termDays: number;
  ratePercent: number;
  enabled: boolean;
}

export interface SavingsConfigDto {
  rates: SavingsRateTierDto[];
  minAmountMinor: string;
  maxAmountMinor: string;
  contractTerms: string;
  updatedAt: string;
  updatedBy?: string;
}

export interface SavingsBlockDto {
  id: string;
  userId: string;
  termDays: number;
  principalMinor: string;
  lockedRate: number;
  expectedYieldMinor: string;
  totalPayoutMinor: string;
  currency: string;
  status: "active" | "maturing_soon" | "completed" | "canceled";
  startedAt: string;
  maturesAt: string;
  completedAt: string | null;
}

export interface SavingsTreasuryAlertsDto {
  windowHours: number;
  totalMaturing72hMinor: string;
  totalMaturingCount: number;
  maturingBlocks: Array<SavingsBlockDto & { hoursRemaining: number }>;
}

export interface AdminCustomerSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  country: string;
  kycStatus: KycStatus;
  tier: Tier;
  status: "active" | "frozen";
  riskLevel: RiskLevel;
  balances: Record<Currency, number>;
  createdAt: string;
  lastActiveAt: string;
}

export type LimitOperation = "transfer_out" | "conversion" | "deposit_in";
export type LimitPeriod = "daily" | "monthly" | "annual";

export interface LimitItem {
  operation: LimitOperation;
  period: LimitPeriod;
  limitMinor: number;
  usedMinor?: number;
}

export interface LimitsSnapshot {
  tier: Tier;
  currency: "COP";
  items: LimitItem[];
}

export interface Wallet {
  currency: Currency;
  balanceMinor: number;
  availableMinor: number;
  heldMinor: number;
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
  revoked: boolean;
}

export interface Note {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface AmlMatch {
  list: string;
  name: string;
  score: number;
}

export interface AdminBeneficiary {
  id: string;
  customerId: string;
  customerName: string;
  alias: string;
  holderName: string;
  bankName: string;
  status: "active" | "pending_review" | "rejected";
  aml: {
    provider: "sartblock";
    result: "clear" | "hit" | "review";
    referenceId: string;
    matches: AmlMatch[];
    checkedAt: string;
  };
  createdAt: string;
}

export type TxType = "deposit" | "transfer" | "conversion";
export type TxStatus = "pending" | "completed" | "failed" | "reversed";

export interface ConversionInfo {
  fromCurrency: Currency;
  fromAmountMinor: number;
  toCurrency: Currency;
  toAmountMinor: number;
  rate: number;
}

export interface AdminTransaction {
  id: string;
  customerId: string;
  customerName: string;
  type: TxType;
  direction: "in" | "out";
  currency: Currency;
  amountMinor: number;
  feeMinor: number;
  status: TxStatus;
  counterparty: string;
  conversion: ConversionInfo | null;
  flagged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  account: string;
  debitMinor: number;
  creditMinor: number;
  currency: Currency;
}

export interface TimelineEvent {
  at: string;
  event: "created" | "held" | "provider_submitted" | "provider_confirmed" | "completed" | "failed" | "reversed";
  detail: string;
}

export interface AdminTransactionDetail extends AdminTransaction {
  ledgerEntries: LedgerEntry[];
  timeline: TimelineEvent[];
  providerRefs: Record<string, string>;
}

export interface AdminCustomerDetail extends AdminCustomerSummary {
  documentType: string | null;
  documentNumber: string | null;
  kyc: {
    provider: "sumsub";
    applicantId: string;
    status: KycStatus;
    reviewAnswer: "GREEN" | "RED" | null;
    rejectLabels: string[];
    updatedAt: string;
  };
  wallets: Wallet[];
  brebKey: { alias: string; status: "active" | "blocked" | "pending"; createdAt: string } | null;
  limits: LimitsSnapshot;
  limitOverrides: LimitItem[];
  devices: Device[];
  beneficiaries: AdminBeneficiary[];
  recentTransactions: AdminTransaction[];
  notes: Note[];
}

export type AlertType =
  | "deposit_over_limit"
  | "aml_hit"
  | "velocity"
  | "large_transaction"
  | "multiple_devices"
  | "structuring";

export type AlertResolution = "false_positive" | "customer_contacted" | "frozen" | "reported";

export interface ComplianceAlert {
  id: string;
  type: AlertType;
  severity: RiskLevel;
  customerId: string;
  customerName: string;
  transactionId: string | null;
  description: string;
  uiafSuggested: boolean;
  status: "open" | "resolved";
  resolution: AlertResolution | null;
  resolutionNote: string | null;
  reportToUiaf: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ProviderStatus {
  id: "coinsenda" | "sumsub" | "sartblock" | "brl_partner" | "otp";
  name: string;
  status: "operational" | "degraded" | "down";
  mode: "mock" | "live";
  latencyMs: number;
  successRate24h: number;
  lastCheckAt: string;
  lastError: string | null;
}

export interface TreasuryAccount {
  id: string;
  name: string;
  provider: string;
  currency: Currency;
  /** null si el proveedor no responde o no expone saldo. */
  providerBalanceMinor: number | null;
  ledgerBalanceMinor: number;
  differenceMinor: number | null;
  lastSyncedAt: string;
  status: "ok" | "stale" | "error";
  error: string | null;
}

export interface ReconBreak {
  kind: "missing_in_ledger" | "missing_in_provider" | "amount_mismatch" | "status_mismatch";
  reference: string;
  amountMinor: number;
  currency: Currency;
  detail: string;
}

export interface TreasurySnapshot {
  asOf: string;
  accounts: TreasuryAccount[];
  liabilities: Record<Currency, number>;
  coverage: { currency: Currency; providerMinor: number; liabilitiesMinor: number; differenceMinor: number; ratio: number }[];
  revenue: { todayMinor: number; monthMinor: number; currency: Currency };
  reconciliation: {
    status: "ok" | "breaks" | "running" | "never";
    lastRunAt: string | null;
    breaks: ReconBreak[];
  };
}

export interface FxConfig {
  pair: "COP/BRL";
  midRate: number;
  customerRate: number;
  spreadBps: number;
  feeBps: number;
  minFeeMinor: number;
  minAmountMinor: number;
  maxAmountMinor: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export type FxConfigInput = Partial<
  Pick<FxConfig, "spreadBps" | "feeBps" | "minFeeMinor" | "minAmountMinor" | "maxAmountMinor" | "enabled">
>;

export interface SeriesPoint {
  date: string;
  depositsMinor: number;
  transfersMinor: number;
  conversionsMinor: number;
  newCustomers: number;
}

export interface Dashboard {
  generatedAt: string;
  customers: { total: number; newToday: number; kycApproved: number; kycPending: number; frozen: number };
  today: {
    deposits: { count: number; volumeMinor: number; currency: Currency };
    transfers: { count: number; volumeMinor: number; currency: Currency };
    conversions: { count: number; fromVolumeMinor: number; toVolumeMinor: number; fromCurrency: Currency; toCurrency: Currency };
    revenueMinor: number;
    revenueCurrency: Currency;
  };
  series: SeriesPoint[];
  queues: { amlReview: number; complianceAlerts: number; failedTransactions: number };
  providers: ProviderStatus[];
  treasury: TreasurySnapshot;
}

export interface LimitsConfig {
  tiers: { tier: Tier; items: LimitItem[] }[];
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: { id: string; email: string; role: Role };
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  ip: string;
  userAgent: string;
}

export interface CreatedAdmin {
  admin: Admin;
  temporaryPassword: string;
  otpauthUrl: string;
}

export interface ReverseResult {
  transaction: AdminTransactionDetail;
  journalId: string;
  warnings: string[];
}

export interface UnfreezeResult {
  status: "active";
  releasedHeldMinor: number;
}

export type StreamEvent =
  | { type: "transaction.created" | "transaction.updated"; data: AdminTransaction }
  | { type: "customer.created" | "customer.updated"; data: AdminCustomerSummary }
  | { type: "kyc.updated"; data: { customerId: string; status: KycStatus; tier: Tier } }
  | { type: "compliance.alert"; data: ComplianceAlert }
  | { type: "beneficiary.review_required"; data: AdminBeneficiary }
  | { type: "provider.status"; data: ProviderStatus }
  | { type: "treasury.updated"; data: TreasurySnapshot }
  | { type: "ping"; data: { at: string } };

export interface CustomerQuery {
  query?: string;
  kycStatus?: string;
  tier?: string;
  status?: string;
  limit?: number;
  cursor?: string | null;
}

export interface TransactionQuery {
  type?: string;
  status?: string;
  currency?: string;
  customerId?: string;
  from?: string;
  to?: string;
  minAmountMinor?: number;
  flagged?: "true" | "false";
  limit?: number;
  cursor?: string | null;
}

export interface AuditQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  cursor?: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
