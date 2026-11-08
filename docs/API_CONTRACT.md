# CuyPay API Contract v1 (iOS ↔ CuyPay Backend)

Fuente única de verdad entre la app iOS (`ios/`) y el backend (`backend/`).
La app **nunca** habla directo con Coinsenda, Sumsub ni el proveedor AML: todo pasa por el backend
(los secretos y la clave RSA de Coinsenda viven solo en el servidor).

- Base URL: `https://api.cuypay.com/v1` (dev: `http://localhost:8080/v1`)
- JSON, `camelCase`. Fechas ISO-8601 UTC.
- **Montos**: enteros en unidades menores (`amountMinor`, centavos). COP y BRL usan 2 decimales.
  `150000.00 COP` → `15000000`. Nunca `Double` para dinero (en Swift usar `Int64`/`Decimal`).
- Monedas: `"COP" | "BRL"`.
- Auth: `Authorization: Bearer <accessToken>` (JWT, 15 min). Refresh con `refreshToken` (30 días, rotativo).
- Errores: HTTP 4xx/5xx con cuerpo `{ "error": { "code": "LIMIT_EXCEEDED", "message": "...", "details": {} } }`.

## Códigos de error
`VALIDATION_ERROR`, `UNAUTHORIZED`, `INVALID_SIGNATURE`, `SIGNATURE_REQUIRED`, `REPLAYED_NONCE`,
`OTP_INVALID`, `KYC_REQUIRED`, `KYC_PENDING`, `BREB_KEY_EXISTS`, `BREB_ALIAS_NOT_FOUND`, `BREB_ALIAS_TAKEN`,
`AML_REJECTED`, `AML_REVIEW`, `BENEFICIARY_NOT_ACTIVE`, `LIMIT_EXCEEDED`, `INSUFFICIENT_FUNDS`,
`QUOTE_EXPIRED`, `IDEMPOTENCY_CONFLICT`, `PROVIDER_ERROR`, `NOT_FOUND`.

---

## 1. Seguridad: Face ID + Secure Enclave

1. Al registrarse, la app crea un par de claves **P-256 en el Secure Enclave** con control de acceso
   `[.privateKeyUsage, .biometryCurrentSet]` → cada uso de la clave privada exige **Face ID**,
   y si el usuario cambia sus biometrías la clave queda inválida (re-enrolamiento).
2. La clave pública se envía como **X9.63 sin comprimir (65 bytes) en base64** (`devicePublicKey`).
3. **Login** = desafío firmado (no hay contraseña):
   `POST /auth/challenge` → `nonce` → la app firma los bytes UTF-8 de `nonce` (ECDSA-SHA256, firma **DER** en base64) → `POST /auth/login`.
4. **Operaciones sensibles** (marcadas 🔐) requieren además firmar la petición con la misma clave (nuevo Face ID por operación):

   Headers:
   ```
   X-CuyPay-Device: <deviceId>
   X-CuyPay-Timestamp: <unix segundos>
   X-CuyPay-Nonce: <uuid v4>
   X-CuyPay-Signature: <base64 DER ECDSA-SHA256>
   ```
   Cadena canónica firmada (separador `\n`, sin salto final):
   ```
   <MÉTODO EN MAYÚSCULAS>
   <path con /v1, sin query>      ej: /v1/transfers
   <sha256 hex minúsculas del body crudo; body vacío = sha256("")>
   <timestamp>
   <nonce>
   ```
   El backend rechaza timestamps con desfase > 120 s y nonces repetidos (`REPLAYED_NONCE`).

