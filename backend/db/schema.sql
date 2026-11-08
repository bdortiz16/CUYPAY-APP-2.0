-- ═══════════════════════════════════════════════════════════════════════════
-- CuyPay — esquema PostgreSQL de producción (fase 2).
-- Fase 1 usa repositorios en memoria con las mismas entidades (src/repositories).
-- Convenciones:
--   * Montos en unidades menores BIGINT (centavos). Nunca NUMERIC/float para saldos.
--   * Tasas FX como BIGINT escalado por 1e10 (rate_scaled).
--   * Todas las fechas TIMESTAMPTZ (UTC). Los periodos de límites se calculan en America/Bogota.
--   * IDs TEXT con prefijo (usr_, dev_, txn_, ...), ordenables por tiempo.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE currency_code    AS ENUM ('COP', 'BRL');
CREATE TYPE kyc_status       AS ENUM ('not_started', 'pending', 'approved', 'rejected', 'retry');
CREATE TYPE user_tier        AS ENUM ('basic', 'full');
CREATE TYPE breb_key_status  AS ENUM ('active', 'blocked', 'pending');
CREATE TYPE aml_result       AS ENUM ('clear', 'hit', 'review');
CREATE TYPE beneficiary_status AS ENUM ('active', 'pending_review', 'rejected');
CREATE TYPE txn_type         AS ENUM ('deposit', 'transfer', 'conversion');
CREATE TYPE txn_direction    AS ENUM ('in', 'out');
CREATE TYPE txn_status       AS ENUM ('pending', 'completed', 'failed', 'reversed');
CREATE TYPE limit_operation  AS ENUM ('transfer_out', 'conversion', 'deposit_in');
CREATE TYPE ledger_account_kind AS ENUM ('user_available', 'user_held', 'breb_settlement', 'fx_clearing', 'fee_revenue', 'seed_equity');

-- ── Usuarios y dispositivos ────────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,              -- E.164
  email         CITEXT NOT NULL UNIQUE,            -- requiere extensión citext
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  country       CHAR(2) NOT NULL DEFAULT 'CO',
  kyc_status    kyc_status NOT NULL DEFAULT 'not_started',
  tier          user_tier NOT NULL DEFAULT 'basic',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  public_key    TEXT NOT NULL,                     -- base64 X9.63 (65 bytes) P-256 del Secure Enclave
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX devices_user_idx ON devices(user_id) WHERE revoked_at IS NULL;

