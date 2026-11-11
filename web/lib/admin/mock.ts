// Capa de datos simulada para demo del portal (sin backend). Datos deterministas + eventos SSE simulados.
import type { AdminApi, StreamStatus } from "./api";
import { can, permissionsForRole } from "./rbac";
import { customerRateFrom, quote } from "../fx";
import type {
  Admin,
  AdminBeneficiary,
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminTransaction,
  AdminTransactionDetail,
  AlertType,
  AuditEntry,
  ComplianceAlert,
  Device,
  FxConfig,
  KycStatus,
  LedgerEntry,
  LimitItem,
  LimitsConfig,
  LoanConfigDto,
  LoanDto,
  LoanPoolSummaryDto,
  Note,
  Page,
  PromissoryNoteDto,
  ProviderStatus,
  RiskLevel,
  SavingsBlockDto,
  SavingsPoolSummaryDto,
  SeriesPoint,
  StreamEvent,
  Tier,
  TimelineEvent,
  TreasurySnapshot,
} from "./types";
import { ApiError } from "./types";

// ---------- utilidades ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(20261108);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
const int = (min: number, max: number) => Math.floor(min + rnd() * (max - min + 1));
const roundTo = (n: number, step: number) => Math.round(n / step) * step;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latency = () => sleep(120 + Math.random() * 260);
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
let seq = 1000;
const id = (prefix: string) => `${prefix}_${(seq++).toString(36)}${Math.floor(rnd() * 1e6).toString(36)}`;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const FIRST = ["Ana", "Juan", "María", "Carlos", "Laura", "Andrés", "Valentina", "Santiago", "Camila", "Felipe", "Daniela", "Sebastián", "Isabella", "Mateo", "Paula", "Nicolás", "Sofía", "Julián", "Mariana", "Alejandro", "Luisa", "Diego", "Natalia", "Esteban", "Gabriela", "Tomás", "Manuela", "Samuel"];
const LAST = ["Gómez", "Rodríguez", "Martínez", "López", "García", "Hernández", "Pérez", "Ramírez", "Torres", "Díaz", "Moreno", "Vargas", "Rojas", "Castro", "Ortiz", "Jiménez", "Suárez", "Restrepo", "Ospina", "Cardona", "Mejía", "Quintero", "Salazar", "Arango"];
const BANKS = ["Bancolombia", "Davivienda", "Banco de Bogotá", "Nequi", "Daviplata", "BBVA Colombia", "Banco de Occidente", "Scotiabank Colpatria"];
const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// ---------- estado ----------
interface CustomerRec extends Omit<AdminCustomerDetail, "recentTransactions" | "beneficiaries" | "limits"> {
  phoneFull: string;
  documentFull: string;
}

interface State {
  now: number;
  admins: (Admin & { password?: string })[];
  customers: CustomerRec[];
  txs: AdminTransaction[];
  extraLedger: Record<string, LedgerEntry[]>;
  extraTimeline: Record<string, TimelineEvent[]>;
  beneficiaries: AdminBeneficiary[];
  alerts: ComplianceAlert[];
  providers: ProviderStatus[];
  fx: FxConfig;
  limits: LimitsConfig;
  audit: AuditEntry[];
  series: SeriesPoint[];
  recon: TreasurySnapshot["reconciliation"];
  providerBalances: Record<string, number>;
}

const DEFAULT_LIMITS: LimitsConfig = {
  tiers: [
    {
      tier: "basic",
      items: [
        { operation: "transfer_out", period: "daily", limitMinor: 100_000_000 },
        { operation: "transfer_out", period: "monthly", limitMinor: 500_000_000 },
        { operation: "transfer_out", period: "annual", limitMinor: 3_000_000_000 },
        { operation: "conversion", period: "daily", limitMinor: 50_000_000 },
        { operation: "conversion", period: "monthly", limitMinor: 300_000_000 },
        { operation: "deposit_in", period: "monthly", limitMinor: 500_000_000 },
      ],
    },
    {
      tier: "full",
      items: [
        { operation: "transfer_out", period: "daily", limitMinor: 300_000_000 },
        { operation: "transfer_out", period: "monthly", limitMinor: 2_000_000_000 },
        { operation: "transfer_out", period: "annual", limitMinor: 15_000_000_000 },
        { operation: "conversion", period: "daily", limitMinor: 200_000_000 },
        { operation: "conversion", period: "monthly", limitMinor: 1_500_000_000 },
        { operation: "deposit_in", period: "monthly", limitMinor: 2_000_000_000 },
      ],
    },
  ],
};

function makeCustomer(createdAt: number): CustomerRec {
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  const kycStatus: KycStatus = rnd() < 0.8 ? "approved" : pick(["pending", "pending", "rejected", "retry", "not_started"] as const);
  const tier: Tier = kycStatus === "approved" && rnd() < 0.7 ? "full" : "basic";
  const riskLevel: RiskLevel = rnd() < 0.82 ? "low" : rnd() < 0.7 ? "medium" : "high";
  const phoneFull = `+57 3${int(0, 2)}${int(0, 9)} ${int(100, 999)} ${int(1000, 9999)}`;
  const documentFull = `${int(10, 1199)}${int(100000, 999999)}`;
  const cop = kycStatus === "approved" ? roundTo(int(0, 4_500_000), 100) * 100 : 0;
  const brl = kycStatus === "approved" && rnd() < 0.55 ? int(0, 380_000) : 0;
  const held = rnd() < 0.15 ? Math.min(cop, roundTo(int(20_000, 300_000), 1000) * 100) : 0;
  const handle = strip(firstName) + int(10, 999);
  const custId = id("usr");
  const devices: Device[] = Array.from({ length: rnd() < 0.85 ? 1 : int(2, 4) }, (_, i) => ({
    id: id("dev"),
    name: i === 0 ? `iPhone de ${firstName}` : pick(["iPhone 16 Pro", "iPhone 15", "iPhone 14", "iPhone 13 mini"]),
    createdAt: iso(createdAt + i * DAY * int(1, 9)),
    lastUsedAt: iso(createdAt + DAY * int(0, 20)),
    revoked: i > 0 && rnd() < 0.3,
  }));
  return {
    id: custId,
    firstName,
    lastName,
    email: `${strip(firstName)}.${strip(lastName)}${int(1, 99)}@${pick(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com"])}`,
    phone: phoneFull,
    phoneFull,
    country: "CO",
    kycStatus,
    tier,
    status: rnd() < 0.02 ? "frozen" : "active",
    riskLevel,
    balances: { COP: cop, BRL: brl },
    createdAt: iso(createdAt),
    lastActiveAt: iso(Math.min(Date.now(), createdAt + DAY * int(0, 40))),
    documentType: "CC",
    documentNumber: documentFull,
    documentFull,
    kyc: {
      provider: "sumsub",
      applicantId: Math.floor(rnd() * 1e16).toString(16).padStart(24, "6"),
      status: kycStatus,
      reviewAnswer: kycStatus === "approved" ? "GREEN" : kycStatus === "rejected" ? "RED" : null,
      rejectLabels: kycStatus === "rejected" ? [pick(["DOCUMENT_DAMAGED", "SELFIE_MISMATCH", "FORGERY", "UNSATISFACTORY_PHOTOS"])] : [],
      updatedAt: iso(createdAt + 3_600_000 * int(1, 30)),
    },
    wallets: [
      { currency: "COP", balanceMinor: cop, availableMinor: cop - held, heldMinor: held },
      { currency: "BRL", balanceMinor: brl, availableMinor: brl, heldMinor: 0 },
    ],
    brebKey: kycStatus === "approved" ? { alias: `@cuypay${handle}`, status: "active", createdAt: iso(createdAt + DAY) } : null,
    limitOverrides: [],
    devices,
    notes: [],
  };
}

function makeTx(c: CustomerRec, t: number, fx: FxConfig, forceStatus?: AdminTransaction["status"]): AdminTransaction {
  const r = rnd();
  const type: AdminTransaction["type"] = r < 0.5 ? "deposit" : r < 0.78 ? "transfer" : "conversion";
  const name = `${c.firstName} ${c.lastName}`;
  const status: AdminTransaction["status"] =
    forceStatus ?? (rnd() < 0.9 ? "completed" : pick(["pending", "failed", "reversed", "pending"] as const));
  const base = {
    id: id("txn"),
    customerId: c.id,
    customerName: name,
    status,
    flagged: false,
    createdAt: iso(t),
    updatedAt: iso(t + int(5, 400) * 1000),
  };
  if (type === "deposit") {
    const amount = roundTo(int(20_000, 3_200_000), 1000) * 100;
    return {
      ...base,
      type,
      direction: "in",
      currency: "COP",
      amountMinor: amount,
      feeMinor: 0,
      counterparty: `${pick(FIRST)} ${pick(LAST)} · Bre-B ${pick(BANKS)}`,
      conversion: null,
      flagged: amount >= 1_000_000_000,
    };
  }
  if (type === "transfer") {
    const amount = roundTo(int(15_000, 2_000_000), 1000) * 100;
    return {
      ...base,
      type,
      direction: "out",
      currency: "COP",
      amountMinor: amount,
      feeMinor: 0,
      counterparty: `${pick(FIRST)} ${pick(LAST)} · 3${int(0, 2)}${int(10000000, 99999999)}`,
      conversion: null,
    };
  }
  const from = roundTo(int(50_000, 2_000_000), 1000) * 100;
  const q = quote(from, fx);
  return {
    ...base,
    type,
    direction: "out",
    currency: "COP",
    amountMinor: from,
    feeMinor: q.feeMinor,
    counterparty: "Bolsillo BRL",
    conversion: { fromCurrency: "COP", fromAmountMinor: from, toCurrency: "BRL", toAmountMinor: q.toAmountMinor, rate: fx.customerRate },
  };
}

