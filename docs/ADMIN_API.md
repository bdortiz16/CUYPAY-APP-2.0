# CuyPay Admin API v1 (Admin Portal ↔ Backend)

Back-office de CuyPay en `https://www.cuypay.com/admin-portal`, consumiendo `https://api.cuypay.com/v1/admin/*`.
Mismas convenciones que [API_CONTRACT.md](API_CONTRACT.md): JSON camelCase, montos en `*Minor` (enteros, 2 decimales),
fechas ISO-8601 UTC, errores `{ error: { code, message, details } }`, paginación `?limit=&cursor=` → `{ items, nextCursor }`.

## Seguridad (defensa en capas)
1. **Cloudflare Access (Zero Trust)** protege `/admin-portal*` y `api.cuypay.com/v1/admin*`: solo correos `@cuypay.com` autorizados.
   El backend puede validar el header `Cf-Access-Jwt-Assertion` (opcional, `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN`).
2. **Usuarios admin propios** (separados de los clientes), contraseña (argon2id/scrypt) + **TOTP obligatorio**.
3. **RBAC** por rol. **Toda acción que modifica algo exige `reason`** y queda en el **audit log** (inmutable).
4. Sesión admin: access token JWT 30 min (`aud=cuypay-admin`), sin refresh silencioso; cierre de sesión por inactividad en el portal.

### Roles y permisos
| Permiso | owner | compliance | treasury | support | viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| Ver dashboard, clientes, transacciones | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ver PII completa (documento, teléfono sin enmascarar) | ✅ | ✅ | – | ✅ | – |
| Congelar / descongelar cliente | ✅ | ✅ | – | – | – |
| Cambiar nivel (tier) / overrides de límites de un cliente | ✅ | ✅ | – | – | – |
| Decidir beneficiarios en revisión AML / resolver alertas | ✅ | ✅ | – | – | – |
| Tesorería: ver | ✅ | ✅ | ✅ | – | ✅ |
| Tesorería: configurar FX (spread, comisiones), conciliar, reversar | ✅ | – | ✅ | – | – |
| Configurar límites por nivel | ✅ | ✅ | – | – | – |
| Administrar usuarios admin | ✅ | – | – | – | – |
| Ver audit log | ✅ | ✅ | – | – | – |

PII se devuelve **enmascarada** si el rol no tiene permiso (`"documentNumber": "****4321"`).

## Auth
| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/admin/auth/login` | `{ email, password }` | `{ mfaToken, mfaRequired: true }` |
| POST | `/admin/auth/mfa` | `{ mfaToken, code }` | `{ accessToken, expiresIn: 1800, admin: Admin }` |
| POST | `/admin/auth/logout` | – | `204` |
| GET | `/admin/me` | – | `Admin` |

`Admin = { id, email, name, role: "owner|compliance|treasury|support|viewer", status: "active|disabled", lastLoginAt, createdAt }`

## Tiempo real
- `POST /admin/stream/token` → `{ token, expiresIn: 60 }` (token de un solo uso; `EventSource` no envía headers).
- `GET /admin/stream?token=...` → **Server-Sent Events**. Cada evento: `event: <tipo>` + `data: <JSON>`.

| Evento | data |
|---|---|
| `transaction.created` / `transaction.updated` | `AdminTransaction` |
| `customer.created` | `AdminCustomerSummary` |
| `kyc.updated` | `{ customerId, status, tier }` |
| `compliance.alert` | `ComplianceAlert` |
| `beneficiary.review_required` | `AdminBeneficiary` |
| `provider.status` | `ProviderStatus` |
| `treasury.updated` | `TreasurySnapshot` |
| `ping` | `{ at }` (cada 25 s) |

## Dashboard
`GET /admin/dashboard` →
```json
{
  "generatedAt": "...",
  "customers": { "total": 1520, "newToday": 34, "kycApproved": 1210, "kycPending": 41, "frozen": 3 },
  "today": {
    "deposits":    { "count": 210, "volumeMinor": 48500000000, "currency": "COP" },
    "transfers":   { "count": 95,  "volumeMinor": 21000000000, "currency": "COP" },
    "conversions": { "count": 60,  "fromVolumeMinor": 30000000000, "toVolumeMinor": 3891000, "fromCurrency": "COP", "toCurrency": "BRL" },
    "revenueMinor": 310000000, "revenueCurrency": "COP"
  },
  "series": [ { "date": "2026-11-01", "depositsMinor": 0, "transfersMinor": 0, "conversionsMinor": 0, "newCustomers": 0 } ],
  "queues": { "amlReview": 4, "complianceAlerts": 2, "failedTransactions": 1 },
  "providers": [ ProviderStatus ],
  "treasury": TreasurySnapshot
}
```
`series` = últimos 30 días.

## Clientes
| Método | Ruta | Notas |
|---|---|---|
| GET | `/admin/customers?query=&kycStatus=&tier=&status=active\|frozen&limit=&cursor=` | `query` busca nombre, correo, teléfono, documento, alias Bre-B |
| GET | `/admin/customers/{id}` | `AdminCustomerDetail` |
| POST | `/admin/customers/{id}/freeze` | `{ reason }` → bloquea login, envíos y conversiones (recibir sigue entrando y queda retenido) |
| POST | `/admin/customers/{id}/unfreeze` | `{ reason }` |
| POST | `/admin/customers/{id}/tier` | `{ tier: "basic\|full", reason }` |
| PUT | `/admin/customers/{id}/limit-overrides` | `{ items: [{ operation, period, limitMinor }], reason }` (lista vacía = quitar overrides) |
| POST | `/admin/customers/{id}/devices/{deviceId}/revoke` | `{ reason }` |

```jsonc
// AdminCustomerSummary
{ "id": "usr_...", "firstName": "Ana", "lastName": "Gómez", "email": "...", "phone": "+57300***4567",
  "country": "CO", "kycStatus": "approved", "tier": "full", "status": "active|frozen", "riskLevel": "low|medium|high",
  "balances": { "COP": 125000000, "BRL": 182300 }, "createdAt": "...", "lastActiveAt": "..." }