CREATE TABLE otps (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL,
  code_hash     TEXT NOT NULL,                     -- HMAC, nunca el código en claro
  attempts      INT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE challenges (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(id),
  nonce         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ                        -- consumo atómico: UPDATE ... WHERE consumed_at IS NULL RETURNING
);

CREATE TABLE refresh_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,              -- sha256 del token opaco
  family_id     TEXT NOT NULL,                     -- rotación: reuso ⇒ revocar familia
  user_id       TEXT NOT NULL REFERENCES users(id),
  device_id     TEXT NOT NULL REFERENCES devices(id),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

-- Anti-replay de peticiones firmadas (TTL ≈ 2 × skew). Alternativa: Redis SET NX EX.
CREATE TABLE request_nonces (
  device_id     TEXT NOT NULL,
  nonce         UUID NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX request_nonces_exp_idx ON request_nonces(expires_at);

-- ── KYC ────────────────────────────────────────────────────────────────────
CREATE TABLE kyc_applicants (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  provider       TEXT NOT NULL DEFAULT 'sumsub',
  applicant_id   TEXT UNIQUE,
  level_name     TEXT NOT NULL,
  status         kyc_status NOT NULL,
  review_answer  TEXT,
  reject_type    TEXT,
  reject_labels  TEXT[] NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kyc_webhook_events (               -- auditoría e idempotencia de webhooks
  id             BIGSERIAL PRIMARY KEY,
  payload_digest TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  applicant_id   TEXT,
  external_user_id TEXT,
  payload        JSONB NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Bre-B ──────────────────────────────────────────────────────────────────
CREATE TABLE breb_keys (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL UNIQUE REFERENCES users(id),   -- una llave por usuario (fase 1)
  alias           TEXT NOT NULL UNIQUE,
  status          breb_key_status NOT NULL,
  holder_name     TEXT NOT NULL,
  provider_key_id TEXT NOT NULL UNIQUE,                        -- deposit_provider_id en Coinsenda
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE breb_resolutions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  alias            TEXT NOT NULL,
  holder_first_name TEXT NOT NULL,
  holder_last_name TEXT NOT NULL,
  document_type    TEXT NOT NULL,
  document_number  TEXT NOT NULL,                              -- PII: cifrar a nivel de columna (pgcrypto/KMS)
  bank_name        TEXT NOT NULL,
  raw              JSONB,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Beneficiarios y AML ────────────────────────────────────────────────────
CREATE TABLE aml_checks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  subject_type  TEXT NOT NULL,                     -- 'beneficiary'
  subject_id    TEXT NOT NULL,
  provider      TEXT NOT NULL DEFAULT 'sartblock',
  result        aml_result NOT NULL,
  reference_id  TEXT NOT NULL,
  raw           JSONB,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   TEXT,                              -- oficial de cumplimiento
  reviewed_at   TIMESTAMPTZ,
  review_decision TEXT
);
CREATE INDEX aml_checks_subject_idx ON aml_checks(subject_type, subject_id);

CREATE TABLE beneficiaries (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  alias            TEXT NOT NULL,
  holder_name      TEXT NOT NULL,
  document_type    TEXT NOT NULL,
  document_number  TEXT NOT NULL,                  -- PII cifrada
  nickname         TEXT,
  bank_name        TEXT NOT NULL,
  status           beneficiary_status NOT NULL,
  aml_check_id     TEXT NOT NULL REFERENCES aml_checks(id),
  provider_withdraw_account_id TEXT,               -- withdraw_account_id en Coinsenda
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX beneficiaries_user_alias_live_idx
  ON beneficiaries(user_id, alias) WHERE deleted_at IS NULL AND status <> 'rejected';

-- ── Libro mayor de partida doble ───────────────────────────────────────────
CREATE TABLE ledger_accounts (
  id          TEXT PRIMARY KEY,
  kind        ledger_account_kind NOT NULL,
  user_id     TEXT REFERENCES users(id),           -- NULL para cuentas del sistema
  currency    currency_code NOT NULL,
  balance_minor BIGINT NOT NULL DEFAULT 0,          -- caché materializada, actualizada en la misma tx que las entradas
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (kind, user_id, currency),
  CHECK ((kind IN ('user_available','user_held')) = (user_id IS NOT NULL)),
  CHECK (kind NOT IN ('user_available','user_held') OR balance_minor >= 0)   -- nunca saldo negativo de usuario
);

CREATE TABLE ledger_entries (
  id             TEXT PRIMARY KEY,
  journal_id     TEXT NOT NULL,
  account_id     TEXT NOT NULL REFERENCES ledger_accounts(id),
  currency       currency_code NOT NULL,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor <> 0),   -- con signo; Σ por (journal, currency) = 0
  transaction_id TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id, created_at);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries(journal_id);
-- Invariante de balance: trigger DEFERRABLE INITIALLY DEFERRED que verifica
--   SELECT journal_id, currency FROM ledger_entries WHERE journal_id = NEW.journal_id
--   GROUP BY 1,2 HAVING sum(amount_minor) <> 0  → RAISE EXCEPTION.
-- Las entradas son append-only (REVOKE UPDATE, DELETE).

-- ── Transacciones (feed) ───────────────────────────────────────────────────
CREATE TABLE transactions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  type             txn_type NOT NULL,
  direction        txn_direction NOT NULL,
  currency         currency_code NOT NULL,         -- conversión: moneda de origen
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  fee_minor        BIGINT NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  status           txn_status NOT NULL,
  title            TEXT NOT NULL,
  subtitle         TEXT NOT NULL,
  description      TEXT,
  conv_from_currency currency_code,
  conv_from_amount_minor BIGINT,
  conv_to_currency currency_code,
  conv_to_amount_minor BIGINT,
  conv_rate_scaled BIGINT,
  beneficiary_id   TEXT REFERENCES beneficiaries(id),
  quote_id         TEXT,
  provider_ref     TEXT,                            -- id de depósito/retiro Coinsenda o ref. socio BRL
  flagged          BOOLEAN NOT NULL DEFAULT false,  -- alerta de cumplimiento
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_feed_idx ON transactions(user_id, created_at DESC, id DESC);
CREATE INDEX transactions_pending_idx ON transactions(status) WHERE status = 'pending';
CREATE UNIQUE INDEX transactions_deposit_ref_idx ON transactions(provider_ref) WHERE type = 'deposit';

-- Dedupe de depósitos del proveedor (incluye los no conciliados).
CREATE TABLE processed_deposits (
  provider_deposit_id TEXT PRIMARY KEY,
  user_id        TEXT REFERENCES users(id),
  transaction_id TEXT REFERENCES transactions(id),
  note           TEXT,                              -- p. ej. 'unmatched_breb_key'
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── FX ─────────────────────────────────────────────────────────────────────
CREATE TABLE quotes (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  from_currency     currency_code NOT NULL,
  to_currency       currency_code NOT NULL,
  from_amount_minor BIGINT NOT NULL,
  fee_minor         BIGINT NOT NULL,
  to_amount_minor   BIGINT NOT NULL,
  rate_scaled       BIGINT NOT NULL,               -- después del spread, ×1e10
  mid_rate_scaled   BIGINT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Idempotencia ───────────────────────────────────────────────────────────
CREATE TABLE idempotency_keys (
  user_id         TEXT NOT NULL REFERENCES users(id),
  scope           TEXT NOT NULL,                   -- 'transfer' | 'conversion'
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL,                   -- 'in_progress' | 'completed'
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key)
);

-- ── Límites ────────────────────────────────────────────────────────────────
CREATE TABLE limit_usage (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  operation      limit_operation NOT NULL,
  amount_minor   BIGINT NOT NULL,                  -- COP equivalente
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  occurred_at    TIMESTAMPTZ NOT NULL,
  voided_at      TIMESTAMPTZ                       -- transacción fallida/revertida
);
CREATE INDEX limit_usage_sum_idx ON limit_usage(user_id, operation, occurred_at) WHERE voided_at IS NULL;

-- Límites configurables por tier (alternativa a LIMITS_CONFIG_JSON).
CREATE TABLE limit_rules (
  tier        user_tier NOT NULL,
  operation   limit_operation NOT NULL,
  period      TEXT NOT NULL CHECK (period IN ('daily','monthly','annual')),
  limit_minor BIGINT NOT NULL CHECK (limit_minor >= 0),
  PRIMARY KEY (tier, operation, period)
);

-- ── Portal admin (/v1/admin/*) ─────────────────────────────────────────────
-- Espejo de src/domain/admin.ts (repos en memoria en src/repositories/memory.ts).
CREATE TYPE admin_role AS ENUM ('owner','compliance','treasury','support','viewer');

CREATE TABLE admin_users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,           -- en minúsculas
  name               TEXT NOT NULL,
  role               admin_role NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','disabled')),
  password_hash      TEXT NOT NULL,                  -- scrypt$N$r$p$salt$hash
  totp_secret        TEXT NOT NULL,                  -- base32; cifrar en reposo (KMS) en producción
  last_totp_step     BIGINT,                         -- anti-replay del código TOTP
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id          TEXT PRIMARY KEY,                      -- claim `sid` del JWT admin
  admin_id    TEXT NOT NULL REFERENCES admin_users(id),
  ip          TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions(admin_id) WHERE revoked_at IS NULL;

-- Auditoría de toda mutación admin. Append-only: REVOKE UPDATE, DELETE al rol de la app.
CREATE TABLE admin_audit_log (
  id           TEXT PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id     TEXT NOT NULL REFERENCES admin_users(id),
  actor_email  TEXT NOT NULL,
  actor_role   admin_role NOT NULL,
  action       TEXT NOT NULL,                        -- p. ej. 'customer.freeze'
  target_type  TEXT NOT NULL,
  target_id    TEXT,
  reason       TEXT,                                 -- obligatorio en mutaciones (validado en la API)
  before       JSONB,
  after        JSONB,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX admin_audit_target_idx ON admin_audit_log(target_type, target_id, at DESC);
CREATE INDEX admin_audit_actor_idx ON admin_audit_log(actor_id, at DESC);
-- REVOKE UPDATE, DELETE ON admin_audit_log FROM cuypay_app;

CREATE TABLE compliance_alerts (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('deposit_over_limit','aml_hit','velocity','large_transaction','multiple_devices','structuring')),
  severity         TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  customer_id      TEXT NOT NULL REFERENCES users(id),
  transaction_id   TEXT REFERENCES transactions(id),
  description      TEXT NOT NULL,
  uiaf_suggested   BOOLEAN NOT NULL DEFAULT false,   -- sugerencia de ROS a la UIAF
  status           TEXT NOT NULL CHECK (status IN ('open','resolved')),
  resolution       TEXT CHECK (resolution IN ('false_positive','customer_contacted','frozen','reported')),
  resolution_note  TEXT,
  report_to_uiaf   BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      TEXT REFERENCES admin_users(id)
);
CREATE INDEX compliance_alerts_status_idx ON compliance_alerts(status, created_at DESC);
CREATE INDEX compliance_alerts_customer_idx ON compliance_alerts(customer_id, type, created_at DESC);

CREATE TABLE customer_notes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  author_id     TEXT NOT NULL REFERENCES admin_users(id),
  author_email  TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_notes_user_idx ON customer_notes(user_id, created_at DESC);

-- Controles operativos por cliente (congelamiento y overrides de límites, respetados por LimitsService).
CREATE TABLE customer_controls (
  user_id               TEXT PRIMARY KEY REFERENCES users(id),
  status                TEXT NOT NULL CHECK (status IN ('active','frozen')),
  frozen_at             TIMESTAMPTZ,
  frozen_reason         TEXT,
  limit_overrides       JSONB NOT NULL DEFAULT '[]',   -- [{operation, period, limitMinor}]
  held_deposit_txn_ids  TEXT[] NOT NULL DEFAULT '{}',  -- depósitos retenidos mientras estuvo congelado
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_runs (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('running','ok','breaks','error')),
  breaks        JSONB NOT NULL DEFAULT '[]',          -- [{kind, reference, amountMinor, currency, detail}]
  triggered_by  TEXT NOT NULL,                        -- admin id o 'system'
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs(started_at DESC);

-- Configuración editable en runtime (fx.COP/BRL, limits.config, ...).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT                                    -- email del admin
);
