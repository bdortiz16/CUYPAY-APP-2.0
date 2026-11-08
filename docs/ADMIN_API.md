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
| GET | `/admin/me` | – | `Admin & { permissions: string[] }` |
| POST | `/admin/me/password` | `{ currentPassword, newPassword }` (mín. 12) | `204` |

`Admin = { id, email, name, role: "owner|compliance|treasury|support|viewer", status: "active|disabled", lastLoginAt, createdAt }`

## Tiempo real
- `POST /admin/stream/token` → `{ token, expiresIn: 60 }` (token de un solo uso; `EventSource` no envía headers).
- `GET /admin/stream?token=...` → **Server-Sent Events**. Cada evento: `event: <tipo>` + `data: <JSON>`.

| Evento | data |
|---|---|
| `transaction.created` / `transaction.updated` | `AdminTransaction` |
| `customer.created` / `customer.updated` | `AdminCustomerSummary` |
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
`POST /admin/customers/{id}/notes` `{ text }` → `201` nota interna (el propio `text` cuenta como `reason` en el audit log).
`documentType` / `documentNumber` son `null` mientras el KYC no los persista en el perfil del cliente.

## Transacciones
| Método | Ruta | Notas |
|---|---|---|
| GET | `/admin/transactions?type=&status=&currency=&customerId=&from=&to=&minAmountMinor=&flagged=true\|false&limit=&cursor=` | `from`/`to` filtran `createdAt` (`to` exclusivo) |
| GET | `/admin/transactions/{id}` | incluye `ledgerEntries`, `timeline`, `providerRefs` |
| POST | `/admin/transactions/{id}/reverse` | `{ reason }` — solo `completed` o `pending` atascadas (> 15 min); crea asientos de reverso → `{ transaction, journalId, warnings }`. `409 CONFLICT` si ya está reversada/fallida; `422 INSUFFICIENT_FUNDS` si el cliente ya no tiene el saldo |
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
| POST | `/admin/compliance/alerts/{id}/resolve` | `{ resolution: "false_positive\|customer_contacted\|frozen\|reported", note, reportToUiaf: boolean }` — `note` (o `reason`) obligatorio; `frozen` congela al cliente |

```jsonc
// AdminBeneficiary
{ "id": "ben_...", "customerId": "usr_...", "customerName": "...", "alias": "...", "holderName": "...", "bankName": "...",
  "status": "active|pending_review|rejected", "aml": { "provider": "sartblock", "result": "clear|hit|review", "referenceId": "...", "matches": [ { "list": "OFAC|ONU|PEP|...", "name": "...", "score": 0.92 } ], "checkedAt": "..." }, "createdAt": "..." }
// ComplianceAlert
{ "id": "alr_...", "type": "deposit_over_limit|aml_hit|velocity|large_transaction|multiple_devices|structuring",
  "severity": "low|medium|high", "customerId": "...", "customerName": "...", "transactionId": "...|null",
  "description": "...", "uiafSuggested": false, "status": "open|resolved", "resolution": null, "resolutionNote": null, "reportToUiaf": false,
  "createdAt": "...", "resolvedAt": null, "resolvedBy": null }
```
Reglas iniciales de alertas: depósito que excede `deposit_in`, transacción individual ≥ COP 10.000.000, > 5 envíos en 1 hora,
varios depósitos justo bajo el umbral en 24 h (*structuring*), AML `hit` / `review`, más de 3 dispositivos nuevos en 30 días.