## 2. Auth y onboarding

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/auth/otp/request` | `{ phone }` (E.164, ej `+573001234567`) | `{ otpId, expiresAt }` (dev: código `123456`) |
| POST | `/auth/register` | `{ otpId, otpCode, phone, email, firstName, lastName, country: "CO", deviceName, devicePublicKey }` | `AuthSession` |
| POST | `/auth/challenge` | `{ deviceId }` | `{ challengeId, nonce, expiresAt }` |
| POST | `/auth/login` | `{ challengeId, deviceId, signature }` | `AuthSession` |
| POST | `/auth/refresh` | `{ refreshToken }` | `AuthSession` |
| POST | `/auth/logout` | – | `204` |

```jsonc
// AuthSession
{ "accessToken": "jwt", "refreshToken": "opaque", "expiresIn": 900, "deviceId": "dev_...", "user": User }
// User
{ "id": "usr_...", "firstName": "Ana", "lastName": "Gómez", "email": "...", "phone": "+57...",
  "country": "CO", "kycStatus": "not_started|pending|approved|rejected|retry", "tier": "basic|full",
  "createdAt": "..." }
```

`GET /me` → `User`.

## 3. KYC (Sumsub)

| Método | Ruta | Respuesta |
|---|---|---|
| POST | `/kyc/sumsub/token` | `{ token, levelName, expiresAt }` → la app lanza el **IdensicMobileSDK** con este token |
| GET | `/kyc/status` | `{ status, tier, reviewAnswer?, rejectLabels?: [] }` |
| POST | `/webhooks/sumsub` | (server-to-server, firma HMAC `X-Payload-Digest`) |

La app pide un token nuevo cuando el SDK lo solicita (`tokenExpirationHandler`).
Sin `kycStatus = approved` no se puede crear llave Bre-B, enviar ni convertir (`KYC_REQUIRED`).

## 4. Bolsillos (wallets)

`GET /wallets` →
```json
{ "items": [
  { "currency": "COP", "balanceMinor": 125000000, "availableMinor": 120000000, "heldMinor": 5000000 },
  { "currency": "BRL", "balanceMinor": 182300,    "availableMinor": 182300,    "heldMinor": 0 }
] }
```

## 5. Llave Bre-B propia (recibir COP)

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/breb/key` | – | `BrebKey` o `404 NOT_FOUND` |
| POST 🔐 | `/breb/key` | `{ preferredAlias? }` (si no, se genera con prefijo `@cuypay...`) | `201 BrebKey` |
| PUT 🔐 | `/breb/key` | `{ preferredAlias? }` (reemplazo atómico de alias en Coinsenda) | `200 BrebKey` |
| DELETE 🔐 | `/breb/key` | – | `204` |

```json
{ "id": "brk_...", "alias": "@cuypayana123", "status": "active|blocked|pending", "holderName": "Ana Gómez", "createdAt": "..." }
```
Los depósitos que llegan a la llave se acreditan al bolsillo **COP** (ver transacciones `deposit`).

## 6. Beneficiarios (inscripción → resolución Bre-B → AML)

Flujo:
1. `POST /beneficiaries/resolve` `{ alias }` → el backend consulta el directorio Bre-B (Coinsenda
   `resolveBrebAliasPublic`) y devuelve el **titular** de la llave.
   ```json
   { "resolutionId": "res_...", "alias": "3001234567", "holderName": "JUAN P***Z", "holderNameFull": "Juan Pérez", "documentType": "CC", "documentMasked": "****4321", "bankName": "Bancolombia", "expiresAt": "..." }
   ```
   `404 BREB_ALIAS_NOT_FOUND` si la llave no existe.
2. El usuario confirma el nombre → `POST 🔐 /beneficiaries` `{ resolutionId, nickname? }`.
   El backend corre la verificación **AML (Sartblock)** sobre el titular y registra la cuenta destino en Coinsenda.
   Respuesta `201 Beneficiary`. Si AML da coincidencia: `status = "rejected"` (y error `AML_REJECTED`) o
   `status = "pending_review"` para revisión manual del oficial de cumplimiento.
3. `GET /beneficiaries` → `{ items: [Beneficiary] }`; `DELETE 🔐 /beneficiaries/{id}` → `204`.