// AdminCustomerDetail = Summary + :
{ "documentType": "CC", "documentNumber": "****4321",
  "kyc": { "provider": "sumsub", "applicantId": "...", "status": "...", "reviewAnswer": "GREEN|RED|null", "rejectLabels": [], "updatedAt": "..." },
  "wallets": [ { "currency": "COP", "balanceMinor": 0, "availableMinor": 0, "heldMinor": 0 } ],
  "brebKey": { "alias": "@cuypayana123", "status": "active", "createdAt": "..." } ,
  "limits": LimitsSnapshot, "limitOverrides": [ { "operation": "...", "period": "...", "limitMinor": 0 } ],
  "devices": [ { "id": "...", "name": "iPhone de Ana", "createdAt": "...", "lastUsedAt": "...", "revoked": false } ],
  "beneficiaries": [ AdminBeneficiary ],
  "recentTransactions": [ AdminTransaction ],
  "notes": [ { "id": "...", "author": "...", "text": "...", "createdAt": "..." } ] }
```
`POST /admin/customers/{id}/notes` `{ text }` → nota interna.

## Transacciones
| Método | Ruta | Notas |
|---|---|---|
| GET | `/admin/transactions?type=&status=&currency=&customerId=&from=&to=&minAmountMinor=&limit=&cursor=` | |
| GET | `/admin/transactions/{id}` | incluye `ledgerEntries`, `timeline`, `providerRefs` |
| POST | `/admin/transactions/{id}/reverse` | `{ reason }` — solo `completed` o `pending` atascadas; crea asientos de reverso |
| GET | `/admin/transactions/export.csv?from=&to=&type=` | CSV para contabilidad / reportes |

```jsonc
// AdminTransaction
{ "id": "txn_...", "customerId": "usr_...", "customerName": "Ana Gómez", "type": "deposit|transfer|conversion",
  "direction": "in|out", "currency": "COP", "amountMinor": 0, "feeMinor": 0, "status": "pending|completed|failed|reversed",
  "counterparty": "Juan Pérez · 3001234567", "conversion": { ... } , "flagged": false, "createdAt": "...", "updatedAt": "..." }
// detalle extra
{ "ledgerEntries": [ { "account": "customer:usr_..:COP", "debitMinor": 0, "creditMinor": 0, "currency": "COP" } ],
  "timeline": [ { "at": "...", "event": "created|held|provider_submitted|provider_confirmed|completed|failed|reversed", "detail": "..." } ],
  "providerRefs": { "coinsendaWithdrawId": "...", "coinsendaDepositId": "...", "brlExecutionId": "..." } }
