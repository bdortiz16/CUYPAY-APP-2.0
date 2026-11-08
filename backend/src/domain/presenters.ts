import { rateToNumber, toSafeNumber } from '../lib/money.js';
import type { LimitsSnapshot } from '../services/limits.js';
import type { WalletBalance } from '../services/ledger.js';
import type { AmlCheck, Beneficiary, BrebKey, BrebResolution, Device, Quote, Transaction, User } from './types.js';
import { maskDocument, maskHolderName } from '../services/beneficiaries.js';

/** Serialización a los JSON del contrato (camelCase, ISO-8601, enteros en unidades menores). */

const iso = (d: Date) => d.toISOString();
const n = toSafeNumber;

export const presentUser = (u: User) => ({
  id: u.id,
  firstName: u.firstName,
  lastName: u.lastName,
  email: u.email,
  phone: u.phone,
  country: u.country,
  kycStatus: u.kycStatus,
  tier: u.tier,
  createdAt: iso(u.createdAt),
});

export const presentSession = (s: { accessToken: string; refreshToken: string; expiresIn: number; deviceId: string; user: User }) => ({
  accessToken: s.accessToken,
  refreshToken: s.refreshToken,
  expiresIn: s.expiresIn,
  deviceId: s.deviceId,
  user: presentUser(s.user),
});

export const presentDevice = (d: Device, currentDeviceId: string) => ({
  id: d.id,
  name: d.name,
  createdAt: iso(d.createdAt),
  lastUsedAt: d.lastUsedAt ? iso(d.lastUsedAt) : null,
  current: d.id === currentDeviceId,
});

export const presentWallet = (w: WalletBalance) => ({
  currency: w.currency,
  balanceMinor: n(w.balanceMinor),
  availableMinor: n(w.availableMinor),
  heldMinor: n(w.heldMinor),
});

export const presentBrebKey = (k: BrebKey) => ({
  id: k.id,
  alias: k.alias,
  status: k.status,
  holderName: k.holderName,
  createdAt: iso(k.createdAt),
});

export const presentResolution = (r: BrebResolution) => ({
  resolutionId: r.id,
  alias: r.alias,
  holderName: maskHolderName(r.holderFirstName, r.holderLastName),
  holderNameFull: `${r.holderFirstName} ${r.holderLastName}`.trim(),
  documentType: r.documentType,
  documentMasked: maskDocument(r.documentNumber),
  bankName: r.bankName,
  expiresAt: iso(r.expiresAt),
});

export const presentBeneficiary = (b: Beneficiary, aml: AmlCheck | null) => ({
  id: b.id,
  alias: b.alias,
  holderName: b.holderName,
  nickname: b.nickname,
  bankName: b.bankName,
  status: b.status,
  aml: aml
    ? { provider: aml.provider, result: aml.result, referenceId: aml.referenceId, checkedAt: iso(aml.checkedAt) }
    : null,
  createdAt: iso(b.createdAt),
});

export const presentTransaction = (t: Transaction) => ({
  id: t.id,
  type: t.type,
  direction: t.direction,
  currency: t.currency,
  amountMinor: n(t.amountMinor),
  feeMinor: n(t.feeMinor),
  status: t.status,
  title: t.title,
  subtitle: t.subtitle,
  ...(t.conversion
    ? {
        conversion: {
          fromCurrency: t.conversion.fromCurrency,
          fromAmountMinor: n(t.conversion.fromAmountMinor),
          toCurrency: t.conversion.toCurrency,
          toAmountMinor: n(t.conversion.toAmountMinor),
          rate: rateToNumber(t.conversion.rateScaled),
        },
      }
    : {}),
  createdAt: iso(t.createdAt),
});
export type TransactionJson = ReturnType<typeof presentTransaction>;

export const presentQuote = (q: Quote) => ({
  quoteId: q.id,
  fromCurrency: q.fromCurrency,
  toCurrency: q.toCurrency,
  fromAmountMinor: n(q.fromAmountMinor),
  feeMinor: n(q.feeMinor),
  toAmountMinor: n(q.toAmountMinor),
  rate: rateToNumber(q.rateScaled),
  expiresAt: iso(q.expiresAt),
});

export const presentLimits = (s: LimitsSnapshot) => ({
  tier: s.tier,
  currency: s.currency,
  items: s.items.map((i) => ({ operation: i.operation, period: i.period, limitMinor: n(i.limitMinor), usedMinor: n(i.usedMinor) })),
});