```json
{ "id": "ben_...", "alias": "3001234567", "holderName": "Juan Pérez", "nickname": "Juan", "bankName": "Bancolombia",
  "status": "active|pending_review|rejected",
  "aml": { "provider": "sartblock", "result": "clear|hit|review", "referenceId": "...", "checkedAt": "..." },
  "createdAt": "..." }
```

## 7. Envíos Bre-B (salida COP)

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/transfers/preview` | `{ beneficiaryId, amountMinor }` | `{ amountMinor, feeMinor, totalMinor, currency: "COP", limits: LimitsSnapshot }` |
| POST 🔐 | `/transfers` | `{ beneficiaryId, amountMinor, description?, idempotencyKey }` | `201 Transaction` |

Solo beneficiarios `active`. El backend valida límites y saldo, retiene fondos, crea el retiro en Coinsenda
(`addNewWithdrawPublic`) y lo confirma (`addUpdateWithdraw state=confirmed`).

## 8. Conversión COP → BRL

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/fx/rate?from=COP&to=BRL` | – | `{ from, to, rate, inverseRate, updatedAt, history: [{ date, rate }] }` (30 días, para la gráfica) |
| POST | `/fx/quotes` | `{ fromCurrency: "COP", toCurrency: "BRL", amountMinor }` | `Quote` |
| POST 🔐 | `/fx/conversions` | `{ quoteId, idempotencyKey }` | `201 Transaction` |

```json
// Quote (vigencia 30 s)
{ "quoteId": "qt_...", "fromCurrency": "COP", "toCurrency": "BRL", "fromAmountMinor": 100000000,
  "feeMinor": 1000000, "toAmountMinor": 128729, "rate": 0.0013003, "expiresAt": "..." }
```
`rate` = BRL por 1 COP **después** del spread. `toAmountMinor = floor((fromAmountMinor - feeMinor) * rate)`.
`QUOTE_EXPIRED` si se vence. (Fase 1: solo COP→BRL; BRL→COP queda preparado en el modelo.)

## 9. Transacciones

`GET /transactions?currency=COP&limit=30&cursor=...` → `{ items: [Transaction], nextCursor }`

```json
{ "id": "txn_...", "type": "deposit|transfer|conversion", "direction": "in|out",
  "currency": "COP", "amountMinor": 5000000, "feeMinor": 0,
  "status": "pending|completed|failed|reversed",
  "title": "Juan Pérez", "subtitle": "Bre-B · @cuypayana123",
  "conversion": { "fromCurrency": "COP", "fromAmountMinor": 100000000, "toCurrency": "BRL", "toAmountMinor": 128729, "rate": 0.0013003 },
  "createdAt": "..." }
```
Una conversión aparece **una sola vez** con `currency` = moneda de origen y `conversion` lleno.

## 10. Límites (diarios, mensuales, anuales)

`GET /limits` → `LimitsSnapshot`
```json
{ "tier": "full", "currency": "COP", "items": [
  { "operation": "transfer_out", "period": "daily",   "limitMinor": 300000000,  "usedMinor": 5000000 },
  { "operation": "transfer_out", "period": "monthly", "limitMinor": 2000000000, "usedMinor": 5000000 },
  { "operation": "transfer_out", "period": "annual",  "limitMinor": 15000000000,"usedMinor": 5000000 },
  { "operation": "conversion",   "period": "daily",   "limitMinor": 200000000,  "usedMinor": 0 },
  { "operation": "deposit_in",   "period": "monthly", "limitMinor": 2000000000, "usedMinor": 0 }
] }
```
Todos los límites se expresan en COP equivalente. Periodos en zona `America/Bogota` (día calendario, mes calendario, año calendario).
Excederlos → `422 LIMIT_EXCEEDED` con `details: { operation, period, limitMinor, usedMinor, remainingMinor }`.

## 11. Dispositivos

`GET /devices` → `{ items: [{ id, name, createdAt, lastUsedAt, current }] }` · `DELETE 🔐 /devices/{id}` → `204`.

## 12. Tarjetas CuyPay (Virtuales respaldadas por Coinsenda)

