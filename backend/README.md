# CuyPay Backend (API v1)

API de CuyPay: recepción de COP vía llave Bre-B propia (Coinsenda), bolsillos COP/BRL, conversión COP→BRL, envíos Bre-B a beneficiarios con resolución de titular + screening AML (Sartblock), KYC con Sumsub, límites diarios/mensuales/anuales y seguridad por dispositivo (Secure Enclave + Face ID).

El contrato vinculante es [`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

**Stack:** Node 24 · TypeScript estricto (ESM) · Fastify 5 · zod · jose (JWT) · `node:crypto` (ECDSA P-256) · pino · vitest.

---

## 1. Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env        # todo funciona en modo mock sin credenciales
npm run dev                 # tsx watch → http://127.0.0.1:8080/v1
npm test                    # vitest (82 pruebas)
npm run typecheck           # tsc --noEmit (src + tests)
npm run build && npm start  # compila a dist/ y ejecuta node dist/src/index.js
curl localhost:8080/health
```

> Para probar desde un iPhone físico o desde otra máquina usa `HOST=0.0.0.0`.
> El simulador de iOS puede usar `http://127.0.0.1:8080/v1`.

### Usuario demo (seed)

Con `SEED_DEMO=true` (por defecto en desarrollo), al arrancar se crea:

| Dato | Valor |
|---|---|
| Usuario | Ana (KYC aprobado, tier `full`) |
| Teléfono / OTP | `+573001234567` / `123456` |
| Bolsillo COP | 1.250.000,00 (disponible 1.200.000,00; 50.000,00 retenido en un envío pendiente) |
| Bolsillo BRL | 1.802,21 |
| Llave Bre-B | `@cuypayana123` |
| Beneficiario | Juan Pérez (`3001234567`) |

La app iOS se registra con ese teléfono + OTP `123456` (`/auth/otp/request` → `/auth/register`); el backend enlaza el nuevo dispositivo al usuario existente.

**Directorio mock de Coinsenda** (para `/beneficiaries/resolve`):

| Llave | Resultado |
|---|---|
| `3001234567` | Juan Pérez (Bancolombia) → AML `clear` |
| `3109876543` | Camila Rojas → AML `clear` |
| `@mariarevision` | AML `review` → beneficiario `pending_review` |
| `@pedrobloqueado` | AML `hit` → `AML_REJECTED` |
| cualquier otra | `BREB_ALIAS_NOT_FOUND` |

### Portal admin (`/v1/admin/*`)

Contrato: [`../docs/ADMIN_API.md`](../docs/ADMIN_API.md). Usuarios admin propios (separados de los clientes), contraseña scrypt + **TOTP obligatorio** (RFC 6238, SHA1, 30 s, ±1 paso, anti-replay), JWT admin de 30 min con secreto y `aud` propios (`cuypay-admin`), sesiones revocables, RBAC (`owner`, `compliance`, `treasury`, `support`, `viewer`), **audit log** de toda mutación (`reason` obligatorio → 400 si falta) y PII enmascarada para roles sin permiso.

Al arrancar, si no existe ningún admin se crea un **owner**. Fuera de producción usa estas credenciales (sobrescribibles con `ADMIN_SEED_*`) y las imprime en el log:

| Dato | Valor (solo desarrollo) |
|---|---|
| Correo | `admin@cuypay.com` |
| Contraseña | `CuyPay-Admin-Dev-2026!` |
| Secreto TOTP (base32) | `CUYPAYDEVADMINTOTPSECRET234567AB` (agrégalo a Google Authenticator / 1Password, o `otpauth://` del log) |

En producción el owner inicial solo se crea si `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD` y `ADMIN_SEED_TOTP_SECRET` están definidos, y nunca se loguean.

Piezas principales:
- `src/http/routes/admin.ts` (rutas + RBAC por permiso), `src/http/cf-access.ts` (Cloudflare Access opcional: `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`).
- `src/services/admin/*`: `auth` (login → mfa → JWT, bloqueo tras 5 fallos), `rbac`, `audit`, `customers` (congelar, tier, overrides de límites, revocar dispositivos, notas), `transactions` (filtros, detalle con asientos, reverso con asientos compensatorios, CSV), `compliance` (reglas de alertas: transacción grande, velocidad, structuring, AML, dispositivos; sugerencia UIAF), `treasury` (saldos proveedor vs ledger, cobertura, conciliación, FX en runtime), `providers` (health checks), `dashboard`, `stream` (SSE con token de un solo uso).
- `src/services/events.ts`: bus de eventos interno (los servicios existentes publican `transaction.*`, `customer.*`, `kyc.updated`, `beneficiary.*`, ...) que alimenta las alertas y el SSE.
- `src/services/runtime-config.ts`: FX y límites editables en runtime (tabla `settings`), usados por `FxService` y `LimitsService`; congelamiento de clientes (`ACCOUNT_FROZEN` 403 en login/refresh, envíos y cotizaciones; los depósitos se acreditan retenidos y se liberan al descongelar).
- CORS: `ADMIN_ORIGINS` (p. ej. `https://www.cuypay.com`) solo para `/v1/admin/*`; `CORS_ORIGINS` para todo.
- Tablas nuevas en `db/schema.sql`: `admin_users`, `admin_sessions`, `admin_audit_log` (append-only), `compliance_alerts`, `customer_notes`, `customer_controls`, `reconciliation_runs`, `settings`.

### Rutas fuera del contrato

- **Solo modo mock y no producción** (`ENABLE_DEV_ROUTES`):
  - `POST /v1/dev/kyc/approve` (JWT): aprueba el KYC del usuario actual.
  - `POST /v1/dev/deposits/simulate` `{ amountMinor, payerName? }` (JWT): simula un depósito Bre-B entrante, que pasa por el mismo flujo de ingesta del poller.
- **Solo si `ADMIN_API_KEY` está definido (legacy, compatibilidad):**
  - `POST /v1/admin/beneficiaries/:id/review` `{ decision: "approve" | "reject" }` con el header `X-Admin-Key`. Es la resolución manual de cumplimiento para beneficiarios `pending_review`. El portal admin usa `POST /v1/admin/compliance/beneficiaries/:id/decision`.
- `GET /health` y `GET /v1/health`.

---

## 2. Variables de entorno

Todas están documentadas en [`.env.example`](.env.example) y se validan con zod en [`src/config.ts`](src/config.ts). Si alguna es inválida, el proceso no arranca.

| Grupo | Variables |
|---|---|
| Servidor | `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL`, `CORS_ORIGINS` (vacío = CORS desactivado), `ADMIN_API_KEY` |
| Modo | `PROVIDERS_MODE=mock\|live`, `BRL_PROVIDER_MODE`, `SEED_DEMO`, `ENABLE_DEV_ROUTES` |
| Auth | `JWT_SECRET` (obligatorio en producción, ≥32 caracteres), `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`, `SIGNATURE_MAX_SKEW_SECONDS` (120), `CHALLENGE_TTL_SECONDS`, `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS`, `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS` |
| Coinsenda | `COINSENDA_DOMAIN` (`coinsenda.com` en producción / `bitsenda.com` en staging), `COINSENDA_EMAIL`, `COINSENDA_PRIVATE_KEY_PEM`, `COINSENDA_BREB_DEPOSIT_ACCOUNT_ID`, `COINSENDA_COP_ACCOUNT_ID`, `COINSENDA_BREB_WITHDRAW_PROVIDER_ID`, `DEPOSIT_POLL_INTERVAL_MS` |
| Sumsub | `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`, `SUMSUB_WEBHOOK_SECRET`, `SUMSUB_LEVEL_NAME`, `SUMSUB_BASE_URL` (`https://api.sumsub.com`), `SUMSUB_TOKEN_TTL_SECONDS` |
| Sartblock (AML) | `SARTBLOCK_BASE_URL`, `SARTBLOCK_API_KEY` |
| FX / tarifas | `FX_SPREAD_BPS` (150), `CONVERSION_FEE_BPS` (100), `CONVERSION_FEE_MIN_MINOR`, `QUOTE_TTL_SECONDS` (30), `TRANSFER_FEE_MINOR` (0) |
| Límites | `LIMITS_CONFIG_JSON`: sobrescribe los límites por tier y tipo (ver `DEFAULT_LIMITS` en `config.ts`) |
| Portal admin | `ADMIN_JWT_SECRET` (si falta se deriva de `JWT_SECRET`), `ADMIN_JWT_AUDIENCE` (`cuypay-admin`), `ADMIN_TOKEN_TTL_SECONDS` (1800), `ADMIN_ORIGINS`, `ADMIN_TOTP_ISSUER`, `ADMIN_SEED_EMAIL`, `ADMIN_SEED_PASSWORD`, `ADMIN_SEED_TOTP_SECRET`, `ADMIN_SEED_NAME`, `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` (opcional), `ALERT_LARGE_TX_MINOR` (1.000.000.000), `PROVIDER_HEALTH_INTERVAL_MS` (60000) |

---

## 3. Arquitectura (hexagonal)

```
backend/
├── db/schema.sql              # esquema PostgreSQL de producción
├── src/
│   ├── index.ts               # arranque: config → container → seed → app → poller
│   ├── config.ts              # env (zod), límites por defecto
│   ├── container.ts           # inyección de dependencias (mock/live) + logger con redacción
│   ├── ports/                 # interfaces: CoinsendaGateway, KycProvider, AmlProvider,
│   │                          #   BrlLiquidityProvider, OtpSender
│   ├── adapters/
│   │   ├── coinsenda/{mock,live}.ts
│   │   ├── sumsub/{provider,webhook}.ts
│   │   ├── sartblock/provider.ts
│   │   ├── brl/provider.ts
│   │   └── otp/sender.ts
│   ├── repositories/          # interfaces + implementación en memoria (fase 1)
│   ├── domain/                # tipos + presenters (forma JSON del contrato)
│   ├── services/              # auth, signature, kyc, breb, beneficiaries, transfers,
│   │                          #   fx, ledger, limits, idempotency, deposits, feed
│   ├── http/                  # Fastify app + rutas (auth, account, kyc, money, dev)
│   ├── jobs/poller.ts         # ingesta de depósitos + sincronización de retiros
│   ├── scripts/seed.ts        # datos demo
│   └── lib/                   # errores, reloj (FakeClock), crypto, dinero, zona horaria
└── test/                      # vitest
```

Cada puerto tiene un adaptador **Mock**, que se usa por defecto en desarrollo y pruebas, y uno **Live**. Se elige con `PROVIDERS_MODE`.

---

## 4. Integraciones

### Coinsenda (Bre-B): `adapters/coinsenda/live.ts`
- **SDK:** `@coinsenda/sdk` fijado en **1.9.0**.
- **Autenticación por llave pública RSA** (igual que en el README del SDK):
  1. Se firma `{ email, iat }` con `jsonwebtoken` RS256, con expiración de 5 minutos, usando `COINSENDA_PRIVATE_KEY_PEM` (cargada con `node-rsa`).
  2. Se llama a `client.auth.passport.authPubkey({ data: { signed_token } })`.
  3. Se guardan el JWT y el refresh token con `setJwt` / `setRefreshToken`.
  4. Ante un 401, el adaptador vuelve a autenticarse y reintenta una vez.
- **Métodos:**
  - `createBrebKey`: llama a `depositProvider.createDepositProviderByAccountIdPublic` sobre `COINSENDA_BREB_DEPOSIT_ACCOUNT_ID`. Crea la llave Bre-B propia del usuario.
  - `resolveBrebAlias`: obtiene el titular de la llave. El error `withdrawaccount_23` (alias no encontrado) se traduce a `null`, y la API responde `BREB_ALIAS_NOT_FOUND`.
  - `addWithdrawAccount`: registra al beneficiario como cuenta de retiro. Solo se hace si el resultado AML es `clear`.
  - `createWithdraw` + `confirmWithdraw`: `addUpdateWithdraw` con estado `confirmed`.
  - `listDeposits` / `getWithdraw`: los usa el poller.
- Los campos de payload que no confirma la documentación están marcados con `// TODO(coinsenda):`.

### Sumsub (KYC): `adapters/sumsub/`
- **Firma de cada request:**
  - Headers `X-App-Token`, `X-App-Access-Ts` y `X-App-Access-Sig`.
  - `X-App-Access-Sig = HMAC-SHA256(secret, ts + METHOD + pathWithQuery + body)` en hexadecimal.
- **Creación del applicant:** `POST /resources/applicants?levelName=…` con `externalUserId = userId`.
- **Token del SDK:** `POST /resources/accessTokens/sdk` con `{ userId, levelName, ttlInSecs }`.
- **Webhook `POST /v1/webhooks/sumsub`:**
  - Verifica `X-Payload-Digest` según `X-Payload-Digest-Alg` (`HMAC_SHA256_HEX`, `HMAC_SHA512_HEX` o `HMAC_SHA1_HEX`).
  - El HMAC se calcula sobre el **cuerpo crudo** y se compara con `timingSafeEqual`.
  - Mapeo de resultados:

    | Evento | Estado KYC |
    |---|---|
    | `GREEN` | `approved` |
    | `RED` + `FINAL` | `rejected` |
    | `RED` + `RETRY` | `retry` |

  - Un evento `pending` que llega tarde no degrada un KYC ya aprobado.

### Sartblock (AML): `adapters/sartblock/provider.ts`
- **Live:** adaptador HTTP genérico.
  - Envía `POST {fullName, documentType, documentNumber, country}` con la API key.
  - Devuelve `clear | hit | review` + `referenceId`.
  - La especificación real de la API se desconoce, así que el código está marcado con `TODO(sartblock)`.
- **Mock:** si el nombre contiene `BLOQUEADO` devuelve `hit`; si contiene `REVISION`, `review`; en otro caso, `clear`.

### Liquidez BRL: `adapters/brl/provider.ts`
- Puerto `getRate(COP→BRL)` / `executeConversion`.
- **Mock:** tasa media de aproximadamente 0,00132 BRL/COP, con historial sintético de 30 días.
- **Live:** stub. El socio BRL/PIX aún está por definir.

### OTP: `adapters/otp/sender.ts`
- **Mock:** el código fijo es `123456` fuera de producción.
- **Producción:** hay que conectar un proveedor SMS/WhatsApp.

---

## 5. Seguridad

### Llaves de dispositivo
- En el registro, el iPhone envía su llave pública P-256 del Secure Enclave:
  - formato X9.63 sin comprimir (65 bytes), en base64;
  - se convierte a `KeyObject` mediante JWK `x`/`y`.

### Login por reto
1. `POST /auth/challenge` devuelve un nonce de un solo uso.
2. El dispositivo lo firma (ECDSA DER, base64) tras pasar Face ID.
3. `POST /auth/login` devuelve el access token (JWT con `did`) y el refresh token.

### Requests sensibles 🔐
- Llevan los headers de firma del contrato y se firma la cadena canónica definida en `API_CONTRACT.md` §1.
- El middleware (`services/signature.ts`) valida en este orden:
  1. Los headers están presentes; si no, `SIGNATURE_REQUIRED`.
  2. El `deviceId` coincide con el claim `did` del JWT.
  3. El nonce es un UUID v4.
  4. El desfase de reloj es ≤ 120 s.
  5. La firma ECDSA es válida.
  6. Se registra el nonce, lo que da protección anti-replay (`REPLAYED_NONCE`). Se hace después de verificar la firma para que un atacante no pueda "quemar" nonces ajenos.

### Tokens y sesiones
- El refresh token **rota** en cada uso.
- Reutilizar un refresh token ya usado revoca toda la familia.
- `logout` revoca la familia. El access token expira solo, en 15 minutos.
- Revocar un dispositivo invalida sus sesiones.

### Protecciones HTTP y logs
- Rate limit en `/auth/*`.
- Headers de seguridad con `@fastify/helmet`.
- CORS desactivado por defecto.
- Logs pino con redacción de tokens, firmas, OTP, llaves y datos personales.

---

## 6. Dinero, ledger y límites

### Dinero
- Todos los montos son **enteros en unidades menores** (`BigInt` internamente). Nunca se usan floats.

### Ledger
- Es de **doble partida**: cada movimiento genera asientos balanceados.
  - Envío: hold → débito al confirmarse, o liberación si falla.
  - Conversión: COP → cuenta puente de FX → BRL.
  - Depósito: entrada desde la cuenta de liquidez de Coinsenda.
- El saldo disponible es igual al saldo contable menos los holds.

### Idempotencia
- Aplica a envíos y conversiones mediante el header `Idempotency-Key`.
  - Misma llave + mismo cuerpo → mismo resultado.
  - Cuerpo distinto → `IDEMPOTENCY_CONFLICT`.
- Los errores de negocio 4xx liberan la llave para que el cliente pueda reintentar.

### FX
- Tasas escaladas por 1e10.
- `tasa cliente = mid × (10000 − spread) / 10000`
- `fee = max(mínimo, monto × bps)`
- `toAmountMinor = floor((from − fee) × tasa)`
- Las cotizaciones duran 30 s y son de un solo uso.

### Límites
- Diarios, mensuales y anuales.
- Los períodos son calendario en **America/Bogota**.
- Se miden en equivalente COP, por tier y por tipo (`transfer_out`, `conversion`, `deposit_in`).
- Son configurables con `LIMITS_CONFIG_JSON`.
- Un depósito que excede `deposit_in` no se puede rechazar: se acredita y se marca `flagged` para cumplimiento.

### Depósitos
- El poller lista los depósitos de Coinsenda y los asocia al usuario por su llave Bre-B.
- Deduplica por el id del proveedor.
- Los depósitos sin llave conocida quedan registrados para conciliación manual.

---

## 7. Pruebas

`npm test` ejecuta vitest con reloj falso (`FakeClock`) y adaptadores mock:

| Archivo | Cobertura |
|---|---|
| `security.test.ts` | Firma P-256 (llaves generadas con `node:crypto`, X9.63, DER), replay, desfase de reloj, device mismatch, refresh rotation/reuse |
| `happy-path.test.ts` | register → login → webhook KYC → llave Bre-B → depósito → resolve → AML → envío → conversión → feed |
| `limits.test.ts` | Límites diario, mensual y anual excedidos (con reloj falso y zona Bogotá) |
| `aml.test.ts` | Hit → `AML_REJECTED`, review → `pending_review`, envío bloqueado |
| `fx-idempotency.test.ts` | Cotización expirada o usada, idempotencia y conflicto |
| `sumsub.test.ts` | Digest del webhook (SHA1/256/512), firma de requests, mapeo de estados |
| `money.test.ts` | Aritmética entera de FX y dinero |
| `seed.test.ts` | Datos demo consistentes |
| `coinsenda-live.test.ts` | Auth RS256, re-auth en 401, `withdrawaccount_23` → no encontrado |
| `admin-auth.test.ts` | Vectores RFC 6238, scrypt, login + TOTP, anti-replay, bloqueo, logout, usuarios admin (solo owner, último owner), Cloudflare Access |
| `admin-ops.test.ts` | RBAC (403), PII enmascarada, `reason` obligatorio + audit log, congelar bloquea envíos/cotizaciones y retiene depósitos, overrides y límites runtime, FX runtime en cotizaciones, conciliación (ok/breaks, seed), reverso, CSV, alertas + UIAF, SSE con token de un solo uso, ruta legacy `X-Admin-Key` |

---

## 8. Mock vs Live

| Integración | Mock (por defecto) | Live |
|---|---|---|
| Coinsenda | Directorio en memoria, retiros aceptados | `@coinsenda/sdk` 1.9.0 (con `TODO(coinsenda)` en los payloads) |
| Sumsub | Token falso + `/dev/kyc/approve` | API real + webhook firmado |
| Sartblock | Reglas por nombre | HTTP genérico (falta la especificación) |
| BRL | Tasa sintética | Stub (falta definir el socio) |
| OTP | `123456` | Pendiente de proveedor |
| Persistencia | En memoria | `db/schema.sql` (falta implementar los repos de PostgreSQL) |

---

## 9. TODOs para producción

- [ ] **PostgreSQL:** implementar los repositorios sobre `db/schema.sql`.
  - Transacciones `SERIALIZABLE` o `SELECT … FOR UPDATE` en el ledger.
  - Nonces y llaves de idempotencia con índices únicos y TTL.
- [ ] **KMS/HSM:** custodia de `JWT_SECRET` (o migrar a ES256 con llave en KMS), de la llave RSA de Coinsenda y de los secretos de Sumsub y Sartblock. No usar `.env` en producción.
- [ ] **Cifrado de PII en reposo:** documentos y nombres, con cifrado a nivel de columna o envelope encryption.
- [ ] **SARLAFT / UIAF:**
  - reportes de operaciones sospechosas (ROS) y de transacciones en efectivo;
  - cola de revisión de cumplimiento (hoy es una ruta admin mínima);
  - re-screening periódico de beneficiarios;
  - retención de registros.
- [ ] **Monitoreo y alertas:** métricas (latencia, errores de proveedores, depósitos sin conciliar, holds viejos), trazas OpenTelemetry y alertas por diferencias del ledger.
- [ ] **Poller:** lock distribuido o líder único, y webhooks de Coinsenda si están disponibles.
- [ ] **OTP real:** SMS/WhatsApp con antifraude.
- [ ] **Re-enrolamiento:** exigir liveness de Sumsub al enlazar un nuevo dispositivo a un teléfono existente.
- [ ] **Socio BRL/PIX:** adaptador live de `BrlLiquidityProvider` y retiros PIX.
- [ ] **Confirmar con Coinsenda** los nombres exactos de campos y estados (ver `TODO(coinsenda)`).
- [ ] **Confirmar con Sartblock** la especificación de su API (ver `TODO(sartblock)`).