```

## Cumplimiento (SARLAFT)
| Método | Ruta | Notas |
|---|---|---|
| GET | `/admin/compliance/beneficiaries?status=pending_review` | cola de revisión AML |
| POST | `/admin/compliance/beneficiaries/{id}/decision` | `{ decision: "approve\|reject", reason }` (approve registra la cuenta destino en Coinsenda) |
| GET | `/admin/compliance/alerts?status=open\|resolved&type=` | |
| POST | `/admin/compliance/alerts/{id}/resolve` | `{ resolution: "false_positive\|customer_contacted\|frozen\|reported", note, reportToUiaf: boolean }` |

```jsonc
// AdminBeneficiary
{ "id": "ben_...", "customerId": "usr_...", "customerName": "...", "alias": "...", "holderName": "...", "bankName": "...",
  "status": "active|pending_review|rejected", "aml": { "provider": "sartblock", "result": "clear|hit|review", "referenceId": "...", "matches": [ { "list": "OFAC|ONU|PEP|...", "name": "...", "score": 0.92 } ], "checkedAt": "..." }, "createdAt": "..." }
// ComplianceAlert
{ "id": "alr_...", "type": "deposit_over_limit|aml_hit|velocity|large_transaction|multiple_devices|structuring",
  "severity": "low|medium|high", "customerId": "...", "customerName": "...", "transactionId": "...|null",
  "description": "...", "status": "open|resolved", "resolution": null, "createdAt": "...", "resolvedAt": null, "resolvedBy": null }
```
Reglas iniciales de alertas: depósito que excede `deposit_in`, transacción individual ≥ COP 10.000.000, > 5 envíos en 1 hora,
varios depósitos justo bajo el umbral en 24 h (*structuring*), AML `hit` / `review`, más de 3 dispositivos nuevos en 30 días.

## Tesorería
`GET /admin/treasury` → `TreasurySnapshot`
```jsonc
{ "asOf": "...",
  "accounts": [
    { "id": "coinsenda_cop", "name": "Coinsenda · COP (Bre-B)", "provider": "coinsenda", "currency": "COP",
      "providerBalanceMinor": 0, "lastSyncedAt": "...", "status": "ok|stale|error" },
    { "id": "brl_partner", "name": "Socio BRL / PIX", "provider": "brl_partner", "currency": "BRL", "providerBalanceMinor": 0, "lastSyncedAt": "...", "status": "ok" }
  ],
  "liabilities": { "COP": 0, "BRL": 0 },            // suma de saldos de clientes (ledger)
  "coverage": [ { "currency": "COP", "providerMinor": 0, "liabilitiesMinor": 0, "differenceMinor": 0, "ratio": 1.0 } ],
  "revenue": { "todayMinor": 0, "monthMinor": 0, "currency": "COP" },
  "reconciliation": { "status": "ok|breaks|running|never", "lastRunAt": "...", "breaks": [ { "kind": "missing_in_ledger|missing_in_provider|amount_mismatch", "reference": "...", "amountMinor": 0, "currency": "COP" } ] } }
```
| Método | Ruta | Notas |
|---|---|---|
| POST | `/admin/treasury/reconcile` | `{ reason }` → corre conciliación ledger vs proveedores |
| GET | `/admin/treasury/fx` | `{ pair: "COP/BRL", midRate, customerRate, spreadBps, feeBps, minFeeMinor, minAmountMinor, maxAmountMinor, enabled, updatedAt, updatedBy }` |
| PUT | `/admin/treasury/fx` | mismos campos editables + `reason` |

## Configuración de límites
`GET /admin/limits-config` → `{ tiers: [ { tier: "basic|full", items: [ { operation, period, limitMinor } ] } ] }`
`PUT /admin/limits-config/{tier}` → `{ items: [...], reason }`

## Conexiones (proveedores)
`GET /admin/providers` → `{ items: [ProviderStatus] }`
```json
{ "id": "coinsenda|sumsub|sartblock|brl_partner|otp", "name": "Coinsenda (Bre-B)", "status": "operational|degraded|down",
  "mode": "mock|live", "latencyMs": 180, "successRate24h": 0.998, "lastCheckAt": "...", "lastError": null }
```
`POST /admin/providers/{id}/check` → fuerza un health check.

## Audit log
`GET /admin/audit-log?actorId=&action=&targetType=&targetId=&limit=&cursor=` →
`{ items: [ { id, at, actor: { id, email, role }, action: "customer.freeze|...", targetType, targetId, reason, before, after, ip, userAgent } ], nextCursor }`

## Usuarios admin (solo owner)
`GET /admin/users` · `POST /admin/users { email, name, role }` (devuelve contraseña temporal + `otpauthUrl` para enrolar TOTP una sola vez) ·
`PATCH /admin/users/{id} { role?, status? , reason }`.