CuyPay permite la emisión y gestión de tarjetas virtuales internacionales conectadas al saldo COP de la cuenta.

> [!IMPORTANT]
> **Seguridad PCI-DSS**: El backend de CuyPay **nunca** almacena ni procesa el PAN completo ni el CVV de las tarjetas. Los datos sensibles se muestran exclusivamente al usuario final mediante un iframe o SafariViewController protegido generado por Coinsenda (`look-url`).

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| GET | `/cards` | – | `{ items: [Card] }` |
| GET | `/cards/:id` | – | `Card` |
| POST 🔐 | `/cards/virtual` | `{ label? }` | `201 Card` (máximo 3 tarjetas activas por usuario, requiere KYC aprobado) |
| GET | `/cards/:id/look-url` | – | `{ lookUrl: string, expiresAt: string }` |
| PUT 🔐 | `/cards/:id/status` | `{ workingState: "active" \| "inactive" }` | `Card` (congelar / reactivar) |
| PUT | `/cards/:id/label` | `{ label: string }` | `Card` (renombrar tarjeta) |
| POST 🔐 | `/cards/:id/apple-pay/tokenize` | `{ certificates: string[], nonce: string, nonceSignature: string }` | `{ encryptedPassData: string, activationData: string, ephemeralPublicKey: string }` |
| DELETE 🔐 | `/cards/:id` | – | `Card` (estado `canceled`, irreversible) |

```jsonc
// Card
{
  "id": "crd_...",
  "type": "virtual",
  "status": "active", // "active" | "inactive" | "canceled"
  "last4": "4321",
  "maskedPan": "•••• 4321",
  "expiryMonth": "12",
  "expiryYear": "28",
  "cardholderName": "ANA GOMEZ",
  "label": "Compras Online",
  "currency": "COP",
  "limits": {
    "dailyPurchaseMinor": 500000000,
    "monthlyPurchaseMinor": 2000000000
  },
  "createdAt": "..."
}
```

## 13. Seguridad, Bloqueo por Inactividad y Sesión

- **Auto-lock configurable**: La app iOS implementa bloqueo automático configurable por el usuario (`inmediato`, `1 min`, `5 min`, `15 min`) usando `@AppStorage("cuypay_auto_lock_seconds")`.
- **Cortina de privacidad**: Al pasar a segundo plano (`scenePhase == .background`), la app superpone una cortina de privacidad borrosa para proteger saldos y tarjetas en la vista multitarea de iOS.
- **Biometría continua**: Al reanudar tras expirar el tiempo de inactividad, se exige autenticación biométrica (Face ID / Touch ID / PIN) para remover la cortina y reactivar la sesión.
- **Configuración del backend**:

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/me/security` | `{ idleTimeoutSeconds: 300, maxSessionHours: 24, biometricsRequired: true }` |

## 14. Códigos HTTP por error (implementados en el backend)

| HTTP | Códigos |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHORIZED`, `INVALID_SIGNATURE`, `SIGNATURE_REQUIRED`, `REPLAYED_NONCE`, `OTP_INVALID` |
| 403 | `KYC_REQUIRED`, `KYC_PENDING` |
| 404 | `NOT_FOUND`, `BREB_ALIAS_NOT_FOUND` |
| 409 | `BREB_KEY_EXISTS`, `BREB_ALIAS_TAKEN`, `IDEMPOTENCY_CONFLICT` |
| 422 | `AML_REJECTED` (`details.beneficiary`), `BENEFICIARY_NOT_ACTIVE`, `LIMIT_EXCEEDED`, `INSUFFICIENT_FUNDS`, `QUOTE_EXPIRED` |
| 429 | `RATE_LIMITED` |
| 500 / 502 | `INTERNAL_ERROR` / `PROVIDER_ERROR` |

Notas: un resultado AML `review` responde `201` con `status: "pending_review"` (no se emite `AML_REVIEW`).
Los límites se calculan sobre `amountMinor` (sin comisión). Un envío puede quedar `pending` hasta que Coinsenda lo liquide.

