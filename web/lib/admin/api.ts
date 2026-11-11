import type {
  Admin,
  AdminBeneficiary,
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminTransaction,
  AdminTransactionDetail,
  AlertResolution,
  AuditEntry,
  AuditQuery,
  ComplianceAlert,
  CreatedAdmin,
  CustomerQuery,
  Dashboard,
  FxConfig,
  FxConfigInput,
  LimitItem,
  LimitsConfig,
  LoanConfigDto,
  LoanDto,
  LoanPoolSummaryDto,
  LoanRateTierDto,
  LoanStatus,
  Page,
  PromissoryNoteDto,
  ProviderStatus,
  ReverseResult,
  Role,
  SavingsBlockDto,
  SavingsConfigDto,
  SavingsPoolSummaryDto,
  SavingsTreasuryAlertsDto,
  StreamEvent,
  Tier,
  TransactionQuery,
  TreasurySnapshot,
  UnfreezeResult,
} from "./types";
import { ApiError } from "./types";

export type StreamStatus = "connecting" | "open" | "error" | "closed";

export interface AdminApi {
  readonly mode: "mock" | "live";
  login(email: string, password: string): Promise<{ mfaToken: string; mfaRequired: true; expiresIn: number }>;
  mfa(mfaToken: string, code: string): Promise<{ accessToken: string; expiresIn: number; admin: Admin }>;
  logout(): Promise<void>;
  me(): Promise<Admin>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;

  dashboard(): Promise<Dashboard>;

  customers(q: CustomerQuery): Promise<Page<AdminCustomerSummary>>;
  customer(id: string): Promise<AdminCustomerDetail>;
  freeze(id: string, reason: string): Promise<void>;
  unfreeze(id: string, reason: string): Promise<UnfreezeResult>;
  setTier(id: string, tier: Tier, reason: string): Promise<void>;
  setLimitOverrides(id: string, items: LimitItem[], reason: string): Promise<void>;
  revokeDevice(id: string, deviceId: string, reason: string): Promise<void>;
  addNote(id: string, text: string): Promise<void>;

  transactions(q: TransactionQuery): Promise<Page<AdminTransaction>>;
  transaction(id: string): Promise<AdminTransactionDetail>;
  reverse(id: string, reason: string): Promise<ReverseResult>;
  exportCsv(q: { from?: string; to?: string; type?: string }): Promise<Blob>;

  beneficiaries(status: string): Promise<Page<AdminBeneficiary>>;
  decideBeneficiary(id: string, decision: "approve" | "reject", reason: string): Promise<void>;
  alerts(q: { status?: string; type?: string }): Promise<Page<ComplianceAlert>>;
  resolveAlert(
    id: string,
    body: { resolution: AlertResolution; note: string; reportToUiaf: boolean },
  ): Promise<void>;

  treasury(): Promise<TreasurySnapshot>;
  reconcile(reason: string): Promise<void>;
  fx(): Promise<FxConfig>;
  updateFx(input: FxConfigInput, reason: string): Promise<FxConfig>;

  limitsConfig(): Promise<LimitsConfig>;
  updateLimitsConfig(tier: Tier, items: LimitItem[], reason: string): Promise<void>;

  providers(): Promise<{ items: ProviderStatus[] }>;
  checkProvider(id: string): Promise<ProviderStatus>;

  auditLog(q: AuditQuery): Promise<Page<AuditEntry>>;

  users(): Promise<{ items: Admin[] }>;
  createUser(body: { email: string; name: string; role: Role }, reason: string): Promise<CreatedAdmin>;
  updateUser(id: string, body: { role?: Role; status?: "active" | "disabled" }, reason: string): Promise<Admin>;
  resetCredentials(id: string, reason: string): Promise<CreatedAdmin>;