## Tesorería
`GET /admin/treasury` → `TreasurySnapshot`
```jsonc
{ "asOf": "...",
  "accounts": [
    { "id": "coinsenda_cop", "name": "Coinsenda · COP (Bre-B)", "provider": "coinsenda", "currency": "COP",
      "providerBalanceMinor": 0, "ledgerBalanceMinor": 0, "differenceMinor": 0, "lastSyncedAt": "...", "status": "ok|stale|error", "error": null },
      // providerBalanceMinor/differenceMinor = null (y status "error") si el proveedor no responde o no expone saldo
    { "id": "brl_partner", "name": "Socio BRL / PIX", "provider": "brl_partner", "currency": "BRL", "providerBalanceMinor": 0, "lastSyncedAt": "...", "status": "ok" }
  ],
  "liabilities": { "COP": 0, "BRL": 0 },            // suma de saldos de clientes (ledger)
  "coverage": [ { "currency": "COP", "providerMinor": 0, "liabilitiesMinor": 0, "differenceMinor": 0, "ratio": 1.0 } ],
  "revenue": { "todayMinor": 0, "monthMinor": 0, "currency": "COP" },
  "reconciliation": { "status": "ok|breaks|running|never", "lastRunAt": "...", "breaks": [ { "kind": "missing_in_ledger|missing_in_provider|amount_mismatch|status_mismatch", "reference": "...", "amountMinor": 0, "currency": "COP", "detail": "..." } ] } }
```
| Método | Ruta | Notas |
|---|---|---|
| POST | `/admin/treasury/reconcile` | `{ reason }` → corre conciliación ledger vs proveedores |
| GET | `/admin/treasury/fx` | `{ pair: "COP/BRL", midRate, customerRate, spreadBps, feeBps, minFeeMinor, minAmountMinor, maxAmountMinor, enabled, updatedAt, updatedBy }` |
| PUT | `/admin/treasury/fx` | mismos campos editables (parciales) + `reason`. Con `enabled: false` las cotizaciones responden `503 PROVIDER_ERROR` `details.reason = "fx_disabled"` |

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
`GET /admin/users` · `POST /admin/users { email, name, role, reason }` (devuelve contraseña temporal + `otpauthUrl` para enrolar TOTP una sola vez) ·
`PATCH /admin/users/{id} { role?, status?, name?, reason }` (deshabilitar revoca sesiones; `409` si se quitaría el último owner activo) ·
`POST /admin/users/{id}/reset-credentials { reason }` → nueva contraseña temporal + nuevo TOTP (`otpauthUrl`), revoca sesiones.

## Notas de implementación (backend v1)
- **Errores nuevos:** `403 FORBIDDEN` (rol sin permiso o Cloudflare Access inválido; `details.permission`), `403 ACCOUNT_FROZEN`
  (cliente congelado: login/refresh, envíos, cotizaciones y conversiones en la API de clientes), `409 CONFLICT`.
- **`reason` obligatorio** (3–1000 caracteres) en toda mutación, incluida `POST /admin/users`; sin él → `400 VALIDATION_ERROR`.
  Excepciones: login/mfa/logout y `POST /admin/me/password` (se auditan igual).
- **Permisos** (claves devueltas en `/admin/me.permissions`): `dashboard:read` (todos), `pii:read`, `customers:freeze`,
  `customers:limits`, `customers:support` (notas y revocar dispositivos: owner/compliance/support), `compliance:read`,
  `compliance:decide`, `treasury:read`, `treasury:write` (FX, conciliar, reversar), `limits:write`, `providers:check`
  (owner/compliance/treasury), `admins:manage`, `audit:read`.
- **Login:** `mfaToken` válido 5 min y 5 intentos; un código TOTP no se acepta dos veces; 5 contraseñas erradas bloquean la cuenta 15 min.
- **Congelamiento:** los depósitos entrantes se acreditan pero quedan retenidos (`heldMinor`) hasta `unfreeze`
  (respuesta `{ status, releasedHeldMinor }`).
- **Alertas:** umbral de transacción grande configurable (`ALERT_LARGE_TX_MINOR`, default COP 10.000.000); *structuring* = ≥ 3 depósitos
  en 24 h entre el 90 % y el 100 % del umbral; velocidad = > 5 envíos en 1 h. `uiafSuggested` marca las que sugieren ROS a la UIAF.
- **SSE:** `ping` cada 25 s; el stream se cierra al expirar/revocarse la sesión admin (el portal pide un token nuevo y reconecta).
- **Legacy:** `POST /admin/beneficiaries/{id}/review` con `X-Admin-Key` sigue disponible si `ADMIN_API_KEY` está definido.
