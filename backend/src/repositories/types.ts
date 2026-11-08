import type {
  AmlCheck,
  Beneficiary,
  BrebKey,
  BrebResolution,
  Challenge,
  Currency,
  Device,
  IdempotencyRecord,
  KycApplicant,
  LedgerAccount,
  LedgerAccountKind,
  LedgerEntry,
  LimitOperation,
  LimitUsage,
  Otp,
  ProcessedDeposit,
  Quote,
  RefreshToken,
  Transaction,
  User,
} from '../domain/types.js';

/**
 * Puertos de persistencia. Fase 1: implementación en memoria (memory.ts).
 * Producción: PostgreSQL según db/schema.sql (mismas operaciones; `transaction`
 * debe abrir una transacción SERIALIZABLE / SELECT ... FOR UPDATE por usuario).
 */

export interface UserRepo {
  create(u: User): Promise<void>;
  update(u: User): Promise<void>;
  byId(id: string): Promise<User | null>;
  byPhone(phone: string): Promise<User | null>;
  byEmail(email: string): Promise<User | null>;
}

export interface DeviceRepo {
  create(d: Device): Promise<void>;
  update(d: Device): Promise<void>;
  byId(id: string): Promise<Device | null>;
  listByUser(userId: string): Promise<Device[]>;
}

export interface OtpRepo {
  create(o: Otp): Promise<void>;
  update(o: Otp): Promise<void>;
  byId(id: string): Promise<Otp | null>;
}

export interface ChallengeRepo {
  create(c: Challenge): Promise<void>;
  /** Consume atómicamente: devuelve el challenge si no estaba consumido. */
  consume(id: string, at: Date): Promise<Challenge | null>;
}

export interface RefreshTokenRepo {
  create(t: RefreshToken): Promise<void>;
  byHash(hash: string): Promise<RefreshToken | null>;
  /** Marca como usado de forma atómica; false si ya estaba usado. */
  markUsed(id: string, at: Date): Promise<boolean>;
  revokeFamily(familyId: string, at: Date): Promise<void>;
  revokeByDevice(deviceId: string, at: Date): Promise<void>;
}

export interface NonceRepo {
  /** Registra el nonce; false si ya existía (replay). */
  register(deviceId: string, nonce: string, expiresAt: Date, now: Date): Promise<boolean>;
}

export interface KycRepo {
  upsert(k: KycApplicant): Promise<void>;
  byUser(userId: string): Promise<KycApplicant | null>;
  byApplicantId(applicantId: string): Promise<KycApplicant | null>;
}

export interface BrebKeyRepo {
  create(k: BrebKey): Promise<void>;
  byUser(userId: string): Promise<BrebKey | null>;
  byProviderKeyId(providerKeyId: string): Promise<BrebKey | null>;
  byAlias(alias: string): Promise<BrebKey | null>;
}

export interface ResolutionRepo {
  create(r: BrebResolution): Promise<void>;
  byId(id: string): Promise<BrebResolution | null>;
}

export interface BeneficiaryRepo {
  create(b: Beneficiary): Promise<void>;
  update(b: Beneficiary): Promise<void>;
  byId(id: string): Promise<Beneficiary | null>;
  listByUser(userId: string): Promise<Beneficiary[]>;
}

export interface AmlRepo {
  create(c: AmlCheck): Promise<void>;
  byId(id: string): Promise<AmlCheck | null>;
}

export interface LedgerRepo {
  getOrCreateAccount(kind: LedgerAccountKind, userId: string | null, currency: Currency, now: Date): Promise<LedgerAccount>;
  insertEntries(entries: LedgerEntry[]): Promise<void>;
  balance(accountId: string): Promise<bigint>;
  allEntries(): Promise<LedgerEntry[]>;
}

export interface TransactionRepo {
  create(t: Transaction): Promise<void>;
  update(t: Transaction): Promise<void>;
  byId(id: string): Promise<Transaction | null>;
  /** Orden: createdAt DESC, id DESC. `after` = cursor (createdAt, id) exclusivo. */
  listByUser(
    userId: string,
    opts: { currency?: Currency; limit: number; after?: { createdAt: Date; id: string } },
  ): Promise<Transaction[]>;
  listPendingTransfers(): Promise<Transaction[]>;
}

export interface QuoteRepo {
  create(q: Quote): Promise<void>;
  update(q: Quote): Promise<void>;
  byId(id: string): Promise<Quote | null>;
}

export interface IdempotencyRepo {
  get(userId: string, scope: string, key: string): Promise<IdempotencyRecord | null>;
  /** Inserta si no existe; false si ya existía. */
  tryInsert(r: IdempotencyRecord): Promise<boolean>;
  complete(userId: string, scope: string, key: string, status: number, body: unknown): Promise<void>;
  remove(userId: string, scope: string, key: string): Promise<void>;
}

export interface LimitUsageRepo {
  add(u: LimitUsage): Promise<void>;
  voidByTransaction(transactionId: string, at: Date): Promise<void>;
  sum(userId: string, operation: LimitOperation, from: Date, to: Date): Promise<bigint>;
}

export interface ProcessedDepositRepo {
  /** Inserta si no existe; false si el depósito ya fue procesado (dedupe). */
  tryInsert(d: ProcessedDeposit): Promise<boolean>;
  get(providerDepositId: string): Promise<ProcessedDeposit | null>;
}

export interface Repositories {
  users: UserRepo;
  devices: DeviceRepo;
  otps: OtpRepo;
  challenges: ChallengeRepo;
  refreshTokens: RefreshTokenRepo;
  nonces: NonceRepo;
  kyc: KycRepo;
  brebKeys: BrebKeyRepo;
  resolutions: ResolutionRepo;
  beneficiaries: BeneficiaryRepo;
  aml: AmlRepo;
  ledger: LedgerRepo;
  transactions: TransactionRepo;
  quotes: QuoteRepo;
  idempotency: IdempotencyRepo;
  limitUsage: LimitUsageRepo;
  processedDeposits: ProcessedDepositRepo;
}