  savingsConfig(): Promise<SavingsConfigDto>;
  updateSavingsConfig(
    rates: Array<{ termDays: number; ratePercent: number; enabled: boolean }>,
    contractTerms?: string,
    reason?: string,
  ): Promise<SavingsConfigDto>;
  savingsPool(): Promise<SavingsPoolSummaryDto>;
  withdrawSavingsPool(amountMinor: string, reason: string): Promise<SavingsPoolSummaryDto>;
  depositSavingsPool(amountMinor: string, reason: string): Promise<SavingsPoolSummaryDto>;
  savingsBlocks(): Promise<{ items: SavingsBlockDto[] }>;
  fundSavingsBlockEscrow(
    id: string,
    reason: string,
  ): Promise<{ blockId: string; escrowStatus: string; totalPayoutMinor: string; pool: SavingsPoolSummaryDto }>;
  fundAllMaturing72h(
    reason: string,
  ): Promise<{ fundedCount: number; totalLockedMinor: string; pool: SavingsPoolSummaryDto }>;
  treasurySavingsAlerts(): Promise<SavingsTreasuryAlertsDto>;
  processSavingsMaturities(): Promise<{ completedCount: number }>;

  loansConfig(): Promise<LoanConfigDto>;
  updateLoansConfig(
    patch: {
      enabled?: boolean;
      rates?: LoanRateTierDto[];
      usuryCeilingEaPercent?: number;
      moratoryRateEaPercent?: number;
      minAmountMinor?: string;
      maxAmountMinor?: string;
    },
    reason: string,
  ): Promise<LoanConfigDto>;
  loansPool(): Promise<LoanPoolSummaryDto>;
  fundLoansPool(amountMinor: string, reason: string): Promise<LoanPoolSummaryDto>;
  withdrawLoansPool(amountMinor: string, reason: string): Promise<LoanPoolSummaryDto>;
  loans(status?: LoanStatus): Promise<{ items: LoanDto[] }>;
  loanPromissoryNote(id: string): Promise<PromissoryNoteDto>;
  approveLoan(id: string, reason: string): Promise<{ loan: LoanDto; pool: LoanPoolSummaryDto }>;
  rejectLoan(id: string, reason: string): Promise<{ loan: LoanDto; pool: LoanPoolSummaryDto }>;