function seed(): State {
  rnd = mulberry32(20261108);
  const now = Date.now();
  const midRate = 0.0013134;
  const fx: FxConfig = {
    pair: "COP/BRL",
    midRate,
    customerRate: customerRateFrom(midRate, 100),
    spreadBps: 100,
    feeBps: 100,
    minFeeMinor: 200_000,
    minAmountMinor: 2_000_000,
    maxAmountMinor: 2_000_000_000,
    enabled: true,
    updatedAt: iso(now - 2 * DAY),
    updatedBy: "tesoreria@cuypay.com",
  };

  const admins: State["admins"] = [
    { id: "adm_dev", email: "admin@cuypay.com", name: "Admin (dev)", role: "owner", status: "active", lastLoginAt: iso(now - 2 * DAY), createdAt: iso(now - 130 * DAY) },
    { id: "adm_owner", email: "owner@cuypay.com", name: "Brayan Ortiz", role: "owner", status: "active", lastLoginAt: iso(now - 3_600_000), createdAt: iso(now - 120 * DAY) },
    { id: "adm_comp", email: "cumplimiento@cuypay.com", name: "Laura Restrepo", role: "compliance", status: "active", lastLoginAt: iso(now - 5 * 3_600_000), createdAt: iso(now - 90 * DAY) },
    { id: "adm_treas", email: "tesoreria@cuypay.com", name: "Andrés Mejía", role: "treasury", status: "active", lastLoginAt: iso(now - DAY), createdAt: iso(now - 80 * DAY) },
    { id: "adm_supp", email: "soporte@cuypay.com", name: "Camila Ospina", role: "support", status: "active", lastLoginAt: iso(now - 2 * 3_600_000), createdAt: iso(now - 60 * DAY) },
    { id: "adm_view", email: "lectura@cuypay.com", name: "Auditor externo", role: "viewer", status: "active", lastLoginAt: null, createdAt: iso(now - 10 * DAY) },
    { id: "adm_old", email: "exempleado@cuypay.com", name: "Pedro Salazar", role: "support", status: "disabled", lastLoginAt: iso(now - 45 * DAY), createdAt: iso(now - 200 * DAY) },
  ];

  const customers: CustomerRec[] = [];
  for (let i = 0; i < 160; i++) customers.push(makeCustomer(now - int(0, 110) * DAY - int(0, 86_000) * 1000));
  customers.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const approved = customers.filter((c) => c.kycStatus === "approved");
  const txs: AdminTransaction[] = [];
  for (let i = 0; i < 900; i++) {
    const c = pick(approved);
    const t = now - Math.floor(Math.pow(rnd(), 1.3) * 30 * DAY);
    txs.push(makeTx(c, t, fx));
  }
  txs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Algunas pendientes recientes y una fallida reciente
  txs.slice(0, 6).forEach((t, i) => (t.status = i % 3 === 0 ? "pending" : t.status));
  if (txs[7]) txs[7].status = "failed";

  // Serie de 30 días a partir de las transacciones
  const series: SeriesPoint[] = [];
  const bogotaDate = (t: number) => new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
  for (let d = 29; d >= 0; d--) {
    const date = bogotaDate(now - d * DAY);
    series.push({ date, depositsMinor: 0, transfersMinor: 0, conversionsMinor: 0, newCustomers: 0 });
  }
  const byDate = new Map(series.map((p) => [p.date, p]));
  for (const t of txs) {
    const p = byDate.get(bogotaDate(Date.parse(t.createdAt)));
    if (!p || t.status === "failed") continue;
    if (t.type === "deposit") p.depositsMinor += t.amountMinor;
    else if (t.type === "transfer") p.transfersMinor += t.amountMinor;
    else p.conversionsMinor += t.amountMinor;
  }
  for (const c of customers) {
    const p = byDate.get(bogotaDate(Date.parse(c.createdAt)));
    if (p) p.newCustomers += 1;
  }

  // Beneficiarios
  const beneficiaries: AdminBeneficiary[] = [];
  for (const c of approved) {
    const n = int(0, 3);
    for (let i = 0; i < n; i++) {
      const holder = `${pick(FIRST)} ${pick(LAST)}`;
      const r = rnd();
      const result = r < 0.9 ? "clear" : r < 0.96 ? "review" : "hit";
      beneficiaries.push({
        id: id("ben"),
        customerId: c.id,
        customerName: `${c.firstName} ${c.lastName}`,
        alias: rnd() < 0.6 ? `3${int(0, 2)}${int(10000000, 99999999)}` : `@${strip(holder.split(" ")[0])}${int(1, 99)}`,
        holderName: holder,
        bankName: pick(BANKS),
        status: result === "clear" ? "active" : result === "hit" ? "rejected" : "active",
        aml: {
          provider: "sartblock",
          result,
          referenceId: `sb_${Math.floor(rnd() * 1e10).toString(36)}`,
          matches:
            result === "clear"
              ? []
              : [{ list: pick(["OFAC", "ONU", "PEP", "Procuraduría", "Policía"]), name: holder.toUpperCase(), score: Number((0.72 + rnd() * 0.25).toFixed(2)) }],
          checkedAt: iso(now - int(1, 60) * DAY),
        },
        createdAt: iso(now - int(1, 60) * DAY),
      });
    }
  }
  // Cola de revisión AML
  for (let i = 0; i < 4; i++) {
    const c = pick(approved);
    const holder = `${pick(FIRST)} ${pick(LAST)} ${pick(LAST)}`;
    beneficiaries.push({
      id: id("ben"),
      customerId: c.id,
      customerName: `${c.firstName} ${c.lastName}`,
      alias: `3${int(0, 2)}${int(10000000, 99999999)}`,
      holderName: holder,
      bankName: pick(BANKS),
      status: "pending_review",
      aml: {
        provider: "sartblock",
        result: "review",
        referenceId: `sb_${Math.floor(rnd() * 1e10).toString(36)}`,
        matches: [
          { list: pick(["PEP", "ONU", "OFAC", "Procuraduría"]), name: holder.toUpperCase(), score: Number((0.7 + rnd() * 0.2).toFixed(2)) },
          ...(rnd() < 0.5 ? [{ list: "Medios adversos", name: holder.split(" ").slice(0, 2).join(" ").toUpperCase(), score: Number((0.6 + rnd() * 0.2).toFixed(2)) }] : []),
        ],
        checkedAt: iso(now - int(1, 30) * 3_600_000),
      },
      createdAt: iso(now - int(1, 30) * 3_600_000),
    });
  }

  // Alertas
  const alertDefs: { type: AlertType; severity: RiskLevel; desc: string }[] = [
    { type: "large_transaction", severity: "medium", desc: "Depósito individual ≥ COP 10.000.000" },
    { type: "velocity", severity: "medium", desc: "Más de 5 envíos en 1 hora" },
    { type: "structuring", severity: "high", desc: "4 depósitos de COP 9.8–9.9 M en 24 h (posible fraccionamiento)" },
    { type: "aml_hit", severity: "high", desc: "Coincidencia AML en beneficiario (lista PEP, score 0,91)" },
    { type: "multiple_devices", severity: "low", desc: "4 dispositivos nuevos en 30 días" },
    { type: "deposit_over_limit", severity: "medium", desc: "Depósito excede el límite mensual deposit_in" },
  ];
  const alerts: ComplianceAlert[] = [];
  for (let i = 0; i < 14; i++) {
    const d = alertDefs[i % alertDefs.length];
    const c = pick(approved);
    const tx = txs.find((t) => t.customerId === c.id) ?? null;
    const open = i < 3;
    const resolution = open ? null : pick(["false_positive", "false_positive", "customer_contacted", "reported"] as const);
    const created = now - int(1, 25) * DAY + int(0, 80_000) * 1000;
    alerts.push({
      id: id("alr"),
      type: d.type,
      severity: d.severity,
      customerId: c.id,
      customerName: `${c.firstName} ${c.lastName}`,
      transactionId: d.type === "multiple_devices" ? null : tx?.id ?? null,
      description: d.desc,
      uiafSuggested: d.type === "structuring" || d.type === "aml_hit" || d.type === "deposit_over_limit",
      status: open ? "open" : "resolved",
      resolution,
      resolutionNote: open ? null : resolution === "reported" ? "ROS enviado a la UIAF (SIREL)." : resolution === "customer_contacted" ? "Cliente aportó soporte de origen de fondos." : "Homónimo / patrón esperado del cliente.",
      reportToUiaf: resolution === "reported",
      createdAt: iso(open ? now - int(1, 20) * 3_600_000 : created),
      resolvedAt: open ? null : iso(created + int(1, 30) * 3_600_000),
      resolvedBy: open ? null : "cumplimiento@cuypay.com",
    });
  }
  alerts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const a of alerts) if (a.transactionId) {
    const t = txs.find((x) => x.id === a.transactionId);
    if (t && a.status === "open") t.flagged = true;
  }

  const providers: ProviderStatus[] = [
    { id: "coinsenda", name: "Coinsenda (Bre-B)", status: "operational", mode: "mock", latencyMs: 182, successRate24h: 0.998, lastCheckAt: iso(now - 40_000), lastError: null },
    { id: "sumsub", name: "Sumsub (KYC)", status: "operational", mode: "mock", latencyMs: 240, successRate24h: 0.999, lastCheckAt: iso(now - 55_000), lastError: null },
    { id: "sartblock", name: "Sartblock (AML)", status: "degraded", mode: "mock", latencyMs: 1320, successRate24h: 0.962, lastCheckAt: iso(now - 30_000), lastError: "Timeout 5000 ms en /screening (3 de las últimas 50)" },
    { id: "brl_partner", name: "Socio BRL / PIX", status: "operational", mode: "mock", latencyMs: 310, successRate24h: 0.995, lastCheckAt: iso(now - 70_000), lastError: null },
    { id: "otp", name: "OTP SMS", status: "operational", mode: "mock", latencyMs: 95, successRate24h: 0.991, lastCheckAt: iso(now - 20_000), lastError: null },
  ];

  const liabilitiesCOP = customers.reduce((s, c) => s + c.balances.COP, 0);
  const liabilitiesBRL = customers.reduce((s, c) => s + c.balances.BRL, 0);

  const audit: AuditEntry[] = [];
  const actions = [
    ["customer.freeze", "customer"],
    ["customer.unfreeze", "customer"],
    ["customer.tier", "customer"],
    ["beneficiary.approve", "beneficiary"],
    ["alert.resolve", "alert"],
    ["treasury.fx.update", "fx"],
    ["treasury.reconcile", "treasury"],
    ["admin.login", "admin"],
    ["limits.update", "limits"],
  ] as const;
  for (let i = 0; i < 60; i++) {
    const [action, targetType] = pick(actions);
    const actor = pick(admins.slice(0, 4));
    audit.push({
      id: id("aud"),
      at: iso(now - Math.floor(rnd() * 30 * DAY)),
      actor: { id: actor.id, email: actor.email, role: actor.role },
      action,
      targetType,
      targetId: targetType === "customer" ? pick(customers).id : targetType === "fx" ? "COP/BRL" : targetType === "admin" ? actor.id : id("ref"),
      reason: action === "admin.login" ? null : pick(["Solicitud del cliente por chat #48211", "Revisión SARLAFT mensual", "Coincidencia descartada: homónimo", "Ajuste de spread por volatilidad", "Conciliación diaria", "Documento verificado manualmente"]),
      before: action === "treasury.fx.update" ? { spreadBps: 120 } : null,
      after: action === "treasury.fx.update" ? { spreadBps: 100 } : null,
      ip: `190.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131",
    });
  }
  audit.sort((a, b) => b.at.localeCompare(a.at));

  return {
    now,
    admins,
    customers,
    txs,
    extraLedger: {},
    extraTimeline: {},
    beneficiaries,
    alerts,
    providers,
    fx,
    limits: clone(DEFAULT_LIMITS),
    audit,
    series,
    recon: {
      status: "breaks",
      lastRunAt: iso(now - 6 * 3_600_000),
      breaks: [
        { kind: "amount_mismatch", reference: "cs_wd_88123", amountMinor: 150_000, currency: "COP", detail: "Proveedor 1.351.500,00 vs ledger 1.350.000,00" },
        { kind: "missing_in_ledger", reference: "cs_dp_88190", amountMinor: 5_000_000, currency: "COP", detail: "Depósito Bre-B confirmado por Coinsenda sin asiento en el ledger" },
        { kind: "status_mismatch", reference: "cs_wd_88201", amountMinor: 820_000, currency: "COP", detail: "Proveedor: completed · ledger: pending" },
      ],
    },
    providerBalances: {
      coinsenda_cop: liabilitiesCOP + 1_850_000_000,
      brl_partner: Math.round(liabilitiesBRL * 1.04),
    },
  };
}

// ---------- API simulada ----------
export function createMockApi(): AdminApi {
  const s = seed();
  let current: Admin | null = null;
  const pendingMfa = new Map<string, string>(); // mfaToken -> adminId
  const listeners = new Set<(e: StreamEvent) => void>();

  const restore = () => {
    if (current) return current;
    try {
      const raw = typeof window !== "undefined" ? window.sessionStorage.getItem("cuypay.admin.session") : null;
      if (raw) {
        const parsed = JSON.parse(raw) as { admin: Admin };
        current = s.admins.find((a) => a.id === parsed.admin.id) ?? null;
      }
    } catch {
      /* ignore */
    }
    return current;
  };

  const requireAuth = (): Admin => {
    const a = restore();
    if (!a) throw new ApiError(401, "UNAUTHORIZED", "Sesión expirada.");
    return a;
  };
  const requirePerm = (p: Parameters<typeof can>[1]) => {
    const a = requireAuth();
    if (!can(a.role, p)) throw new ApiError(403, "FORBIDDEN", "Tu rol no tiene permiso para esta acción.");
    return a;
  };
  const requireReason = (reason: string | undefined) => {
    const len = reason?.trim().length ?? 0;
    if (len < 3 || len > 1000)
      throw new ApiError(400, "VALIDATION_ERROR", "El motivo (reason) es obligatorio (3–1000 caracteres).");
  };
  const audit = (action: string, targetType: string, targetId: string, reason: string | null, before: unknown = null, after: unknown = null) => {
    const a = requireAuth();
    s.audit.unshift({
      id: id("aud"),
      at: new Date().toISOString(),
      actor: { id: a.id, email: a.email, role: a.role },
      action,
      targetType,
      targetId,
      reason,
      before,
      after,
      ip: "190.85.12.44",
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "demo",
    });
  };
  const emit = (e: StreamEvent) => listeners.forEach((l) => l(e));

  const maskPhone = (p: string) => p.replace(/\s/g, "").replace(/^(\+57\d{3})\d+(\d{4})$/, "$1***$2");
  const maskDoc = (d: string) => `****${d.slice(-4)}`;
  const summary = (c: CustomerRec): AdminCustomerSummary => {
    const a = restore();
    const pii = can(a?.role, "pii:read");
    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      email: c.email,
      phone: pii ? c.phoneFull : maskPhone(c.phoneFull),
      country: c.country,
      kycStatus: c.kycStatus,
      tier: c.tier,
      status: c.status,
      riskLevel: c.riskLevel,
      balances: { ...c.balances },
      createdAt: c.createdAt,
      lastActiveAt: c.lastActiveAt,
    };
  };
  const findCustomer = (cid: string) => {
    const c = s.customers.find((x) => x.id === cid);
    if (!c) throw new ApiError(404, "NOT_FOUND", "Cliente no encontrado.");
    return c;
  };
  const findTx = (tid: string) => {
    const t = s.txs.find((x) => x.id === tid);
    if (!t) throw new ApiError(404, "NOT_FOUND", "Transacción no encontrada.");
    return t;
  };

  const limitsFor = (c: CustomerRec) => {
    const tierItems = s.limits.tiers.find((t) => t.tier === c.tier)?.items ?? [];
    const now = Date.now();
    const used = (op: string, period: string) => {
      const since = period === "daily" ? now - DAY : period === "monthly" ? now - 30 * DAY : now - 365 * DAY;
      return s.txs
        .filter(
          (t) =>
            t.customerId === c.id &&
            t.status !== "failed" &&
            t.status !== "reversed" &&
            Date.parse(t.createdAt) >= since &&
            ((op === "transfer_out" && t.type === "transfer") ||
              (op === "conversion" && t.type === "conversion") ||
              (op === "deposit_in" && t.type === "deposit")),
        )
        .reduce((sum, t) => sum + t.amountMinor, 0);
    };
    return {
      tier: c.tier,
      currency: "COP" as const,
      items: tierItems.map((i) => {
        const o = c.limitOverrides.find((x) => x.operation === i.operation && x.period === i.period);
        return { ...i, limitMinor: o ? o.limitMinor : i.limitMinor, usedMinor: used(i.operation, i.period) };
      }),
    };
  };

  const treasury = (): TreasurySnapshot => {
    const liabilities = {
      COP: s.customers.reduce((sum, c) => sum + c.balances.COP, 0),
      BRL: s.customers.reduce((sum, c) => sum + c.balances.BRL, 0),
    };
    const acct = (
      a: Omit<TreasurySnapshot["accounts"][number], "differenceMinor" | "error"> & { error?: string | null },
    ): TreasurySnapshot["accounts"][number] => ({
      ...a,
      differenceMinor: a.providerBalanceMinor === null ? null : a.providerBalanceMinor - a.ledgerBalanceMinor,
      error: a.error ?? null,
    });
    const accounts: TreasurySnapshot["accounts"] = [
      acct({ id: "coinsenda_cop", name: "Coinsenda · COP (Bre-B)", provider: "coinsenda", currency: "COP", providerBalanceMinor: s.providerBalances.coinsenda_cop, ledgerBalanceMinor: liabilities.COP + 1_849_850_000, lastSyncedAt: iso(Date.now() - 45_000), status: "ok" }),
      acct({ id: "brl_partner", name: "Socio BRL / PIX", provider: "brl_partner", currency: "BRL", providerBalanceMinor: s.providerBalances.brl_partner, ledgerBalanceMinor: s.providerBalances.brl_partner, lastSyncedAt: iso(Date.now() - 9 * 60_000), status: "stale" }),
      acct({ id: "brl_partner_fx", name: "Socio BRL · cuenta FX", provider: "brl_partner", currency: "BRL", providerBalanceMinor: null, ledgerBalanceMinor: 0, lastSyncedAt: iso(Date.now() - 42 * 60_000), status: "error", error: "El proveedor no expone saldo para esta cuenta (HTTP 501)" }),
    ];
    const coverage = (["COP", "BRL"] as const).map((cur) => {
      const providerMinor = accounts.filter((a) => a.currency === cur).reduce((x, a) => x + (a.providerBalanceMinor ?? 0), 0);
      const liabilitiesMinor = liabilities[cur];
      return {
        currency: cur,
        providerMinor,
        liabilitiesMinor,
        differenceMinor: providerMinor - liabilitiesMinor,
        ratio: liabilitiesMinor ? Number((providerMinor / liabilitiesMinor).toFixed(4)) : 1,
      };
    });
    const startToday = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const fees = (since: (t: AdminTransaction) => boolean) =>
      s.txs.filter((t) => t.status === "completed" && since(t)).reduce((x, t) => x + t.feeMinor, 0);
    return {
      asOf: new Date().toISOString(),
      accounts,
      liabilities,
      coverage,
      revenue: {
        todayMinor: fees((t) => new Date(Date.parse(t.createdAt) - 5 * 3_600_000).toISOString().slice(0, 10) === startToday),
        monthMinor: fees((t) => Date.parse(t.createdAt) > Date.now() - 30 * DAY),
        currency: "COP",
      },
      reconciliation: clone(s.recon),
    };
  };

  const ledgerFor = (t: AdminTransaction): LedgerEntry[] => {
    const cust = `customer:${t.customerId}`;
    let e: LedgerEntry[] = [];
    if (t.type === "deposit") {
      e = [
        { account: "provider:coinsenda:COP", debitMinor: t.amountMinor, creditMinor: 0, currency: "COP" },
        { account: `${cust}:COP`, debitMinor: 0, creditMinor: t.amountMinor, currency: "COP" },
      ];
    } else if (t.type === "transfer") {
      e = [
        { account: `${cust}:COP`, debitMinor: t.amountMinor + t.feeMinor, creditMinor: 0, currency: "COP" },
        { account: "provider:coinsenda:COP", debitMinor: 0, creditMinor: t.amountMinor, currency: "COP" },
      ];
      if (t.feeMinor) e.push({ account: "revenue:fees:COP", debitMinor: 0, creditMinor: t.feeMinor, currency: "COP" });
    } else if (t.conversion) {
      e = [
        { account: `${cust}:COP`, debitMinor: t.amountMinor, creditMinor: 0, currency: "COP" },
        { account: "fx:pool:COP", debitMinor: 0, creditMinor: t.amountMinor - t.feeMinor, currency: "COP" },
        { account: "revenue:fees:COP", debitMinor: 0, creditMinor: t.feeMinor, currency: "COP" },
        { account: "fx:pool:BRL", debitMinor: t.conversion.toAmountMinor, creditMinor: 0, currency: "BRL" },
        { account: `${cust}:BRL`, debitMinor: 0, creditMinor: t.conversion.toAmountMinor, currency: "BRL" },
      ];
    }
    if (t.status === "failed") return [];
    return [...e, ...(s.extraLedger[t.id] ?? [])];
  };

  const timelineFor = (t: AdminTransaction): TimelineEvent[] => {
    const at0 = Date.parse(t.createdAt);
    const ev: TimelineEvent[] = [{ at: iso(at0), event: "created", detail: t.type === "deposit" ? "Notificación de depósito Bre-B (webhook Coinsenda)" : "Solicitud firmada con Face ID" }];
    if (t.type !== "deposit") ev.push({ at: iso(at0 + 400), event: "held", detail: "Fondos retenidos en el bolsillo COP" });
    ev.push({ at: iso(at0 + 1500), event: "provider_submitted", detail: t.type === "conversion" ? "Orden enviada al socio BRL" : "Enviado a Coinsenda" });
    if (t.status === "failed") ev.push({ at: t.updatedAt, event: "failed", detail: "PROVIDER_ERROR: el proveedor rechazó la operación; fondos liberados" });
    else if (t.status !== "pending") {
      ev.push({ at: iso(at0 + 4000), event: "provider_confirmed", detail: "Confirmado por el proveedor" });
      ev.push({ at: iso(at0 + 4200), event: "completed", detail: "Asientos contables registrados" });
    }
    return [...ev, ...(s.extraTimeline[t.id] ?? [])];
  };

  const paginate = <T,>(items: T[], limit = 25, cursor?: string | null): Page<T> => {
    const start = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
    const slice = items.slice(start, start + limit);
    return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
  };

  // ----- simulador SSE -----
  let simTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    const r = Math.random();
    const approved = s.customers.filter((c) => c.kycStatus === "approved" && c.status === "active");
    if (r < 0.55) {
      const c = approved[Math.floor(Math.random() * approved.length)];
      const t = makeTx(c, Date.now(), s.fx, Math.random() < 0.5 ? "pending" : "completed");
      t.updatedAt = t.createdAt;
      s.txs.unshift(t);
      if (t.status === "completed") applyBalance(t);
      emit({ type: "transaction.created", data: clone(t) });
    } else if (r < 0.75) {
      const t = s.txs.find((x) => x.status === "pending");
      if (t) {
        t.status = Math.random() < 0.93 ? "completed" : "failed";
        t.updatedAt = new Date().toISOString();
        if (t.status === "completed") applyBalance(t);
        emit({ type: "transaction.updated", data: clone(t) });
      }
    } else if (r < 0.85) {
      const c = makeCustomer(Date.now());
      c.kycStatus = "pending";
      c.kyc.status = "pending";
      c.kyc.reviewAnswer = null;
      c.brebKey = null;
      c.balances = { COP: 0, BRL: 0 };
      c.wallets.forEach((w) => ((w.balanceMinor = 0), (w.availableMinor = 0), (w.heldMinor = 0)));
      s.customers.unshift(c);
      s.series[s.series.length - 1].newCustomers += 1;
      emit({ type: "customer.created", data: summary(c) });
    } else if (r < 0.91) {
      const c = s.customers.find((x) => x.kycStatus === "pending");
      if (c) {
        c.kycStatus = "approved";
        c.kyc.status = "approved";
        c.kyc.reviewAnswer = "GREEN";
        c.tier = "full";
        emit({ type: "kyc.updated", data: { customerId: c.id, status: c.kycStatus, tier: c.tier } });
      }
    } else if (r < 0.95) {
      const c = approved[Math.floor(Math.random() * approved.length)];
      const a: ComplianceAlert = {
        id: id("alr"),
        type: "velocity",
        severity: "medium",
        customerId: c.id,
        customerName: `${c.firstName} ${c.lastName}`,
        transactionId: s.txs.find((t) => t.customerId === c.id)?.id ?? null,
        description: "Más de 5 envíos en 1 hora",
        uiafSuggested: false,
        status: "open",
        resolution: null,
        resolutionNote: null,
        reportToUiaf: false,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        resolvedBy: null,
      };
      s.alerts.unshift(a);
      emit({ type: "compliance.alert", data: clone(a) });
    } else {
      const p = s.providers[Math.floor(Math.random() * s.providers.length)];
      p.latencyMs = Math.max(60, Math.round(p.latencyMs * (0.7 + Math.random() * 0.6)));
      p.lastCheckAt = new Date().toISOString();
      emit({ type: "provider.status", data: clone(p) });
    }
    simTimer = setTimeout(tick, 3500 + Math.random() * 4500);
  };
  const applyBalance = (t: AdminTransaction) => {
    const c = s.customers.find((x) => x.id === t.customerId);
    if (!c) return;
    const p = s.series[s.series.length - 1];
    if (t.type === "deposit") {
      c.balances.COP += t.amountMinor;
      s.providerBalances.coinsenda_cop += t.amountMinor;
      p.depositsMinor += t.amountMinor;
    } else if (t.type === "transfer") {
      c.balances.COP = Math.max(0, c.balances.COP - t.amountMinor);
      s.providerBalances.coinsenda_cop -= t.amountMinor;
      p.transfersMinor += t.amountMinor;
    } else if (t.conversion) {
      c.balances.COP = Math.max(0, c.balances.COP - t.amountMinor);
      c.balances.BRL += t.conversion.toAmountMinor;
      s.providerBalances.brl_partner += t.conversion.toAmountMinor;
      p.conversionsMinor += t.amountMinor;
    }
    c.wallets[0].balanceMinor = c.balances.COP;
    c.wallets[0].availableMinor = c.balances.COP - c.wallets[0].heldMinor;
    c.wallets[1].balanceMinor = c.wallets[1].availableMinor = c.balances.BRL;
    c.lastActiveAt = new Date().toISOString();
  };

  const startSim = () => {
    if (simTimer) return;
    simTimer = setTimeout(tick, 2500);
    pingTimer = setInterval(() => emit({ type: "ping", data: { at: new Date().toISOString() } }), 25_000);
  };
  const stopSim = () => {
    if (simTimer) clearTimeout(simTimer);
    if (pingTimer) clearInterval(pingTimer);
    simTimer = null;
    pingTimer = null;
  };

  const bogotaToday = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
  const isToday = (isoStr: string) => new Date(Date.parse(isoStr) - 5 * 3_600_000).toISOString().slice(0, 10) === bogotaToday();

  let mockSavingsCfg = {
    rates: [
      { termDays: 30, ratePercent: 3.0, enabled: true },
      { termDays: 60, ratePercent: 4.5, enabled: true },
      { termDays: 90, ratePercent: 6.0, enabled: true },
      { termDays: 180, ratePercent: 8.5, enabled: true },
      { termDays: 360, ratePercent: 11.5, enabled: true },
    ],
    minAmountMinor: "5000000",
    maxAmountMinor: "5000000000",
    contractTerms: "# Contrato Virtual de Bolsillo de Ahorro a Plazo Fijo — CuyPay (XATECH SERVICES S.A.S.)",
    updatedAt: new Date().toISOString(),
    updatedBy: "admin@cuypay.com",
  };

  const mockSavingsBlocks: SavingsBlockDto[] = [
    {
      id: "sbk_demo_001",
      userId: s.customers[0]?.id ?? "usr_01",
      customerName: s.customers[0] ? `${s.customers[0].firstName} ${s.customers[0].lastName}` : "Camila Restrepo",
      customerEmail: s.customers[0]?.email ?? "camila@correo.co",
      customerPhone: s.customers[0]?.phoneFull ?? "+573154103792",
      termDays: 30,
      principalMinor: "150000000",
      lockedRate: 3.0,
      expectedYieldMinor: "369863",
      totalPayoutMinor: "150369863",
      currency: "COP",
      status: "maturing_soon",
      escrowStatus: "unfunded",
      escrowFundedAt: null,
      escrowFundedBy: null,
      startedAt: iso(Date.now() - 28 * DAY),
      maturesAt: iso(Date.now() + 2 * DAY),
      completedAt: null,
      hoursRemaining: 48,
    },
    {
      id: "sbk_demo_002",
      userId: s.customers[1]?.id ?? "usr_02",
      customerName: s.customers[1] ? `${s.customers[1].firstName} ${s.customers[1].lastName}` : "Santiago Vargas",
      customerEmail: s.customers[1]?.email ?? "santiago@correo.co",
      customerPhone: s.customers[1]?.phoneFull ?? "+573001234567",
      termDays: 90,
      principalMinor: "300000000",
      lockedRate: 6.0,
      expectedYieldMinor: "4438356",
      totalPayoutMinor: "304438356",
      currency: "COP",
      status: "active",
      escrowStatus: "unfunded",
      escrowFundedAt: null,
      escrowFundedBy: null,
      startedAt: iso(Date.now() - 12 * DAY),
      maturesAt: iso(Date.now() + 78 * DAY),
      completedAt: null,
      hoursRemaining: 78 * 24,
    },
  ];
  let mockSavingsVaultMinor = 450_000_000n;
  let mockSavingsEscrowMinor = 0n;

  const buildSavingsPoolSummary = (): SavingsPoolSummaryDto => {
    let activePrin = 0n;
    let pendingYield = 0n;
    let activePayout = 0n;
    let unescrowedPrin = 0n;
    let m72Unfunded = 0n;
    let m72Funded = 0n;
    let m72UnfundedCount = 0;
    let m72TotalCount = 0;
    let activeCount = 0;
    let completedCount = 0;
    for (const b of mockSavingsBlocks) {
      if (b.status === "active" || b.status === "maturing_soon") {
        activeCount++;
        const p = BigInt(b.principalMinor);
        const y = BigInt(b.expectedYieldMinor);
        const tot = BigInt(b.totalPayoutMinor);
        activePrin += p;
        pendingYield += y;
        activePayout += tot;
        if (b.escrowStatus !== "funded_locked") unescrowedPrin += p;
        if ((b.hoursRemaining ?? 999) <= 72) {
          m72TotalCount++;
          if (b.escrowStatus === "funded_locked") m72Funded += tot;
          else {
            m72UnfundedCount++;
            m72Unfunded += tot;
          }
        }
      } else if (b.status === "completed") {
        completedCount++;
      }
    }
    const deployed = unescrowedPrin > mockSavingsVaultMinor ? unescrowedPrin - mockSavingsVaultMinor : 0n;
    return {
      currency: "COP",
      collectionPoolBalanceMinor: mockSavingsVaultMinor.toString(),
      escrowLockedBalanceMinor: mockSavingsEscrowMinor.toString(),
      totalActivePrincipalMinor: activePrin.toString(),
      totalPendingYieldMinor: pendingYield.toString(),
      totalActivePayoutMinor: activePayout.toString(),
      deployedExternallyMinor: deployed.toString(),
      maturing72hUnfundedMinor: m72Unfunded.toString(),
      maturing72hFundedMinor: m72Funded.toString(),
      maturing72hUnfundedCount: m72UnfundedCount,
      maturing72hTotalCount: m72TotalCount,
      activeBlocksCount: activeCount,
      completedBlocksCount: completedCount,
    };
  };

  let mockLoanCfg: LoanConfigDto = {
    enabled: true,
    rates: [
      { termDays: 30, rateEaPercent: 22.0, enabled: true },
      { termDays: 60, rateEaPercent: 23.0, enabled: true },
      { termDays: 90, rateEaPercent: 24.0, enabled: true },
      { termDays: 180, rateEaPercent: 24.8, enabled: true },
      { termDays: 360, rateEaPercent: 25.5, enabled: true },
    ],
    usuryCeilingEaPercent: 26.5,
    moratoryRateEaPercent: 26.5,
    minAmountMinor: "10000000",
    maxAmountMinor: "2000000000",
    creditorLegalName: "XATECH SERVICES S.A.S.",
    creditorNit: "901.799.579",
    creditorDomicile: "Bogotá D.C., República de Colombia",
    updatedAt: new Date().toISOString(),
    updatedBy: "admin@cuypay.com",
  };

  let mockLoanPoolMinor = 800_000_000n;
  const mockLoans: LoanDto[] = [
    {
      id: "loan_demo_001",
      userId: s.customers[0]?.id ?? "usr_01",
      promissoryNoteId: "pag_demo_001",
      promissoryNoteNumber: "PAG-2026-000101",
      principalMinor: "120000000",
      termDays: 60,
      interestRateEa: 23.0,
      nominalMonthlyPercent: 1.74,
      moratoryRateEa: 26.5,
      interestMinor: "4157260",
      totalDueMinor: "124157260",
      paidMinor: "0",
      principalPaidMinor: "0",
      interestPaidMinor: "0",
      remainingMinor: "124157260",
      currency: "COP",
      status: "pending_review",
      purpose: "Capital de trabajo e inventario",
      debtorFullName: s.customers[0] ? `${s.customers[0].firstName} ${s.customers[0].lastName}` : "Camila Restrepo",
      debtorDocumentType: "CC",
      debtorDocumentNumber: s.customers[0]?.documentFull ?? "1032456789",
      debtorEmail: s.customers[0]?.email ?? "camila@correo.co",
      debtorPhone: s.customers[0]?.phoneFull ?? "+573154103792",
      debtorCity: "Bogotá D.C.",
      requestedAt: iso(Date.now() - 2 * 3_600_000),
      approvedAt: null,
      approvedBy: null,
      disbursedAt: null,
      dueAt: null,
      paidAt: null,
      rejectedAt: null,
      rejectedReason: null,
      daysRemaining: null,
    },
  ];

  const buildLoanPoolSummary = (): LoanPoolSummaryDto => {
    let activePrin = 0n;
    let activeRem = 0n;
    let pendingInt = 0n;
    let collectedInt = 0n;
    let pendingAppPrin = 0n;
    let overdueRem = 0n;
    let pendingCount = 0;
    let activeCount = 0;
    let overdueCount = 0;
    let paidCount = 0;
    for (const l of mockLoans) {
      collectedInt += BigInt(l.interestPaidMinor);
      if (l.status === "pending_review") {
        pendingCount++;
        pendingAppPrin += BigInt(l.principalMinor);
      } else if (l.status === "approved_active") {
        activeCount++;
        activePrin += BigInt(l.principalMinor) - BigInt(l.principalPaidMinor);
        activeRem += BigInt(l.remainingMinor);
        pendingInt += BigInt(l.interestMinor) - BigInt(l.interestPaidMinor);
      } else if (l.status === "overdue") {
        overdueCount++;
        activePrin += BigInt(l.principalMinor) - BigInt(l.principalPaidMinor);
        activeRem += BigInt(l.remainingMinor);
        overdueRem += BigInt(l.remainingMinor);
        pendingInt += BigInt(l.interestMinor) - BigInt(l.interestPaidMinor);
      } else if (l.status === "paid") {
        paidCount++;
      }
    }
    return {
      currency: "COP",
      availablePoolMinor: mockLoanPoolMinor.toString(),
      activePortfolioPrincipalMinor: activePrin.toString(),
      activePortfolioRemainingMinor: activeRem.toString(),
      pendingExpectedInterestMinor: pendingInt.toString(),
      collectedInterestMinor: collectedInt.toString(),
      pendingApplicationsPrincipalMinor: pendingAppPrin.toString(),
      overdueRemainingMinor: overdueRem.toString(),
      pendingApplicationsCount: pendingCount,
      activeLoansCount: activeCount,
      overdueLoansCount: overdueCount,
      paidLoansCount: paidCount,
    };
  };

  const api: AdminApi = {
    mode: "mock",
    async login(email, password) {
      await latency();
      const a = s.admins.find((x) => x.email.toLowerCase() === email.trim().toLowerCase());
      if (!a || !password) throw new ApiError(401, "UNAUTHORIZED", "Correo o contraseña incorrectos.");
      if (a.status !== "active") throw new ApiError(403, "ADMIN_DISABLED", "Usuario deshabilitado.");
      const token = `mfa_${Math.random().toString(36).slice(2)}`;
      pendingMfa.set(token, a.id);
      return { mfaToken: token, mfaRequired: true, expiresIn: 300 };
    },
    async mfa(mfaToken, code) {
      await latency();
      const adminId = pendingMfa.get(mfaToken);
      if (!adminId) throw new ApiError(401, "UNAUTHORIZED", "La sesión de verificación expiró. Vuelve a iniciar sesión.");
      if (!/^\d{6}$/.test(code)) throw new ApiError(401, "OTP_INVALID", "Código TOTP inválido.");
      pendingMfa.delete(mfaToken);
      const a = s.admins.find((x) => x.id === adminId)!;
      a.lastLoginAt = new Date().toISOString();
      current = a;
      audit("admin.login", "admin", a.id, null);
      return { accessToken: `demo.${btoa(a.id)}.${Date.now()}`, expiresIn: 1800, admin: clone(a) };
    },
    async logout() {
      current = null;
      stopSim();
    },
    async me() {
      await latency();
      const a = requireAuth();
      return { ...clone(a), permissions: permissionsForRole(a.role) };
    },
    async changePassword(currentPassword, newPassword) {
      await latency();
      requireAuth();
      if (!currentPassword) throw new ApiError(401, "UNAUTHORIZED", "La contraseña actual no es correcta.");
      if (newPassword.length < 12) throw new ApiError(400, "VALIDATION_ERROR", "La nueva contraseña debe tener al menos 12 caracteres.");
      if (newPassword === currentPassword) throw new ApiError(400, "VALIDATION_ERROR", "La nueva contraseña debe ser distinta de la actual.");
    },
    async dashboard() {
      await latency();
      requireAuth();
      const today = s.txs.filter((t) => isToday(t.createdAt) && t.status !== "failed");
      const sum = (arr: AdminTransaction[]) => arr.reduce((x, t) => x + t.amountMinor, 0);
      const dep = today.filter((t) => t.type === "deposit");
      const trf = today.filter((t) => t.type === "transfer");
      const conv = today.filter((t) => t.type === "conversion");
      return {
        generatedAt: new Date().toISOString(),
        customers: {
          total: s.customers.length,
          newToday: s.customers.filter((c) => isToday(c.createdAt)).length,
          kycApproved: s.customers.filter((c) => c.kycStatus === "approved").length,
          kycPending: s.customers.filter((c) => c.kycStatus === "pending").length,
          frozen: s.customers.filter((c) => c.status === "frozen").length,
        },
        today: {
          deposits: { count: dep.length, volumeMinor: sum(dep), currency: "COP" },
          transfers: { count: trf.length, volumeMinor: sum(trf), currency: "COP" },
          conversions: {
            count: conv.length,
            fromVolumeMinor: sum(conv),
            toVolumeMinor: conv.reduce((x, t) => x + (t.conversion?.toAmountMinor ?? 0), 0),
            fromCurrency: "COP",
            toCurrency: "BRL",
          },
          revenueMinor: today.filter((t) => t.status === "completed").reduce((x, t) => x + t.feeMinor, 0),
          revenueCurrency: "COP",
        },
        series: clone(s.series),
        queues: {
          amlReview: s.beneficiaries.filter((b) => b.status === "pending_review").length,
          complianceAlerts: s.alerts.filter((a) => a.status === "open").length,
          failedTransactions: s.txs.filter((t) => t.status === "failed" && Date.parse(t.createdAt) > Date.now() - DAY).length,
        },
        providers: clone(s.providers),
        treasury: treasury(),
      };
    },

    async customers(q) {
      await latency();
      requireAuth();
      const needle = strip(q.query ?? "").trim();
      const items = s.customers.filter((c) => {
        if (q.kycStatus && c.kycStatus !== q.kycStatus) return false;
        if (q.tier && c.tier !== q.tier) return false;
        if (q.status && c.status !== q.status) return false;
        if (!needle) return true;
        const hay = strip(
          [c.firstName, c.lastName, c.email, c.phoneFull.replace(/\s/g, ""), c.documentFull, c.brebKey?.alias ?? "", c.id].join(" "),
        );
        return hay.includes(needle.replace(/\s/g, "")) || hay.includes(needle);
      });
      const page = paginate(items, q.limit ?? 25, q.cursor);
      return { items: page.items.map(summary), nextCursor: page.nextCursor };
    },
    async customer(cid) {
      await latency();
      const a = requireAuth();
      const c = findCustomer(cid);
      const pii = can(a.role, "pii:read");
      return {
        ...summary(c),
        documentType: c.documentType,
        documentNumber: pii ? c.documentFull : maskDoc(c.documentFull),
        kyc: clone(c.kyc),
        wallets: clone(c.wallets),
        brebKey: clone(c.brebKey),
        limits: limitsFor(c),
        limitOverrides: clone(c.limitOverrides),
        devices: clone(c.devices),
        beneficiaries: clone(s.beneficiaries.filter((b) => b.customerId === c.id)),
        recentTransactions: clone(s.txs.filter((t) => t.customerId === c.id).slice(0, 10)),
        notes: clone(c.notes),
      };
    },
    async freeze(cid, reason) {
      await latency();
      requirePerm("customers:freeze");
      requireReason(reason);
      const c = findCustomer(cid);
      if (c.status === "frozen") throw new ApiError(409, "CONFLICT", "El cliente ya está congelado.");
      c.status = "frozen";
      audit("customer.freeze", "customer", cid, reason, { status: "active" }, { status: "frozen" });
      emit({ type: "customer.updated", data: summary(c) });
    },
    async unfreeze(cid, reason) {
      await latency();
      requirePerm("customers:freeze");
      requireReason(reason);
      const c = findCustomer(cid);
      if (c.status !== "frozen") throw new ApiError(409, "CONFLICT", "El cliente no está congelado.");
      c.status = "active";
      let releasedHeldMinor = 0;
      for (const w of c.wallets) if (w.currency === "COP") {
        releasedHeldMinor += w.heldMinor;
        w.availableMinor += w.heldMinor;
        w.heldMinor = 0;
      }
      audit("customer.unfreeze", "customer", cid, reason, { status: "frozen" }, { status: "active", releasedHeldMinor });
      emit({ type: "customer.updated", data: summary(c) });
      return { status: "active" as const, releasedHeldMinor };
    },
    async setTier(cid, tier, reason) {
      await latency();
      requirePerm("customers:limits");
      requireReason(reason);
      const c = findCustomer(cid);
      const before = c.tier;
      c.tier = tier;
      audit("customer.tier", "customer", cid, reason, { tier: before }, { tier });
      emit({ type: "customer.updated", data: summary(c) });
    },
    async setLimitOverrides(cid, items, reason) {
      await latency();
      requirePerm("customers:limits");
      requireReason(reason);
      const c = findCustomer(cid);
      const before = clone(c.limitOverrides);
      c.limitOverrides = items.map((i) => ({ operation: i.operation, period: i.period, limitMinor: Math.max(0, Math.trunc(i.limitMinor)) }));
      audit("customer.limit_overrides", "customer", cid, reason, before, c.limitOverrides);
    },
    async revokeDevice(cid, deviceId, reason) {
      await latency();
      requirePerm("customers:support");
      requireReason(reason);
      const c = findCustomer(cid);
      const d = c.devices.find((x) => x.id === deviceId);
      if (!d) throw new ApiError(404, "NOT_FOUND", "Dispositivo no encontrado.");
      d.revoked = true;
      audit("customer.device.revoke", "device", deviceId, reason, { revoked: false }, { revoked: true });
    },
    async addNote(cid, text) {
      await latency();
      const a = requirePerm("customers:support");
      requireReason(text);
      const c = findCustomer(cid);
      const n: Note = { id: id("note"), author: a.email, text: text.trim(), createdAt: new Date().toISOString() };
      c.notes.unshift(n);
      audit("customer.note", "customer", cid, n.text, null, { text: n.text });
    },

    async transactions(q) {
      await latency();
      requireAuth();
      const from = q.from ? Date.parse(q.from) : null;
      const to = q.to ? Date.parse(q.to) + DAY : null;
      const items = s.txs.filter(
        (t) =>
          (!q.type || t.type === q.type) &&
          (!q.status || t.status === q.status) &&
          (!q.currency || t.currency === q.currency) &&
          (!q.customerId || t.customerId === q.customerId) &&
          (!from || Date.parse(t.createdAt) >= from) &&
          (!to || Date.parse(t.createdAt) < to) &&
          (!q.minAmountMinor || t.amountMinor >= q.minAmountMinor) &&
          (!q.flagged || String(t.flagged) === q.flagged),
      );
      return clone(paginate(items, q.limit ?? 30, q.cursor));
    },
    async transaction(tid) {
      await latency();
      requireAuth();
      const t = findTx(tid);
      const refs: Record<string, string> = {};
      if (t.type === "deposit") refs.coinsendaDepositId = `cs_dp_${t.id.slice(4)}`;
      if (t.type === "transfer") refs.coinsendaWithdrawId = `cs_wd_${t.id.slice(4)}`;
      if (t.type === "conversion") refs.brlExecutionId = `brl_ex_${t.id.slice(4)}`;
      return { ...clone(t), ledgerEntries: ledgerFor(t), timeline: timelineFor(t), providerRefs: refs } satisfies AdminTransactionDetail;
    },
    async reverse(tid, reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      const t = findTx(tid);
      if (t.status !== "completed" && t.status !== "pending")
        throw new ApiError(409, "CONFLICT", "Solo se reversan transacciones completadas o pendientes.");
      const before = t.status;
      const mirror = ledgerFor(t).map((e) => ({ ...e, account: e.account, debitMinor: e.creditMinor, creditMinor: e.debitMinor }));
      s.extraLedger[t.id] = mirror;
      s.extraTimeline[t.id] = [{ at: new Date().toISOString(), event: "reversed", detail: `Reverso manual: ${reason}` }];
      t.status = "reversed";
      t.updatedAt = new Date().toISOString();
      const journalId = id("jrn");
      audit("transaction.reverse", "transaction", tid, reason, { status: before }, { status: "reversed", journalId });
      emit({ type: "transaction.updated", data: clone(t) });
      const warnings: string[] = [];
      if (t.type === "transfer" && before === "completed")
        warnings.push("El retiro ya fue liquidado por Coinsenda: gestiona la devolución con el proveedor.");
      if (t.type === "conversion") warnings.push("La operación BRL no se deshace en el socio; revisa la cobertura de tesorería.");
      return { transaction: await api.transaction(tid), journalId, warnings };
    },
    async exportCsv(q) {
      await latency();
      requireAuth();
      const page = await api.transactions({ ...q, limit: 100_000 });
      const head = "id,fecha,cliente_id,cliente,tipo,direccion,moneda,monto,comision,estado,contraparte,a_moneda,a_monto,tasa";
      const money = (m: number) => (m / 100).toFixed(2);
      const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const rows = page.items.map((t) =>
        [
          t.id,
          t.createdAt,
          t.customerId,
          esc(t.customerName),
          t.type,
          t.direction,
          t.currency,
          money(t.amountMinor),
          money(t.feeMinor),
          t.status,
          esc(t.counterparty),
          t.conversion?.toCurrency ?? "",
          t.conversion ? money(t.conversion.toAmountMinor) : "",
          t.conversion ? String(t.conversion.rate) : "",
        ].join(","),
      );
      return new Blob(["\ufeff" + [head, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    },

    async beneficiaries(status) {
      await latency();
      requireAuth();
      return { items: clone(s.beneficiaries.filter((b) => !status || b.status === status)), nextCursor: null };
    },
    async decideBeneficiary(bid, decision, reason) {
      await latency();
      requirePerm("compliance:decide");
      requireReason(reason);
      const b = s.beneficiaries.find((x) => x.id === bid);
      if (!b) throw new ApiError(404, "NOT_FOUND", "Beneficiario no encontrado.");
      if (b.status !== "pending_review") throw new ApiError(409, "CONFLICT", "El beneficiario ya fue decidido.");
      b.status = decision === "approve" ? "active" : "rejected";
      audit(`beneficiary.${decision}`, "beneficiary", bid, reason, { status: "pending_review" }, { status: b.status });
    },
    async alerts(q) {
      await latency();
      requireAuth();
      return {
        items: clone(s.alerts.filter((a) => (!q.status || a.status === q.status) && (!q.type || a.type === q.type))),
        nextCursor: null,
      };
    },
    async resolveAlert(aid, body) {
      await latency();
      const admin = requirePerm("compliance:decide");
      requireReason(body.note);
      const a = s.alerts.find((x) => x.id === aid);
      if (!a) throw new ApiError(404, "NOT_FOUND", "Alerta no encontrada.");
      a.status = "resolved";
      a.resolution = body.resolution;
      a.resolutionNote = body.note.trim();
      a.reportToUiaf = body.reportToUiaf;
      a.resolvedAt = new Date().toISOString();
      a.resolvedBy = admin.email;
      if (body.resolution === "frozen") {
        const c = s.customers.find((x) => x.id === a.customerId);
        if (c) {
          c.status = "frozen";
          emit({ type: "customer.updated", data: summary(c) });
        }
      }
      if (a.transactionId) {
        const t = s.txs.find((x) => x.id === a.transactionId);
        if (t) t.flagged = false;
      }
      audit("alert.resolve", "alert", aid, body.note, { status: "open" }, { status: "resolved", resolution: body.resolution, reportToUiaf: body.reportToUiaf });
    },

    async treasury() {
      await latency();
      requirePerm("treasury:read");
      return treasury();
    },
    async reconcile(reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      s.recon = { status: "running", lastRunAt: s.recon.lastRunAt, breaks: s.recon.breaks };
      audit("treasury.reconcile", "treasury", "all", reason);
      setTimeout(() => {
        s.recon = {
          status: Math.random() < 0.6 ? "ok" : "breaks",
          lastRunAt: new Date().toISOString(),
          breaks: [],
        };
        if (s.recon.status === "breaks")
          s.recon.breaks = [{ kind: "amount_mismatch", reference: `cs_wd_${Math.floor(Math.random() * 99999)}`, amountMinor: 100_000, currency: "COP", detail: "Diferencia de comisión del proveedor" }];
        emit({ type: "treasury.updated", data: treasury() });
      }, 2500);
    },
    async fx() {
      await latency();
      requirePerm("treasury:read");
      return clone(s.fx);
    },
    async updateFx(input, reason) {
      await latency();
      const a = requirePerm("treasury:write");
      requireReason(reason);
      const next = { ...s.fx, ...input };
      if (next.spreadBps < 0 || next.spreadBps > 1000) throw new ApiError(400, "VALIDATION_ERROR", "Spread fuera de rango (0–1000 bps).");
      if (next.feeBps < 0 || next.feeBps > 1000) throw new ApiError(400, "VALIDATION_ERROR", "Comisión fuera de rango (0–1000 bps).");
      if (next.minAmountMinor > next.maxAmountMinor) throw new ApiError(400, "VALIDATION_ERROR", "El mínimo no puede superar el máximo.");
      const before = clone(s.fx);
      s.fx = {
        ...next,
        customerRate: customerRateFrom(s.fx.midRate, next.spreadBps),
        updatedAt: new Date().toISOString(),
        updatedBy: a.email,
      };
      audit("treasury.fx.update", "fx", "COP/BRL", reason,
        { spreadBps: before.spreadBps, feeBps: before.feeBps, minFeeMinor: before.minFeeMinor, enabled: before.enabled },
        { spreadBps: s.fx.spreadBps, feeBps: s.fx.feeBps, minFeeMinor: s.fx.minFeeMinor, enabled: s.fx.enabled });
      return clone(s.fx);
    },

    async limitsConfig() {
      await latency();
      requireAuth();
      return clone(s.limits);
    },
    async updateLimitsConfig(tier, items, reason) {
      await latency();
      requirePerm("limits:write");
      requireReason(reason);
      const t = s.limits.tiers.find((x) => x.tier === tier);
      if (!t) throw new ApiError(404, "NOT_FOUND", "Nivel no encontrado.");
      const before = clone(t.items);
      t.items = items.map((i: LimitItem) => ({ operation: i.operation, period: i.period, limitMinor: Math.max(0, Math.trunc(i.limitMinor)) }));
      audit("limits.update", "limits", tier, reason, before, t.items);
    },

    async providers() {
      await latency();
      requireAuth();
      return { items: clone(s.providers) };
    },
    async checkProvider(pid) {
      await sleep(600 + Math.random() * 700);
      requirePerm("providers:check");
      const p = s.providers.find((x) => x.id === pid);
      if (!p) throw new ApiError(404, "NOT_FOUND", "Proveedor no encontrado.");
      p.lastCheckAt = new Date().toISOString();
      p.latencyMs = p.id === "sartblock" ? 900 + Math.round(Math.random() * 700) : 80 + Math.round(Math.random() * 300);
      if (p.id === "sartblock" && Math.random() < 0.5) {
        p.status = "operational";
        p.lastError = null;
      }
      emit({ type: "provider.status", data: clone(p) });
      return clone(p);
    },

    async auditLog(q) {
      await latency();
      requirePerm("audit:read");
      const items = s.audit.filter(
        (e) =>
          (!q.actorId || e.actor.id === q.actorId || e.actor.email.includes(q.actorId)) &&
          (!q.action || e.action.startsWith(q.action)) &&
          (!q.targetType || e.targetType === q.targetType) &&
          (!q.targetId || e.targetId === q.targetId),
      );
      return clone(paginate(items, q.limit ?? 40, q.cursor));
    },

    async users() {
      await latency();
      requirePerm("admins:manage");
      return { items: clone(s.admins.map(({ password: _p, ...a }) => (void _p, a))) };
    },
    async createUser(body, reason) {
      await latency();
      requirePerm("admins:manage");
      requireReason(reason);
      if (!/^[^@\s]+@cuypay\.com$/i.test(body.email)) throw new ApiError(400, "VALIDATION_ERROR", "Solo se permiten correos @cuypay.com.");
      if (s.admins.some((a) => a.email.toLowerCase() === body.email.toLowerCase()))
        throw new ApiError(409, "CONFLICT", "Ya existe un usuario con ese correo.");
      const a: Admin = { id: id("adm"), email: body.email.toLowerCase(), name: body.name, role: body.role, status: "active", lastLoginAt: null, createdAt: new Date().toISOString() };
      s.admins.push(a);
      audit("admin.create", "admin", a.id, reason, null, { email: a.email, role: a.role });
      const secret = Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)]).join("");
      return {
        admin: clone(a),
        temporaryPassword: `Cuy-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}`,
        otpauthUrl: `otpauth://totp/CuyPay%20Admin:${encodeURIComponent(a.email)}?secret=${secret}&issuer=CuyPay`,
      };
    },
    async updateUser(uid, body, reason) {
      await latency();
      const me = requirePerm("admins:manage");
      requireReason(reason);
      const a = s.admins.find((x) => x.id === uid);
      if (!a) throw new ApiError(404, "NOT_FOUND", "Usuario no encontrado.");
      if (a.id === me.id && (body.status === "disabled" || (body.role && body.role !== "owner")))
        throw new ApiError(409, "CONFLICT", "No puedes quitarte tu propio acceso de owner.");
      const before = { role: a.role, status: a.status };
      if (body.role) a.role = body.role;
      if (body.status) a.status = body.status;
      audit("admin.update", "admin", uid, reason, before, { role: a.role, status: a.status });
      return clone(a);
    },
    async resetCredentials(uid, reason) {
      await latency();
      requirePerm("admins:manage");
      requireReason(reason);
      const a = s.admins.find((x) => x.id === uid);
      if (!a) throw new ApiError(404, "NOT_FOUND", "Usuario no encontrado.");
      audit("admin.reset_credentials", "admin", uid, reason);
      const secret = Array.from({ length: 32 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(Math.random() * 32)]).join("");
      return {
        admin: clone(a),
        temporaryPassword: `Cuy-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}`,
        otpauthUrl: `otpauth://totp/CuyPay%20Admin:${encodeURIComponent(a.email)}?secret=${secret}&issuer=CuyPay`,
      };
    },

    async savingsConfig() {
      await latency();
      return clone(mockSavingsCfg);
    },
    async updateSavingsConfig(rates, contractTerms, reason = "Ajuste de tasas") {
      await latency();
      const a = requirePerm("treasury:write");
      mockSavingsCfg = {
        ...mockSavingsCfg,
        rates,
        contractTerms: contractTerms ?? mockSavingsCfg.contractTerms,
        updatedAt: new Date().toISOString(),
        updatedBy: a.email,
      };
      audit("savings.config_update", "savings_config", "COP", reason);
      return clone(mockSavingsCfg);
    },
    async savingsPool() {
      await latency();
      requirePerm("treasury:read");
      return buildSavingsPoolSummary();
    },
    async withdrawSavingsPool(amountMinor, reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      const amt = BigInt(amountMinor);
      if (amt <= 0n || amt > mockSavingsVaultMinor) {
        throw new ApiError(422, "INSUFFICIENT_FUNDS", "Saldo insuficiente en el Bolsillo Recaudo de Ahorros.");
      }
      mockSavingsVaultMinor -= amt;
      audit("savings.pool_withdraw", "savings_vault", "COP", reason, null, { amountMinor });
      return buildSavingsPoolSummary();
    },
    async depositSavingsPool(amountMinor, reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      const amt = BigInt(amountMinor);
      mockSavingsVaultMinor += amt;
      audit("savings.pool_deposit", "savings_vault", "COP", reason, null, { amountMinor });
      return buildSavingsPoolSummary();
    },
    async savingsBlocks() {
      await latency();
      requirePerm("treasury:read");
      return { items: clone(mockSavingsBlocks) };
    },
    async fundSavingsBlockEscrow(bid, reason) {
      await latency();
      const a = requirePerm("treasury:write");
      requireReason(reason);
      const b = mockSavingsBlocks.find((x) => x.id === bid);
      if (!b) throw new ApiError(404, "NOT_FOUND", "Bolsillo no encontrado.");
      if (b.escrowStatus === "funded_locked") throw new ApiError(409, "CONFLICT", "Ya está bloqueado.");
      const payout = BigInt(b.totalPayoutMinor);
      const fromVault = mockSavingsVaultMinor >= payout ? payout : mockSavingsVaultMinor;
      mockSavingsVaultMinor -= fromVault;
      mockSavingsEscrowMinor += payout;
      b.escrowStatus = "funded_locked";
      b.escrowFundedAt = new Date().toISOString();
      b.escrowFundedBy = a.email;
      audit("savings.escrow_lock", "savings_block", bid, reason);
      return {
        blockId: b.id,
        escrowStatus: "funded_locked",
        totalPayoutMinor: b.totalPayoutMinor,
        pool: buildSavingsPoolSummary(),
      };
    },
    async fundAllMaturing72h(reason) {
      await latency();
      const a = requirePerm("treasury:write");
      requireReason(reason);
      let fundedCount = 0;
      let totalLocked = 0n;
      for (const b of mockSavingsBlocks) {
        if ((b.status === "active" || b.status === "maturing_soon") && (b.hoursRemaining ?? 999) <= 72 && b.escrowStatus !== "funded_locked") {
          const payout = BigInt(b.totalPayoutMinor);
          const fromVault = mockSavingsVaultMinor >= payout ? payout : mockSavingsVaultMinor;
          mockSavingsVaultMinor -= fromVault;
          mockSavingsEscrowMinor += payout;
          b.escrowStatus = "funded_locked";
          b.escrowFundedAt = new Date().toISOString();
          b.escrowFundedBy = a.email;
          fundedCount++;
          totalLocked += payout;
        }
      }
      audit("savings.escrow_lock_batch", "savings_escrow", "COP", reason);
      return { fundedCount, totalLockedMinor: totalLocked.toString(), pool: buildSavingsPoolSummary() };
    },
    async treasurySavingsAlerts() {
      await latency();
      const maturing = mockSavingsBlocks
        .filter((b) => (b.status === "active" || b.status === "maturing_soon") && (b.hoursRemaining ?? 999) <= 72)
        .map((b) => ({ ...b, hoursRemaining: b.hoursRemaining ?? 48 }));
      const total = maturing.reduce((acc, b) => acc + BigInt(b.totalPayoutMinor), 0n);
      const unfunded = maturing.filter((b) => b.escrowStatus !== "funded_locked");
      const unfundedMinor = unfunded.reduce((acc, b) => acc + BigInt(b.totalPayoutMinor), 0n);
      return {
        windowHours: 72,
        totalMaturing72hMinor: total.toString(),
        unfundedMaturing72hMinor: unfundedMinor.toString(),
        totalMaturingCount: maturing.length,
        unfundedMaturingCount: unfunded.length,
        maturingBlocks: clone(maturing),
      };
    },
    async processSavingsMaturities() {
      await latency();
      requirePerm("treasury:write");
      return { completedCount: 0 };
    },

    async loansConfig() {
      await latency();
      requirePerm("treasury:read");
      return clone(mockLoanCfg);
    },
    async updateLoansConfig(patch, reason) {
      await latency();
      const a = requirePerm("treasury:write");
      requireReason(reason);
      mockLoanCfg = {
        ...mockLoanCfg,
        ...patch,
        updatedAt: new Date().toISOString(),
        updatedBy: a.email,
      };
      audit("loans.config_update", "loan_config", "COP", reason);
      return clone(mockLoanCfg);
    },
    async loansPool() {
      await latency();
      requirePerm("treasury:read");
      return buildLoanPoolSummary();
    },
    async fundLoansPool(amountMinor, reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      mockLoanPoolMinor += BigInt(amountMinor);
      audit("loans.pool_fund", "loan_pool", "COP", reason, null, { amountMinor });
      return buildLoanPoolSummary();
    },
    async withdrawLoansPool(amountMinor, reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      const amt = BigInt(amountMinor);
      if (amt > mockLoanPoolMinor) throw new ApiError(422, "INSUFFICIENT_FUNDS", "Saldo insuficiente en el Bolsillo de Préstamos.");
      mockLoanPoolMinor -= amt;
      audit("loans.pool_withdraw", "loan_pool", "COP", reason, null, { amountMinor });
      return buildLoanPoolSummary();
    },
    async loans(status) {
      await latency();
      requirePerm("treasury:read");
      const items = status ? mockLoans.filter((l) => l.status === status) : mockLoans;
      return { items: clone(items) };
    },
    async loanPromissoryNote(lid) {
      await latency();
      requirePerm("treasury:read");
      const loan = mockLoans.find((l) => l.id === lid);
      if (!loan) throw new ApiError(404, "NOT_FOUND", "Crédito no encontrado.");
      const noteStatus =
        loan.status === "approved_active" || loan.status === "overdue"
          ? "active_enforceable"
          : loan.status === "paid"
            ? "cancelled_paid"
            : loan.status === "rejected"
              ? "voided_rejected"
              : "signed_custody";
      const md = `# PAGARÉ ELECTRÓNICO A LA ORDEN Nº ${loan.promissoryNoteNumber}\n\n**ACREEDOR:** XATECH SERVICES S.A.S. — NIT 901.799.579\n**DEUDOR(A):** ${loan.debtorFullName} (${loan.debtorDocumentType} ${loan.debtorDocumentNumber})\n\nPromesa incondicional de pago por capital de $${(Number(loan.principalMinor) / 100).toLocaleString("es-CO")} COP a ${loan.termDays} días (${loan.interestRateEa}% E.A.) + Carta de Instrucciones (Art. 622 C.Co.) + Autorización Habeas Data (Ley 1266 de 2008).`;
      const note: PromissoryNoteDto = {
        id: loan.promissoryNoteId,
        number: loan.promissoryNoteNumber,
        loanId: loan.id,
        userId: loan.userId,
        status: noteStatus,
        integrityVerified: true,
        principalMinor: loan.principalMinor,
        interestMinor: loan.interestMinor,
        totalDueMinor: loan.totalDueMinor,
        paidMinor: loan.paidMinor,
        remainingMinor: loan.remainingMinor,
        termDays: loan.termDays,
        interestRateEa: loan.interestRateEa,
        nominalMonthlyPercent: loan.nominalMonthlyPercent,
        moratoryRateEa: loan.moratoryRateEa,
        currency: "COP",
        creditorLegalName: "XATECH SERVICES S.A.S.",
        creditorNit: "901.799.579",
        creditorDomicile: "Bogotá D.C., República de Colombia",
        debtorFullName: loan.debtorFullName,
        debtorDocumentType: loan.debtorDocumentType,
        debtorDocumentNumber: loan.debtorDocumentNumber,
        debtorEmail: loan.debtorEmail,
        debtorPhone: loan.debtorPhone,
        debtorCity: loan.debtorCity,
        sumsubApplicantId: "sumsub_demo_verified",
        documentMarkdown: md,
        documentSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        signature: {
          method: "ECDSA_P256_SHA256_SECURE_ENCLAVE",
          deviceId: "dev_demo_iphone16",
          deviceName: "iPhone 16 Pro",
          devicePublicKey: "BElDemoSecureEnclavePublicKeyX963Base64==",
          ecdsaSignatureBase64: "MEYCIQDemoSignatureRComponentAiBDemoSignatureSComponent==",
          canonicalSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          nonce: "demo-nonce-pagare-001",
          timestampSec: Math.floor(Date.parse(loan.requestedAt) / 1000),
          signedAt: loan.requestedAt,
          signerIp: "181.51.120.44",
          signerUserAgent: "CuyPay-iOS/2.0",
          acceptedPagare: true,
          acceptedInstructionLetter: true,
          acceptedCreditBureauAuth: true,
        },
        disbursedAt: loan.disbursedAt,
        dueAt: loan.dueAt,
        cancelledAt: loan.paidAt ?? loan.rejectedAt,
        createdAt: loan.requestedAt,
        printableHtml: `<!DOCTYPE html><html lang="es-CO"><head><meta charset="utf-8"/><title>Pagaré ${loan.promissoryNoteNumber}</title></head><body style="font-family:Georgia,serif;max-width:760px;margin:24px auto;line-height:1.6"><h1>PAGARÉ ELECTRÓNICO A LA ORDEN Nº ${loan.promissoryNoteNumber}</h1><p><strong>Acreedor:</strong> XATECH SERVICES S.A.S. — NIT 901.799.579</p><p><strong>Deudor:</strong> ${loan.debtorFullName} (${loan.debtorDocumentType} ${loan.debtorDocumentNumber})</p><p><strong>Capital:</strong> $${(Number(loan.principalMinor) / 100).toLocaleString("es-CO")} COP · <strong>Plazo:</strong> ${loan.termDays} días · <strong>Tasa:</strong> ${loan.interestRateEa}% E.A.</p><p><strong>Total exigible:</strong> $${(Number(loan.totalDueMinor) / 100).toLocaleString("es-CO")} COP</p><hr/><p>Firmado electrónicamente con Secure Enclave ECDSA P-256 conforme a la Ley 527 de 1999, Decreto 2364 de 2012 y Arts. 621, 622 y 709 del Código de Comercio.</p></body></html>`,
      };
      return note;
    },
    async approveLoan(lid, reason) {
      await latency();
      const a = requirePerm("treasury:write");
      requireReason(reason);
      const loan = mockLoans.find((l) => l.id === lid);
      if (!loan) throw new ApiError(404, "NOT_FOUND", "Solicitud no encontrada.");
      if (loan.status !== "pending_review") throw new ApiError(409, "CONFLICT", "La solicitud ya fue procesada.");
      const principal = BigInt(loan.principalMinor);
      if (mockLoanPoolMinor < principal) {
        throw new ApiError(422, "INSUFFICIENT_FUNDS", "Saldo insuficiente en el Bolsillo de Préstamos. Fondea primero el bolsillo.");
      }
      mockLoanPoolMinor -= principal;
      const now = new Date();
      const due = new Date(now.getTime() + loan.termDays * DAY);
      loan.status = "approved_active";
      loan.approvedAt = now.toISOString();
      loan.approvedBy = a.email;
      loan.disbursedAt = now.toISOString();
      loan.dueAt = due.toISOString();
      loan.daysRemaining = loan.termDays;
      audit("loans.approve", "loan", lid, reason);
      return { loan: clone(loan), pool: buildLoanPoolSummary() };
    },
    async rejectLoan(lid, reason) {
      await latency();
      requirePerm("treasury:write");
      requireReason(reason);
      const loan = mockLoans.find((l) => l.id === lid);
      if (!loan) throw new ApiError(404, "NOT_FOUND", "Solicitud no encontrada.");
      if (loan.status !== "pending_review") throw new ApiError(409, "CONFLICT", "La solicitud ya fue procesada.");
      loan.status = "rejected";
      loan.rejectedAt = new Date().toISOString();
      loan.rejectedReason = reason;
      loan.remainingMinor = "0";
      audit("loans.reject", "loan", lid, reason);
      return { loan: clone(loan), pool: buildLoanPoolSummary() };
    },

    subscribe(onEvent, onStatus?: (st: StreamStatus) => void) {
      listeners.add(onEvent);
      onStatus?.("connecting");
      const t = setTimeout(() => onStatus?.("open"), 400);
      startSim();
      return () => {
        clearTimeout(t);
        listeners.delete(onEvent);
        if (listeners.size === 0) stopSim();
        onStatus?.("closed");
      };
    },
  };
  return api;
}