  /** Suscripción al stream SSE. Devuelve la función para cancelar. */
  subscribe(onEvent: (e: StreamEvent) => void, onStatus?: (s: StreamStatus) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Token de sesión: vive en memoria (y en sessionStorage, gestionado por session.tsx).
let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function getAccessToken() {
  return accessToken;
}
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}
export function notifyUnauthorized() {
  onUnauthorized?.();
}

function qs(params: object): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------------------------
// Cliente HTTP real contra api.cuypay.com/v1/admin
export function createHttpApi(baseUrl: string): AdminApi {
  const base = baseUrl.replace(/\/+$/, "");

  async function raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "include", // cookie de Cloudflare Access
      });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "No se pudo conectar con el servidor.");
    }
    if (!res.ok) {
      let code = "HTTP_" + res.status;
      let message = `Error ${res.status}`;
      let details: unknown;
      try {
        const j = await res.json();
        code = j?.error?.code ?? code;
        message = j?.error?.message ?? message;
        details = j?.error?.details;
      } catch {
        /* sin cuerpo JSON */
      }
      if (res.status === 401 && path !== "/admin/auth/login" && path !== "/admin/auth/mfa") notifyUnauthorized();
      throw new ApiError(res.status, code, message, details);
    }
    return res;
  }

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await raw(method, path, body);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    mode: "live",
    login: (email, password) => req("POST", "/admin/auth/login", { email, password }),
    mfa: (mfaToken, code) => req("POST", "/admin/auth/mfa", { mfaToken, code }),
    logout: () => req("POST", "/admin/auth/logout"),
    me: () => req("GET", "/admin/me"),
    changePassword: (currentPassword, newPassword) =>
      req("POST", "/admin/me/password", { currentPassword, newPassword }),
    dashboard: () => req("GET", "/admin/dashboard"),
    customers: (q) => req("GET", `/admin/customers${qs(q)}`),
    customer: (id) => req("GET", `/admin/customers/${encodeURIComponent(id)}`),
    freeze: (id, reason) => req("POST", `/admin/customers/${encodeURIComponent(id)}/freeze`, { reason }),
    unfreeze: (id, reason) => req("POST", `/admin/customers/${encodeURIComponent(id)}/unfreeze`, { reason }),
    setTier: (id, tier, reason) => req("POST", `/admin/customers/${encodeURIComponent(id)}/tier`, { tier, reason }),
    setLimitOverrides: (id, items, reason) =>
      req("PUT", `/admin/customers/${encodeURIComponent(id)}/limit-overrides`, { items, reason }),
    revokeDevice: (id, deviceId, reason) =>
      req("POST", `/admin/customers/${encodeURIComponent(id)}/devices/${encodeURIComponent(deviceId)}/revoke`, { reason }),
    addNote: (id, text) => req("POST", `/admin/customers/${encodeURIComponent(id)}/notes`, { text }),
    transactions: (q) => req("GET", `/admin/transactions${qs(q)}`),
    transaction: (id) => req("GET", `/admin/transactions/${encodeURIComponent(id)}`),
    reverse: (id, reason) => req("POST", `/admin/transactions/${encodeURIComponent(id)}/reverse`, { reason }),
    exportCsv: async (q) => (await raw("GET", `/admin/transactions/export.csv${qs(q)}`)).blob(),
    beneficiaries: (status) => req("GET", `/admin/compliance/beneficiaries${qs({ status })}`),
    decideBeneficiary: (id, decision, reason) =>
      req("POST", `/admin/compliance/beneficiaries/${encodeURIComponent(id)}/decision`, { decision, reason }),
    alerts: (q) => req("GET", `/admin/compliance/alerts${qs(q)}`),
    resolveAlert: (id, body) =>
      req("POST", `/admin/compliance/alerts/${encodeURIComponent(id)}/resolve`, body),
    treasury: () => req("GET", "/admin/treasury"),
    reconcile: (reason) => req("POST", "/admin/treasury/reconcile", { reason }),
    fx: () => req("GET", "/admin/treasury/fx"),
    updateFx: (input, reason) => req("PUT", "/admin/treasury/fx", { ...input, reason }),
    limitsConfig: () => req("GET", "/admin/limits-config"),
    updateLimitsConfig: (tier, items, reason) => req("PUT", `/admin/limits-config/${tier}`, { items, reason }),
    providers: () => req("GET", "/admin/providers"),
    checkProvider: (id) => req("POST", `/admin/providers/${encodeURIComponent(id)}/check`),
    auditLog: (q) => req("GET", `/admin/audit-log${qs(q)}`),
    users: () => req("GET", "/admin/users"),
    createUser: (body, reason) => req("POST", "/admin/users", { ...body, reason }),
    updateUser: (id, body, reason) => req("PATCH", `/admin/users/${encodeURIComponent(id)}`, { ...body, reason }),
    resetCredentials: (id, reason) =>
      req("POST", `/admin/users/${encodeURIComponent(id)}/reset-credentials`, { reason }),

    savingsConfig: () => req("GET", "/admin/savings/config"),
    updateSavingsConfig: (rates, contractTerms, reason = "Ajuste de tasas de ahorro") =>
      req("PUT", "/admin/savings/config", { rates, contractTerms, reason }),
    savingsPool: () => req("GET", "/admin/savings/pool"),
    withdrawSavingsPool: (amountMinor, reason) =>
      req("POST", "/admin/savings/pool/withdraw", { amountMinor, reason }),
    depositSavingsPool: (amountMinor, reason) =>
      req("POST", "/admin/savings/pool/deposit", { amountMinor, reason }),
    savingsBlocks: () => req("GET", "/admin/savings/blocks"),
    fundSavingsBlockEscrow: (id, reason) =>
      req("POST", `/admin/savings/blocks/${encodeURIComponent(id)}/fund-escrow`, { reason }),
    fundAllMaturing72h: (reason) => req("POST", "/admin/savings/fund-maturing-72h", { reason }),
    treasurySavingsAlerts: () => req("GET", "/admin/savings/treasury-alerts"),
    processSavingsMaturities: () => req("POST", "/admin/savings/process-maturities"),

    loansConfig: () => req("GET", "/admin/loans/config"),
    updateLoansConfig: (patch, reason) => req("PUT", "/admin/loans/config", { ...patch, reason }),
    loansPool: () => req("GET", "/admin/loans/pool"),
    fundLoansPool: (amountMinor, reason) => req("POST", "/admin/loans/pool/fund", { amountMinor, reason }),
    withdrawLoansPool: (amountMinor, reason) => req("POST", "/admin/loans/pool/withdraw", { amountMinor, reason }),
    loans: (status) => req("GET", `/admin/loans${qs({ status })}`),
    loanPromissoryNote: (id) => req("GET", `/admin/loans/${encodeURIComponent(id)}/promissory-note`),
    approveLoan: (id, reason) => req("POST", `/admin/loans/${encodeURIComponent(id)}/approve`, { reason }),
    rejectLoan: (id, reason) => req("POST", `/admin/loans/${encodeURIComponent(id)}/reject`, { reason }),

    subscribe(onEvent, onStatus) {
      let es: EventSource | null = null;
      let closed = false;
      let retry: ReturnType<typeof setTimeout> | null = null;
      let attempt = 0;
      const types: StreamEvent["type"][] = [
        "transaction.created",
        "transaction.updated",
        "customer.created",
        "customer.updated",
        "kyc.updated",
        "compliance.alert",
        "beneficiary.review_required",
        "provider.status",
        "treasury.updated",
        "ping",
      ];

      const connect = async () => {
        if (closed) return;
        onStatus?.("connecting");
        try {
          const { token } = await req<{ token: string; expiresIn: number }>("POST", "/admin/stream/token");
          if (closed) return;
          es = new EventSource(`${base}/admin/stream${qs({ token })}`);
          es.onopen = () => {
            attempt = 0;
            onStatus?.("open");
          };
          for (const t of types) {
            es.addEventListener(t, (ev) => {
              try {
                onEvent({ type: t, data: JSON.parse((ev as MessageEvent).data) } as StreamEvent);
              } catch {
                /* evento malformado */
              }
            });
          }
          es.onerror = () => {
            es?.close();
            es = null;
            onStatus?.("error");
            schedule();
          };
        } catch {
          onStatus?.("error");
          schedule();
        }
      };
      const schedule = () => {
        if (closed) return;
        attempt += 1;
        retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt));
      };
      void connect();
      return () => {
        closed = true;
        if (retry) clearTimeout(retry);
        es?.close();
        onStatus?.("closed");
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
const DEFAULT_API_BASE = "https://api.cuypay.com/v1";
let instance: AdminApi | null = null;

export function getAdminApiBase(): string {
  if (typeof window !== "undefined") {
    const custom = localStorage.getItem("cuypay_admin_api_base");
    if (custom) return custom;
  }
  return process.env.NEXT_PUBLIC_ADMIN_API_BASE || DEFAULT_API_BASE;
}

export function isMockMode(): boolean {
  if (typeof window !== "undefined") {
    const override = localStorage.getItem("cuypay_admin_mock");
    if (override === "1") return true;
    if (override === "0") return false;
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("demo") === "1") return true;
    if (urlParams.get("demo") === "0") return false;
  }
  if (process.env.NEXT_PUBLIC_ADMIN_MOCK === "1") return true;
  return false;
}

export function setMockMode(enabled: boolean): void {
  if (typeof window !== "undefined") {
    localStorage.setItem("cuypay_admin_mock", enabled ? "1" : "0");
    instance = null;
    window.location.reload();
  }
}

export async function getApi(): Promise<AdminApi> {
  if (instance) return instance;
  if (isMockMode()) {
    const { createMockApi } = await import("./mock");
    instance = createMockApi();
  } else {
    instance = createHttpApi(getAdminApiBase());
  }
  return instance;
}

export function resetApiInstance(): void {
  instance = null;
}
